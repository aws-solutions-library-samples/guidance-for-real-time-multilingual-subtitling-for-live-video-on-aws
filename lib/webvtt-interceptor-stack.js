const cdk = require('aws-cdk-lib');

const { Stack, Duration } = require('aws-cdk-lib');
const { Construct, DependencyGroup } = require('constructs');

const iam = require('aws-cdk-lib/aws-iam');

const cloudfront = require('aws-cdk-lib/aws-cloudfront');
const origins = require('aws-cdk-lib/aws-cloudfront-origins');
const lambda = require('aws-cdk-lib/aws-lambda');
const ssm = require('aws-cdk-lib/aws-ssm');


class WebvttInterceptorStack extends cdk.Stack {
  /**
   *
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    // Moved L@E and CloudFront to Live Streaming stack to easier manage dependencies.


    // Create Lambda@Edge function
    // const webVTTAugmenterFunction = new lambda.Function(this, 'WebVTTAugmenter', {
    //   description: 'Augment our MediaLive output with WebVTT',
    //   runtime: lambda.Runtime.NODEJS_18_X,
    //   handler: 'index.handler',
    //   code: lambda.Code.fromAsset('lib/lambdas/webvtt-augmenter'),
    //   role: new iam.Role(this, 'WebVTTFunctionRole', {
    //     assumedBy: new iam.CompositePrincipal(
    //       new iam.ServicePrincipal('lambda.amazonaws.com'),
    //       new iam.ServicePrincipal('edgelambda.amazonaws.com')
    //     ),
    //     managedPolicies: [
    //       iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    //     ]
    //   }),
    //   // Lambda@Edge functions must be deployed in us-east-1
    //   environment: {
    //     REGION: 'us-east-1'
    //   },
    //   memorySize: 128, // Add memory size
    //   timeout: Duration.seconds(5), // Add timeout
    // });

    // Create CloudFront distribution serving the HLS output from MediaLive, with a Lambda at Edge function on origin request.
    // const mlDistribution = new cloudfront.Distribution(this, 'Distribution', {
    //   defaultBehavior: {
    //     origin: new origins.HttpOrigin(mediaLiveChannel.attrDestinations[0].url, {
    //       customHeaders: {
    //         // Add any required headers for your MediaLive endpoint
    //       },
    //     }),
    //     viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    //     allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
    //     cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
    //     cachePolicy: new cloudfront.CachePolicy(this, 'CachePolicy', {
    //       defaultTtl: Duration.seconds(2),
    //       minTtl: Duration.seconds(1),
    //       maxTtl: Duration.seconds(5),
    //       enableAcceptEncodingGzip: true,
    //       enableAcceptEncodingBrotli: true,
    //       headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
    //         'Access-Control-Request-Headers',
    //         'Access-Control-Request-Method',
    //         'Origin'
    //       ),
    //       queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
    //     }),
    //     originRequestPolicy: new cloudfront.OriginRequestPolicy(this, 'OriginRequestPolicy', {
    //       headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
    //         'Access-Control-Request-Headers',
    //         'Access-Control-Request-Method',
    //         'Origin'
    //       ),
    //       queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
    //     }),
    //     responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'ResponseHeadersPolicy', {
    //       corsBehavior: {
    //         accessControlAllowCredentials: false,
    //         accessControlAllowHeaders: ['*'],
    //         accessControlAllowMethods: ['GET', 'HEAD'],
    //         accessControlAllowOrigins: ['*'],
    //         accessControlMaxAge: Duration.seconds(600),
    //         originOverride: true,
    //       },
    //     }),
    //     // edgeLambdas: [
    //     //   {
    //     //     functionVersion: edgeFunction.currentVersion,
    //     //     eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
    //     //   },
    //     // ],
    //   },
    //   enableLogging: true,
    //   enabled: true,
    //   httpVersion: cloudfront.HttpVersion.HTTP2,
    //   priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
    // });

    new cdk.CfnOutput(this, "webvtt-interceptor-url", {
      value: cdn.url,
      exportName: "webvtt-interceptor-url"
    })

  }
    
}

module.exports = { WebvttInterceptorStack }
