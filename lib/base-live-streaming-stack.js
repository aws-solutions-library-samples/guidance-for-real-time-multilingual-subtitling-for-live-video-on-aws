// Base live streaming stack with MediaPackage V1 and MediaLive
const cdk = require('aws-cdk-lib');

const { Stack, Duration } = require('aws-cdk-lib');
const { Construct, DependencyGroup } = require('constructs');

const path = require('path');
const fs = require('fs');

const iam = require('aws-cdk-lib/aws-iam');
const MediaConnect = require('aws-cdk-lib/aws-mediaconnect');
const MediaPackage = require('aws-cdk-lib/aws-mediapackage');
const MediaPackagev2 = require('aws-cdk-lib/aws-mediapackagev2');
const MediaLive = require('aws-cdk-lib/aws-medialive');
const cloudfront = require('aws-cdk-lib/aws-cloudfront');
const origins = require('aws-cdk-lib/aws-cloudfront-origins');
const lambda = require('aws-cdk-lib/aws-lambda');
const ssm = require('aws-cdk-lib/aws-ssm');

const STACK_PREFIX_NAME = "live-streaming"

class BaseLiveStreamingStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const configPath = path.join(__dirname, '../config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    const mediaLiveConfig = {
      inputType: "RTMP_PUSH",
      channelClass: "SINGLE",
      inputCidr: "0.0.0.0/0",
      streamName: `${id}-stream`,
      codec: "AVC",
      encodingProfile: "HD-720p",
      segmentLengthInSeconds: 2,
      maximumBitrate: "MAX_10_MBPS",
      resolution: "HD"
    };


    // Create MediaConnect flow for signal acquisition
    const mediaConnectFlow = new MediaConnect.CfnFlow(this, 'MediaConnectFlow', {
      name: 'single-pipeline-flow',
      source: {
        name: 'primary-source',
        description: 'Primary source for single pipeline',
        whitelistCidr: '82.20.250.0/24',
        ingestPort: 30125,
        protocol: 'srt-listener',
        maxBitrate: 20000000,
      },
      availabilityZone: props?.availabilityZone || 'us-east-1a'
    });

    // Create MediaPackage Channel (v1)
    const mediaPackageChannel = new MediaPackage.CfnChannel(this, "MediaPackageChannel", {
      id: `${STACK_PREFIX_NAME}-channel`,
      description: "MediaPackage channel for live streaming"
    });

    // Create MediaPackage Channel Endpoint (HLS)
    const hlsEndpoint = new MediaPackage.CfnOriginEndpoint(this, 'HLSEndpoint', {
      channelId: mediaPackageChannel.ref,
      id: `${STACK_PREFIX_NAME}-hls-output`,
      hlsPackage: {
        segmentDurationSeconds: 2,
        playlistWindowSeconds: 300,
        includeIframeOnlyStream: false,
        playlistType: 'EVENT',
        programDateTimeIntervalSeconds: 1,
        adMarkers: 'NONE'
      }
    });

    hlsEndpoint.node.addDependency(mediaPackageChannel);







    // Create Lambda@Edge function for WebVTT augmentation
    const webVTTAugmenterFunction = new lambda.Function(this, 'WebVTTAugmenter', {
      description: 'Augment our MediaLive output with WebVTT',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lib/lambdas/webvtt-augmenter/'),
      role: new iam.Role(this, 'WebVTTFunctionRole', {
        assumedBy: new iam.CompositePrincipal(
          new iam.ServicePrincipal('lambda.amazonaws.com'),
          new iam.ServicePrincipal('edgelambda.amazonaws.com')
        ),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
        ]
      }),
      memorySize: 128,
      timeout: Duration.seconds(5),
    });

    // Create CloudFront distribution for HLS output
    const MPDomain = cdk.Fn.select(2, cdk.Fn.split('/', hlsEndpoint.attrUrl))

    const mlDistribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(MPDomain, {
          customHeaders: {},
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: new cloudfront.CachePolicy(this, 'CachePolicy', {
          defaultTtl: Duration.seconds(30),
          minTtl: Duration.seconds(0),
          maxTtl: Duration.seconds(86400),
          enableAcceptEncodingGzip: true,
          enableAcceptEncodingBrotli: true,
          headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
            'Access-Control-Request-Headers',
            'Access-Control-Request-Method',
            'Origin',
            'User-Agent'
          ),
          queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
        }),
        originRequestPolicy: new cloudfront.OriginRequestPolicy(this, 'OriginRequestPolicy', {
          headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
            'Access-Control-Request-Headers',
            'Access-Control-Request-Method',
            'Origin'
          ),
          queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
        }),
        responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'ResponseHeadersPolicy', {
          corsBehavior: {
            accessControlAllowCredentials: false,
            accessControlAllowHeaders: ['*'],
            accessControlAllowMethods: ['GET', 'HEAD'],
            accessControlAllowOrigins: ['*'],
            accessControlMaxAge: Duration.seconds(600),
            originOverride: true,
          },
        }),
      },
      enableLogging: true,
      enabled: true,
      httpVersion: cloudfront.HttpVersion.HTTP2,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
    });

    // Create IAM Role for MediaLive
    const mediaLiveRole = new iam.Role(this, 'MediaLiveRole', {
      assumedBy: new iam.ServicePrincipal('medialive.amazonaws.com'),
    });

    mediaLiveRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AWSElementalMediaLiveFullAccess')
    );

    mediaLiveRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'mediapackage:DescribeChannel',
        'mediapackage:ListChannels',
        "mediaconnect:AddFlowSources",
        "mediaconnect:AddFlowOutputs",
        "mediaconnect:DescribeFlow",
        "mediaconnect:RemoveFlowOutput",
        "mediaconnect:RemoveFlowSource",
        "mediaconnect:AddBridgeOutputs"
      ],
      resources: ['*']
    }));

    // Create MediaLive Input for CloudFront URL
    const mediaLiveInput = new MediaLive.CfnInput(this, 'MediaLiveInput', {
      name: 'cloudfront-mp4-input',
      type: 'MP4_FILE',
      sources: [{
        url: 'https://dhgd8ucc6ahc0.cloudfront.net/reinvent2024.mp4'
      }]
    });

    // Create MediaLive Channel
    const mediaLiveChannel = new MediaLive.CfnChannel(this, 'MediaLiveChannel', {
      channelClass: 'SINGLE_PIPELINE',
      name: 'HTTP live streaming - clone',
      roleArn: mediaLiveRole.roleArn,
      destinations: [{
        id: 'destination1',
        mediaPackageSettings: [{
          channelId: mediaPackageChannel.ref
        }]
      }],
      encoderSettings: {
        audioDescriptions: [
          {
            audioSelectorName: 'default',
            audioTypeControl: 'FOLLOW_INPUT',
            codecSettings: {
              aacSettings: {
                bitrate: 128000,
                rawFormat: 'NONE',
                spec: 'MPEG4',
                profile: 'LC',
                rateControlMode: 'CBR',
                sampleRate: 48000
              }
            },
            languageCodeControl: 'FOLLOW_INPUT',
            name: 'audio_1_aac128'
          }
        ],
        outputGroups: [{
          name: 'MediaPackageGroup',
          outputGroupSettings: {
            mediaPackageGroupSettings: {
              destination: {
                destinationRefId: "destination1"
              }
            }
          },
          outputs: [
            {
              outputName: 'mediapackage_output_1080p',
              audioDescriptionNames: ['audio_1_aac128'],
              outputSettings: {
                mediaPackageOutputSettings: {}
              },
              videoDescriptionName: 'video_1920_1080'
            },
            {
              outputName: 'mediapackage_output_720p',
              audioDescriptionNames: ['audio_1_aac128'],
              outputSettings: {
                mediaPackageOutputSettings: {}
              },
              videoDescriptionName: 'video_1280_720'
            },
            {
              outputName: 'mediapackage_output_540p',
              audioDescriptionNames: ['audio_1_aac128'],
              outputSettings: {
                mediaPackageOutputSettings: {}
              },
              videoDescriptionName: 'video_960_540'
            }
          ]
        }],
        videoDescriptions: [
          {
            codecSettings: {
              h264Settings: {
                adaptiveQuantization: 'HIGH',
                afdSignaling: 'NONE',
                bitrate: 5000000,
                colorMetadata: 'INSERT',
                entropyEncoding: 'CABAC',
                flickerAq: 'ENABLED',
                forceFieldPictures: 'DISABLED',
                framerateControl: 'SPECIFIED',
                framerateDenominator: 1,
                framerateNumerator: 30,
                gopBReference: 'ENABLED',
                gopClosedCadence: 1,
                gopNumBFrames: 2,
                gopSize: 30,
                gopSizeUnits: 'FRAMES',
                level: 'H264_LEVEL_4_1',
                lookAheadRateControl: 'HIGH',
                numRefFrames: 3,
                parControl: 'SPECIFIED',
                parNumerator: 1,
                parDenominator: 1,
                profile: 'HIGH',
                rateControlMode: 'VBR',
                scanType: 'PROGRESSIVE',
                sceneChangeDetect: 'ENABLED',
                spatialAq: 'ENABLED',
                subgopLength: 'DYNAMIC',
                syntax: 'DEFAULT',
                temporalAq: 'ENABLED',
                timecodeInsertion: 'PIC_TIMING_SEI',
                bufSize: 10000000,
                maxBitrate: 7500000
              }
            },
            height: 1080,
            name: 'video_1920_1080',
            respondToAfd: 'NONE',
            scalingBehavior: 'DEFAULT',
            sharpness: 50,
            width: 1920
          },
          {
            codecSettings: {
              h264Settings: {
                adaptiveQuantization: 'HIGH',
                afdSignaling: 'NONE',
                bitrate: 3000000,
                colorMetadata: 'INSERT',
                entropyEncoding: 'CABAC',
                flickerAq: 'ENABLED',
                forceFieldPictures: 'DISABLED',
                framerateControl: 'SPECIFIED',
                framerateDenominator: 1,
                framerateNumerator: 30,
                gopBReference: 'ENABLED',
                gopClosedCadence: 1,
                gopNumBFrames: 2,
                gopSize: 30,
                gopSizeUnits: 'FRAMES',
                level: 'H264_LEVEL_4',
                lookAheadRateControl: 'HIGH',
                numRefFrames: 3,
                parControl: 'SPECIFIED',
                parNumerator: 1,
                parDenominator: 1,
                profile: 'HIGH',
                rateControlMode: 'VBR',
                scanType: 'PROGRESSIVE',
                sceneChangeDetect: 'ENABLED',
                spatialAq: 'ENABLED',
                subgopLength: 'DYNAMIC',
                syntax: 'DEFAULT',
                temporalAq: 'ENABLED',
                timecodeInsertion: 'PIC_TIMING_SEI',
                bufSize: 6000000,
                maxBitrate: 4500000
              }
            },
            height: 720,
            name: 'video_1280_720',
            respondToAfd: 'NONE',
            scalingBehavior: 'DEFAULT',
            sharpness: 50,
            width: 1280
          },
          {
            codecSettings: {
              h264Settings: {
                adaptiveQuantization: 'HIGH',
                afdSignaling: 'NONE',
                bitrate: 1500000,
                colorMetadata: 'INSERT',
                entropyEncoding: 'CABAC',
                flickerAq: 'ENABLED',
                forceFieldPictures: 'DISABLED',
                framerateControl: 'SPECIFIED',
                framerateDenominator: 1,
                framerateNumerator: 30,
                gopBReference: 'ENABLED',
                gopClosedCadence: 1,
                gopNumBFrames: 2,
                gopSize: 30,
                gopSizeUnits: 'FRAMES',
                level: 'H264_LEVEL_3_1',
                lookAheadRateControl: 'HIGH',
                numRefFrames: 3,
                parControl: 'SPECIFIED',
                parNumerator: 1,
                parDenominator: 1,
                profile: 'HIGH',
                rateControlMode: 'VBR',
                scanType: 'PROGRESSIVE',
                sceneChangeDetect: 'ENABLED',
                spatialAq: 'ENABLED',
                subgopLength: 'DYNAMIC',
                syntax: 'DEFAULT',
                temporalAq: 'ENABLED',
                timecodeInsertion: 'PIC_TIMING_SEI',
                bufSize: 3000000,
                maxBitrate: 2250000
              }
            },
            height: 540,
            name: 'video_960_540',
            respondToAfd: 'NONE',
            scalingBehavior: 'DEFAULT',
            sharpness: 50,
            width: 960
          }
        ],
        timecodeConfig: {
          source: 'EMBEDDED',
          syncThreshold: 5000
        },
        globalConfiguration: {
          initialAudioGain: 0,
          inputEndAction: 'NONE',
          inputLossBehavior: {
            blackFrameMsec: 1000,
            inputLossImageColor: '000000',
            inputLossImageType: 'COLOR',
            repeatFrameMsec: 1000
          },
          outputLockingMode: 'EPOCH_LOCKING',
          outputTimingSource: 'INPUT_CLOCK',
          supportLowFramerateInputs: 'DISABLED'
        }
      },
      inputAttachments: [{
        inputAttachmentName: 'cloudfront-mp4-input',
        inputId: mediaLiveInput.ref,
        inputSettings: {
          deblockFilter: 'DISABLED',
          denoiseFilter: 'DISABLED',
          filterStrength: 1,
          inputFilter: 'AUTO',
          smpte2038DataPreference: 'IGNORE',
          sourceEndBehavior: 'LOOP'
        }
      }],
      inputSpecification: {
        codec: 'AVC',
        maximumBitrate: 'MAX_20_MBPS',
        resolution: 'HD'
      },
      maintenance: {
        maintenanceDay: 'FRIDAY',
        maintenanceStartTime: '13:00'
      }
    });




    // Add dependencies
    mediaLiveChannel.node.addDependency(mediaLiveInput);
    mediaLiveChannel.node.addDependency(mediaPackageChannel);
    
    new cdk.CfnOutput(this, 'MediaLiveChannelArn', {
      value: mediaLiveChannel.attrArn,
      exportName: 'MediaLiveChannelArn'
    });

    new cdk.CfnOutput(this, 'MediaLiveChannelId', {
      value: mediaLiveChannel.ref,  
      description: 'MediaLive Channel ID',
      exportName: 'MediaLiveChannelId'  
    });

    new cdk.CfnOutput(this, "CFDomainName", {
      value: mlDistribution.domainName,
      exportName: "CFDomainName"
    })

    new cdk.CfnOutput(this, "MediaPackageChannelId", {
      value: mediaPackageChannel.ref,
      exportName: "MediaPackageChannelId"
    });

    new cdk.CfnOutput(this, "MediaPackageDomain", {
      value: MPDomain,
      exportName: "MediaPackageDomain"
    })

    new cdk.CfnOutput(this, "HLSEndpointURL", {
      value: hlsEndpoint.attrUrl,
      exportName: "HLSEndpointURL"
    });

    // Export values for other stacks
    this.distributionDomainName = mlDistribution.distributionDomainName;
    this.hlsStreamUrl = `https://${mlDistribution.distributionDomainName}/out/v1/b02fbbc1e5344fd98e7f36bda0f08c7e/index.m3u8`;
    this.mediaPackageEndpoint = MPDomain;

  }
}

module.exports = { BaseLiveStreamingStack }
