// Base live streaming stack with MediaPackage V1 and CloudFront
const cdk = require('aws-cdk-lib');

const { Stack, Duration } = require('aws-cdk-lib');

const path = require('path');
const fs = require('fs');

const iam = require('aws-cdk-lib/aws-iam');
const MediaPackage = require('aws-cdk-lib/aws-mediapackage');
const cloudfront = require('aws-cdk-lib/aws-cloudfront');
const origins = require('aws-cdk-lib/aws-cloudfront-origins');
const lambda = require('aws-cdk-lib/aws-lambda');
const apigateway = require('aws-cdk-lib/aws-apigateway');
const ssm = require('aws-cdk-lib/aws-ssm');

const STACK_PREFIX_NAME = "live-streaming"

class BaseLiveStreamingStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const { subtitleTable } = props || {};

    const mediaPackageChannel = new MediaPackage.CfnChannel(this, "MediaPackageChannel", {
      id: `${STACK_PREFIX_NAME}-channel`,
      description: "MediaPackage channel for live streaming"
    });

    // Create MediaPackage Channel Endpoint (HLS)
    const hlsEndpoint = new MediaPackage.CfnOriginEndpoint(this, 'HLSEndpoint', {
      channelId: mediaPackageChannel.ref,
      id: `${STACK_PREFIX_NAME}-hls-output-${this.stackName}`,
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

    // Get MediaPackage domain for WebVTT
    const MPDomain = cdk.Fn.select(2, cdk.Fn.split('/', hlsEndpoint.attrUrl));

    // 1. WebVTT Delivery Lambda
    const webvttDeliveryLambda = new lambda.Function(this, 'WebVTTDeliveryLambda', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lib/lambdas/webvtt-delivery'),
      timeout: Duration.seconds(30),
      environment: {
        DYNAMODB_TABLE_NAME: subtitleTable ? subtitleTable.tableName : 'SubtitleTable',
        MEDIAPACKAGE_DOMAIN: MPDomain,
        LANGUAGE_MAPPING: '2-en,3-ko,4-es,5-de,6-hi'
      }
    });

    // DynamoDB permissions for WebVTT Lambda
    if (subtitleTable) {
      webvttDeliveryLambda.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:Query',
          'dynamodb:GetItem'
        ],
        resources: [
          subtitleTable.tableArn,
          `${subtitleTable.tableArn}/index/*`
        ]
      }));
    }

    // 2. Lambda@Edge Function
    const webvttEdgeLambda = new lambda.Function(this, 'WebVTTEdgeLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lib/lambdas/webvtt-edge'),
      timeout: Duration.seconds(5),
      memorySize: 128
    });

    // 3. API Gateway for WebVTT
    const webvttApi = new apigateway.RestApi(this, 'WebVTTApi', {
      restApiName: 'WebVTT Delivery API',
      description: 'API for delivering WebVTT subtitles',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization']
      }
    });

    // API Gateway proxy resource
    const webvttResource = webvttApi.root.addResource('{proxy+}');
    webvttResource.addMethod('GET', new apigateway.LambdaIntegration(webvttDeliveryLambda));

    // CloudFront distribution for HLS output with Legacy cache settings(Old Version)
    const mlDistribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Playback Distribution with realtime VTT subtitles',
      defaultBehavior: {
        origin: new origins.HttpOrigin(MPDomain, {
          customHeaders: {},
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,

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
      additionalBehaviors: {
        '*.vtt': {
          origin: new origins.HttpOrigin(`${webvttApi.restApiId}.execute-api.${this.region}.amazonaws.com`, {
            originPath: '/prod',
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        }
      },
      enableLogging: true,
      enabled: true,
      httpVersion: cloudfront.HttpVersion.HTTP2,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
    });

    /*
    const webvttDistribution = new cloudfront.Distribution(this, 'WebVTTDistribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(MPDomain, {
          customHeaders: {},
          protocolPolicy: cloudfront.OriginProtocolPolicy.MATCH_VIEWER,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: webvttCachePolicy,
        originRequestPolicy: webvttOriginRequestPolicy,
      },
      additionalBehaviors: {
        '*.vtt': {
          origin: new origins.HttpOrigin(MPDomain, {
            customHeaders: {},
            protocolPolicy: cloudfront.OriginProtocolPolicy.MATCH_VIEWER,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          cachePolicy: webvttCachePolicy,
          originRequestPolicy: webvttOriginRequestPolicy,
          edgeLambdas: [{
            functionVersion: webvttEdgeLambda.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
            includeBody: true,
          }],
        }
      },
      enableLogging: true,
      enabled: true,
      httpVersion: cloudfront.HttpVersion.HTTP2,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
    });
    */

    const webvttDistribution = new cloudfront.CloudFrontWebDistribution(this, 'WebVTTDistribution', {
      comment: 'VTT-Augmentor Distrbution with Lambda Edge',
      originConfigs: [
        {
          customOriginSource: {
            domainName: MPDomain,
            originProtocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          },
          behaviors: [
            {
              isDefaultBehavior: true,
              forwardedValues: {
                queryString: true,
                headers: ['Authorization'],
                cookies: { forward: 'none' },
              },
              defaultTtl: Duration.seconds(86400),
              minTtl: Duration.seconds(0),
              maxTtl: Duration.seconds(31536000),
              viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
              allowedMethods: cloudfront.CloudFrontAllowedMethods.ALL,
              cachedMethods: cloudfront.CloudFrontAllowedCachedMethods.GET_HEAD,
            },
            {
              pathPattern: '*.vtt',
              forwardedValues: {
                queryString: true,
                headers: ['Authorization'],
                cookies: { forward: 'none' },
              },
              defaultTtl: Duration.seconds(86400),
              minTtl: Duration.seconds(0),
              maxTtl: Duration.seconds(31536000),
              viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
              allowedMethods: cloudfront.CloudFrontAllowedMethods.ALL,
              cachedMethods: cloudfront.CloudFrontAllowedCachedMethods.GET_HEAD,
              lambdaFunctionAssociations: [
                {
                  eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
                  lambdaFunction: webvttEdgeLambda.currentVersion,
                  includeBody: true,
                },
              ],
            },
          ],
        },
      ],
      enableLogging: true,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      httpVersion: cloudfront.HttpVersion.HTTP2,
    });

    const mediaConnectPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'mediapackage:DescribeChannel',
        'mediapackage:ListChannels',
        'mediaconnect:*'
      ],
      resources: ['*']
    });
    
    new cdk.CfnOutput(this, "CFDomainName", {
      value: mlDistribution.domainName,
      exportName: "HLSCFDomainName"
    })

    new cdk.CfnOutput(this, "WebVTTCFDomainName", {
      value: webvttDistribution.domainName,
      exportName: "WebVTTCFDomainName"
    });

    new cdk.CfnOutput(this, "MediaPackageChannelId", {
      value: mediaPackageChannel.ref,
      exportName: "MediaPackageChannelId"
    });

    new cdk.CfnOutput(this, "MediaPackageDomain", {
      value: MPDomain,
      exportName: "MediaPackageDomain"
    })

    new cdk.CfnOutput(this, "HLSEndpointURL", {
      value:mlDistribution.distributionDomainName,
      exportName: "HLSEndpointURL"
    })

    new cdk.CfnOutput(this, "MediaPackageIngestEndpointId", {
      value: mediaPackageChannel.ref, 
      exportName: "MediaPackageIngestEndpointId",
      description: "MediaPackage HLS Ingest Endpoint ID"
    });

    new cdk.CfnOutput(this, "WebVTTApiUrl", {
      value: hlsEndpoint.attrUrl,
      exportName: "WebVTTApiUrl"
    });

    new cdk.CfnOutput(this, 'WebVTTDistributionId', {
      value: webvttDistribution.distributionId,
      exportName: 'WebVTTDistributionId'
    });

    // Export values for other stacks
    this.distributionDomainName = mlDistribution.distributionDomainName;
    this.hlsStreamUrl = `https://${mlDistribution.distributionDomainName}/out/v1/b02fbbc1e5344fd98e7f36bda0f08c7e/index.m3u8`;
    this.mediaPackageEndpoint = MPDomain;

  }
}

module.exports = { BaseLiveStreamingStack }
