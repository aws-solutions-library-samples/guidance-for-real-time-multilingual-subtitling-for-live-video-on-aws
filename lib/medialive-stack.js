const cdk = require('aws-cdk-lib');
const { Stack } = require('aws-cdk-lib');
const iam = require('aws-cdk-lib/aws-iam');
const MediaLive = require('aws-cdk-lib/aws-medialive');
const MediaConnect = require('aws-cdk-lib/aws-mediaconnect');
const ssm = require('aws-cdk-lib/aws-ssm');
const fs = require('fs');
const path = require('path');

class MediaLiveStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // 20 pre-defined language slots (Option C: pre-slot approach)
    const captionSlots = [
      { code: 'en', name: 'English' },    // segment_id: 2 (active)
      { code: 'de', name: 'German' },     // segment_id: 3 (active)
      { code: 'es', name: 'Spanish' },    // segment_id: 4 (active)
      { code: 'it', name: 'Italian' },    // segment_id: 5 (active)
      { code: 'ko', name: 'Korean' },     // segment_id: 6
      { code: 'hi', name: 'Hindi' },      // segment_id: 7
      { code: 'ja', name: 'Japanese' },   // segment_id: 8
      { code: 'fr', name: 'French' },     // segment_id: 9
      { code: 'pt', name: 'Portuguese' }, // segment_id: 10
      { code: 'zh', name: 'Chinese' },    // segment_id: 11
      { code: 'ar', name: 'Arabic' },     // segment_id: 12
      { code: 'th', name: 'Thai' },       // segment_id: 13
      { code: 'vi', name: 'Vietnamese' }, // segment_id: 14
      { code: 'ru', name: 'Russian' },    // segment_id: 15
      { code: 'pl', name: 'Polish' },     // segment_id: 16
      { code: 'nl', name: 'Dutch' },      // segment_id: 17
      { code: 'sv', name: 'Swedish' },    // segment_id: 18
      { code: 'tr', name: 'Turkish' },    // segment_id: 19
      { code: 'id', name: 'Indonesian' }, // segment_id: 20
      { code: 'ms', name: 'Malay' },      // segment_id: 21
    ];

    // Import values from BaseLiveStreamingStack
    const mediaPackageChannelId = cdk.Fn.importValue('MediaPackageChannelId');
    const cloudFrontDomainName = cdk.Fn.importValue('HLSCFDomainName');
    const mediaPackageDomain = cdk.Fn.importValue('MediaPackageDomain');
    const hlsEndpointUrl = cdk.Fn.importValue('HLSEndpointURL');
    const hlsEndpointId = cdk.Fn.importValue('MediaPackageIngestEndpointId');
    const ec2PublicIp = cdk.Fn.importValue('EC2PublicIP');

    const mediaLiveRole = new iam.Role(this, 'MediaLiveRole', {
      assumedBy: new iam.ServicePrincipal('medialive.amazonaws.com'),
    });

    mediaLiveRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AWSElementalMediaLiveFullAccess')
    );

    const mediaConnectPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'mediapackage:DescribeChannel',
        'mediapackage:ListChannels',
        'mediaconnect:*',
        'cloudfront:*'
      ],
      resources: ['*']
    });
    
 
    mediaLiveRole.addToPolicy(mediaConnectPolicy);

    const ssmPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:DescribeParameters',
        'ssm:GetParameters',
        'ssm:GetParameter',
        'ssm:GetParameterHistory'
      ],
      resources: ['*']
    });
    
    mediaLiveRole.addToPolicy(ssmPolicy);

    const inputSecurityGroup = new MediaLive.CfnInputSecurityGroup(this, 'InputSecurityGroup', {
      whitelistRules: [{
        cidr: '0.0.0.0/0'
      }]
    });

    const mediaLiveInput = new MediaLive.CfnInput(this, 'MediaLiveInput', {
      name: 'rtp-push-input',
      type: 'RTP_PUSH',
      inputSecurityGroups: [inputSecurityGroup.ref]
    });

    const mediaConnectFlow = new MediaConnect.CfnFlow(this, 'MediaConnectFlow', {
      name: 'f1-srt-flow',
      source: {
        name: 'srt-source',
        description: 'SRT source for F1 video stream',
        whitelistCidr: '0.0.0.0/0', // Allow from anywhere - adjust as needed
        ingestPort: 3088,
        protocol: 'srt-listener',
      },
      availabilityZone: props?.availabilityZone || `${this.region}a`
    });

    // Create MediaConnect output for audio to ec2
    const audioOutput = new MediaConnect.CfnFlowOutput(this, 'AudioOutputToEC2', {
      flowArn: mediaConnectFlow.attrFlowArn,
      name: 'audio-to-ec2',
      description: 'SRT audio output to EC2 for Transcribe Streaming',
      protocol: 'rtp',
      destination: ec2PublicIp,
      port: 5000
    });

    // MediaLive Input destination IP 
    const mediaLiveInputDestination = cdk.Fn.select(0, cdk.Fn.split(':', 
      cdk.Fn.select(1, cdk.Fn.split('//', 
        cdk.Fn.select(0, mediaLiveInput.attrDestinations)
      ))
    ));

    const videoOutputToMediaLive = new MediaConnect.CfnFlowOutput(this, 'VideoOutputToMediaLive', {
      flowArn: mediaConnectFlow.attrFlowArn,
      name: 'video-to-medialive',
      description: 'RTP output to MediaLive for encoding',
      protocol: 'rtp',
      destination: mediaLiveInputDestination,
      port: 5000,
      smoothingLatency: 25000
    });

    const mediaLiveChannel = new cdk.CfnResource(this, 'MediaLiveChannel', {
      type: 'AWS::MediaLive::Channel',
      properties: {
        ChannelClass: "SINGLE_PIPELINE",
        Name: "HTTP live streaming",
        RoleArn: mediaLiveRole.roleArn,
        Destinations: [{
          Id: 'destination1',
          Settings: [{
            Url: `https://${hlsEndpointUrl}/in/v2/${hlsEndpointId}/${hlsEndpointId}/channel`
          }]
        }],
        EncoderSettings: {
          AudioDescriptions: [{
            Name: "audio_1",
            AudioSelectorName: "Default",
            CodecSettings: {
              AacSettings: {
                Bitrate: 192000,
                CodingMode: "CODING_MODE_2_0",
                SampleRate: 48000
              }
            }
          }],
          CaptionDescriptions: captionSlots.map(slot => ({
            Name: `caption_${slot.code}`,
            CaptionSelectorName: "empty",
            Accessibility: "DOES_NOT_IMPLEMENT_ACCESSIBILITY_FEATURES",
            DestinationSettings: {
              WebvttDestinationSettings: {
                StyleControl: "NO_STYLE_DATA"
              }
            },
            LanguageCode: slot.code,
            LanguageDescription: slot.name
          })),
          GlobalConfiguration: {
            InputEndAction: "NONE",
            OutputLockingMode: "PIPELINE_LOCKING",
            OutputTimingSource: "INPUT_CLOCK",
            SupportLowFramerateInputs: "DISABLED"
          },
          AvailConfiguration: {
            AvailSettings: {
              Scte35SpliceInsert: {
                AdAvailOffset: 0,
                NoRegionalBlackoutFlag: "FOLLOW",
                WebDeliveryAllowedFlag: "FOLLOW"
              }
            }
          },
          TimecodeConfig: {
            Source: "SYSTEMCLOCK"
          },
          OutputGroups: [{
            Name: "Live",
            OutputGroupSettings: {
              HlsGroupSettings: {
                Destination: {
                  DestinationRefId: "destination1"
                },
                AdMarkers: ['ELEMENTAL', 'ELEMENTAL_SCTE35'],
                SegmentLength: 2,
                HlsCdnSettings: {
                  HlsBasicPutSettings: {
                    ConnectionRetryInterval: 1,
                    FilecacheDuration: 300,
                    NumRetries: 10,
                    RestartDelay: 15
                  }
                }
              }
            },
            Outputs: [
              {
                AudioDescriptionNames: ["audio_1"],
                VideoDescriptionName: "video_1080p",
                OutputSettings: {
                  HlsOutputSettings: {
                    NameModifier: "_1080p",
                    HlsSettings: {
                      StandardHlsSettings: {
                        M3u8Settings: {
                          ProgramNum: 1
                        }
                      }
                    }
                  }
                }
              },
              ...captionSlots.map(slot => ({
                OutputName: slot.code,
                CaptionDescriptionNames: [`caption_${slot.code}`],
                OutputSettings: {
                  HlsOutputSettings: {
                    NameModifier: `_${slot.code}`,
                    H265PackagingType: "HVC1",
                    HlsSettings: {
                      StandardHlsSettings: {
                        AudioRenditionSets: "program_audio",
                        M3u8Settings: {
                          ProgramNum: 1
                        }
                      }
                    }
                  }
                }
              }))
            ]
          }],
          VideoDescriptions: [{
            Name: "video_1080p",
            Height: 1080,
            Width: 1920,
            CodecSettings: {
              H264Settings: {
                Bitrate: 2000000,
                FramerateControl: "SPECIFIED",
                FramerateNumerator: 30,
                FramerateDenominator: 1
              }
            }
          }]
        },
        InputAttachments: [{
          InputAttachmentName: "mediaconnect-input",
          InputId: mediaLiveInput.ref,
          InputSettings: {
            CaptionSelectors: [{
              Name: "empty"
            }]
          }
        }],
        InputSpecification: {
          Codec: "AVC",
          MaximumBitrate: "MAX_20_MBPS",
          Resolution: "HD"
        }
      }
    });

    // Add dependencies
    mediaLiveChannel.node.addDependency(mediaLiveInput);

    // Outputs
    new cdk.CfnOutput(this, 'MediaLiveChannelArn', {
      value: mediaLiveChannel.getAtt('Arn').toString(),
      description: 'MediaLive Channel ARN'
    });

    new cdk.CfnOutput(this, 'MediaLiveChannelId', {
      value: mediaLiveChannel.ref,
      description: 'MediaLive Channel ID'
    });
  }
}

module.exports = { MediaLiveStack };
