const cdk = require('aws-cdk-lib');
const iam = require('aws-cdk-lib/aws-iam');
const apiGateway = require('aws-cdk-lib/aws-apigateway');
const lambda = require('aws-cdk-lib/aws-lambda');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const cloudfront = require('aws-cdk-lib/aws-cloudfront');
const origins = require('aws-cdk-lib/aws-cloudfront-origins');

const { Stack, Duration, RemovalPolicy } = require('aws-cdk-lib');

class SubtitleOriginStack extends Stack {
  /**
   *
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    // Use existing DynamoDB table from UDPAudioReceiverStack
    const transcriptTable = props.transcriptTable;

    // IAM role for Lambda@Edge function
    const vttInserterRole = new iam.Role(this, 'VTTInserterRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.ServicePrincipal('edgelambda.amazonaws.com')
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });

    // Grant DynamoDB read permissions to Lambda@Edge
    transcriptTable.grantReadData(vttInserterRole);

    // Lambda@Edge function for VTT insertion
    const vttInserterFunction = new lambda.Function(this, 'VTTInserterFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lib/lambdas/webvtt-augmenter'),
      role: vttInserterRole,
      memorySize: 128,
      timeout: Duration.seconds(5),
      description: 'Lambda@Edge function for inserting VTT subtitles'
    });

    // CloudFront distribution for VTT interception
    const vttDistribution = new cloudfront.Distribution(this, 'VTTDistribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(props.mediaPackageEndpoint || 'example.com', {
          customHeaders: {
            'dynamo_table': transcriptTable.tableName,
            'dynamo_index': 'id_lang-sort_starttime-index',
            'pipe_id': props.pipeId || 'default-pipe',
            'caption_passthrough': 'false',
            'caption_replace': 'true',
            'caption_buffer': '2'
          }
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: new cloudfront.CachePolicy(this, 'VTTCachePolicy', {
          defaultTtl: Duration.seconds(1),
          minTtl: Duration.seconds(0),
          maxTtl: Duration.seconds(5),
          enableAcceptEncodingGzip: true,
          headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
            'Access-Control-Request-Headers',
            'Access-Control-Request-Method',
            'Origin'
          ),
          queryStringBehavior: cloudfront.CacheQueryStringBehavior.all()
        }),
        originRequestPolicy: new cloudfront.OriginRequestPolicy(this, 'VTTOriginRequestPolicy', {
          headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
            'Access-Control-Request-Headers',
            'Access-Control-Request-Method',
            'Origin'
          ),
          queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all()
        }),
        responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'VTTResponseHeadersPolicy', {
          corsBehavior: {
            accessControlAllowCredentials: false,
            accessControlAllowHeaders: ['*'],
            accessControlAllowMethods: ['GET', 'HEAD', 'PUT'],
            accessControlAllowOrigins: ['*'],
            accessControlMaxAge: Duration.seconds(600),
            originOverride: true
          }
        }),
        edgeLambdas: [{
          functionVersion: vttInserterFunction.currentVersion,
          eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST
        }]
      },
      additionalBehaviors: {
        '*.vtt': {
          origin: new origins.HttpOrigin(props.mediaPackageEndpoint || 'example.com'),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          edgeLambdas: [{
            functionVersion: vttInserterFunction.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST
          }]
        }
      },
      enableLogging: true,
      enabled: true,
      httpVersion: cloudfront.HttpVersion.HTTP2,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100
    });

    // Legacy API Gateway for subtitle builder
    const lambda_role = new iam.Role(this, 'subtitle-origin-lambda-role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      roleName: "subtitle-origin-lambda-role",
      description: "Role for lambda"
    });
    lambda_role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess'));
    lambda_role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'));

    const subtile_builder_lambda = new lambda.Function(this, 'subtile-builder-lambda', {
      role: lambda_role,
      code: lambda.Code.fromAsset('lib/lambdas/subtitle-builder/'),
      handler: 'subtitle-builder.handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: Duration.seconds(30)
    });

    const api_gateway = new apiGateway.RestApi(this, 'subtitle-origin', {
      restApiName: 'auto-live-subtitling-subtitle-origin',
      cloudWatchRole: true,
      deploy: true,
      deployOptions: {
        stageName: "prod",
        loggingLevel: apiGateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apiGateway.Cors.ALL_ORIGINS,
        allowMethods: apiGateway.Cors.ALL_METHODS,
        allowHeaders: apiGateway.Cors.DEFAULT_HEADERS,
        allowCredentials: true,
        disableCache: true
      },
      defaultMethodOptions: {
        methodResponses: [{
          statusCode: '200',
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true
          }
        }]
      }
    });

    const subtitleResources = api_gateway.root.addResource('subtitle');
    const subtitleResource = subtitleResources.addResource('{id}');
    subtitleResource.addMethod('GET', new apiGateway.LambdaIntegration(subtile_builder_lambda));
    
    // Expose properties for other stacks
    this.api_gateway = api_gateway;
    this.transcriptTable = transcriptTable;
    this.vttDistribution = vttDistribution;
    this.vttInserterFunction = vttInserterFunction;
    
    new cdk.CfnOutput(this, "subtitle-origin-url", {
      value: api_gateway.url,
      exportName: "subtitle-origin-url"
    });

    new cdk.CfnOutput(this, "vtt-distribution-url", {
      value: vttDistribution.distributionDomainName,
      exportName: "vtt-distribution-url"
    });

    new cdk.CfnOutput(this, "transcript-table-name", {
      value: transcriptTable.tableName,
      exportName: "transcript-table-name"
    });

  }
    
}

module.exports = { SubtitleOriginStack }
