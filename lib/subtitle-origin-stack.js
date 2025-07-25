const cdk = require('aws-cdk-lib');
const iam = require('aws-cdk-lib/aws-iam');
const apiGateway = require('aws-cdk-lib/aws-apigateway');
const lambda = require('aws-cdk-lib/aws-lambda');

const { Stack, Duration } = require('aws-cdk-lib');

class SubtitleOriginStack extends Stack {
  /**
   *
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    // const METADATA_API_URL = props.metadata_api.api_gateway.url;

    // create IAM role for lambdas getting access to metadata api gateway
    // const lambda_role = new iam.Role(this, 'subtitle-origin-lambda-role', {
    //   assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    //   roleName: "subtitle-origin-lambda-role",
    //   description: "Role for lambda"
    // })
    // lambda_role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess'))
    // lambda_role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'))

    // // create lambda function for building subtitles
    // const subtile_builder_lambda = new cdk.aws_lambda.Function(this, 'subtile-builder-lambda', {
    //   role: lambda_role,
    //   code: new cdk.aws_lambda.AssetCode('lib/lambdas/subtitle-builder/'),
    //   handler: 'subtitle-builder.handler',
    //   runtime: cdk.aws_lambda.Runtime.NODEJS_18_X,
    //   timeout: cdk.Duration.seconds(30),
    //   environment: {
    //     // METADATA_API_URL: METADATA_API_URL
    //   }
    // })


    const lambda_role = new iam.Role(this, 'subtitle-origin-lambda-role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      roleName: "subtitle-origin-lambda-role",
      description: "Role for lambda"
    })
    lambda_role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3ReadOnlyAccess'))
    lambda_role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'))

    // create lambda function for building subtitles
    const subtile_builder_lambda = new lambda.Function(this, 'subtile-builder-lambda', {
      role: lambda_role,
      code: lambda.Code.fromAsset('lib/lambdas/subtitle-builder/'),
      handler: 'subtitle-builder.handler',
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: Duration.seconds(30),
      environment: {
        // METADATA_API_URL: METADATA_API_URL
      }
    })

    // create API Gateway
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
    })
    this.api_gateway = api_gateway

    const subtitleResources = api_gateway.root.addResource('subtitle')
    const subtitleResource = subtitleResources.addResource('{id}')
    /////////////////// GET a single subtitle for a given webvtt chunk id /////////////////////////
    subtitleResource.addMethod('GET', new apiGateway.LambdaIntegration(subtile_builder_lambda))
    
    new cdk.CfnOutput(this, "subtitle-origin-url", {
      value: api_gateway.url,
      exportName: "subtitle-origin-url"
    })

  }
    
}

module.exports = { SubtitleOriginStack }
