const cdk = require('aws-cdk-lib');
const iam = require('aws-cdk-lib/aws-iam');
const dynamoDB = require('aws-cdk-lib/aws-dynamodb');
const apiGateway = require('aws-cdk-lib/aws-apigateway');

class MetadataApiStack extends cdk.Stack {
  /**
   *
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    // create IAM role for api gateway getting access to dynamodb
    const api_gateway_role = new iam.Role(this, 'api-gateway-role', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      roleName: "api-gateway-role",
      description: "Role for API Gateway"
    })
    api_gateway_role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonDynamoDBFullAccess'))
    api_gateway_role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs'))

    // create database for video metadata
    const metadata_table = new dynamoDB.Table(this, 'metadata-table', {
      tableName: "ad-break-detection-metadata",
      partitionKey: {
        name: 'id',
        type: dynamoDB.AttributeType.STRING,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    })

    // create api gateway for video metadata
    const authorizer = new apiGateway.CognitoUserPoolsAuthorizer(this, 'metadata-api-authorizer', {
      cognitoUserPools: [props.cognito.user_pool]
    })
    const api_gateway = new apiGateway.RestApi(this, 'metadata-api', {
      restApiName: 'ad-break-detection-metadata-api',
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

    const defaultResponseParamters = {statusCode: '200', responseParameters: {'method.response.header.Access-Control-Allow-Origin': "'*'"}}
    const integrationResponses = [defaultResponseParamters]
    const videosResource = api_gateway.root.addResource('videos')
    /////////////////// GET list of all videos /////////////////////////
    videosResource.addMethod('GET', new apiGateway.AwsIntegration({
      service: 'dynamodb',
      action: 'Scan',
      options: {
          credentialsRole: api_gateway_role, 
          integrationResponses: [{...defaultResponseParamters,
            responseTemplates: {
              'application/json': 
                `#set($inputRoot = $input.path('$'))
                [
                        #foreach($elem in $inputRoot.Items) {
                            "id": "$elem.id.S",
                            "title": "$elem.title.S",
                            "duration": "$elem.duration.S",
                            "proxyBucket": "$elem.proxyBucket.S",
                            "proxyFile": "$elem.proxyFile.S",
                            "markers": "$util.escapeJavaScript($elem.markers.S)"
                        }#if($foreach.hasNext),#end
                        #end
                ]`
            }
          }],
          passthroughBehavior: apiGateway.PassthroughBehavior.WHEN_NO_MATCH,
          requestTemplates: {
              'application/json': `{
                   "TableName": "${metadata_table.tableName}"
              }`
          }
      }
    }), {
      authorizer: authorizer,
      authorizationType: apiGateway.AuthorizationType.COGNITO
    })
    /////////////////// POST new video /////////////////////////
    videosResource.addMethod('POST', new apiGateway.AwsIntegration({
      service: 'dynamodb',
      action: 'PutItem',
      options: {
          credentialsRole: api_gateway_role, 
          integrationResponses,
          passthroughBehavior: apiGateway.PassthroughBehavior.WHEN_NO_MATCH,
          requestTemplates: {
            'application/json': `{
                "Item": {
                  "id": {"S":$input.json('$.id')},
                  "title": {"S":$input.json('$.title')},
                  "duration": {"S":$input.json('$.duration')},
                  "proxyBucket": {"S":$input.json('$.proxyBucket')},
                  "proxyFile": {"S":$input.json('$.proxyFile')},
                  "markers": {"S":$input.json('$.markers')}
                },
                 "TableName": "${metadata_table.tableName}"
            }`
        }
      }
    }))
    const videoResource = videosResource.addResource('{id}')
    /////////////////// GET a single video /////////////////////////
    videoResource.addMethod('GET', new apiGateway.AwsIntegration({
      service: 'dynamodb',
      action: 'GetItem',
      options: {
          credentialsRole: api_gateway_role, 
          integrationResponses: [{...defaultResponseParamters,
            responseTemplates: {
              'application/json': 
                `#set($inputRoot = $input.path('$'))
                {
                            "id": "$inputRoot.Item.id.S",
                            "title": "$inputRoot.Item.title.S",
                            "duration": "$inputRoot.Item.duration.S",
                            "proxyBucket": "$inputRoot.Item.proxyBucket.S",
                            "proxyFile": "$inputRoot.Item.proxyFile.S",
                            "markers": $inputRoot.Item.markers.S                 
                }`
            }
          }],
          passthroughBehavior: apiGateway.PassthroughBehavior.WHEN_NO_MATCH,
          requestTemplates: {
              'application/json': `{
                  "Key": {
                    "id": {
                      "S": "$method.request.path.id"
                    }
                  },
                  "TableName": "${metadata_table.tableName}"
              }`
          }
      }
    }))
    /////////////////// DELETE a single video /////////////////////////
    videoResource.addMethod('DELETE', new apiGateway.AwsIntegration({
      service: 'dynamodb',
      action: 'DeleteItem',
      options: {
          credentialsRole: api_gateway_role, 
          integrationResponses,
          passthroughBehavior: apiGateway.PassthroughBehavior.WHEN_NO_MATCH,
          requestTemplates: {
              'application/json': `{
                  "Key": {
                    "id": {
                      "S": "$method.request.path.id"
                    }
                  },
                  "TableName": "${metadata_table.tableName}"
              }`
          }
      }
    }))

    new cdk.CfnOutput(this, "metadata-api-url", {
      value: api_gateway.url,
      exportName: "metadata-api-url"
    })

  }
    
}

module.exports = { MetadataApiStack }
