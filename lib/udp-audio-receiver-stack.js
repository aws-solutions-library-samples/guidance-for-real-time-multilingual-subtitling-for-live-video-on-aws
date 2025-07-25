const cdk = require('aws-cdk-lib');
const iam = require('aws-cdk-lib/aws-iam');
const ec2 = require('aws-cdk-lib/aws-ec2');
const ecs = require('aws-cdk-lib/aws-ecs');
const ecr = require('aws-cdk-lib/aws-ecr');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const elbv2 = require('aws-cdk-lib/aws-elasticloadbalancingv2');
const apigateway = require('aws-cdk-lib/aws-apigateway'); // VIdeoStart, Reset control --taehoon 06.21
const lambda = require('aws-cdk-lib/aws-lambda'); // Triggers Fargate
const events = require('aws-cdk-lib/aws-events');
const targets = require('aws-cdk-lib/aws-events-targets');
const mediaLiveChannelId = cdk.Fn.importValue('MediaLiveChannelId');


class UDPAudioReceiverStack extends cdk.Stack {
  /**
   *
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   */
  constructor(scope, id, props = {}) {
    super(scope, id, props);

    const UDP_PORT = 7950;

    const isProduction = props.isProduction || false;

    // Create DynamoDB table for subtitle storage 
    const subtitleTable = new dynamodb.Table(this, 'SubtitleTable', {
      tableName: 'SubtitleTable',
      partitionKey: { name: 'resultId', type: dynamodb.AttributeType.STRING }, 
      sortKey: { name: 'startTime', type: dynamodb.AttributeType.NUMBER },    
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'timestamp_ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Add GSI for session-based queries 
    subtitleTable.addGlobalSecondaryIndex({
      indexName: 'sessionId-startTime-index',
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'startTime', type: dynamodb.AttributeType.NUMBER }
    });


    // VPC
    const vpc = new ec2.Vpc(this, 'UdpReceiverVpc', {
      maxAzs: 2,
      natGateways: isProduction ? 2 : 1,
      restrictDefaultSecurityGroup: false,
    });



    // !!Important!! Reference existing ECR repository, user must first create udp-audio-receiver repository and push docker image
    const ecrRepository = ecr.Repository.fromRepositoryName(
      this,
      'ExistingAudioReceiverRepository',
      'udp-audio-receiver'
    );

    // Task Defnition(ARM64)
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'UdpReceiverTaskDef', {
      memoryLimitMiB: isProduction ? 2048 : 1024,
      cpu: isProduction ? 1024 : 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // Task Role
    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['transcribe:*'],
      resources: ['*'],
    }));

    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:*'],
      resources: ['*'],
    }));

    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:*'],
      resources: ['*'],
    }));

    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ecr:*'],
      resources: ['*'],
    }));

    // SQS role
    taskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'sqs:ReceiveMessage',
        'sqs:DeleteMessage',
        'sqs:GetQueueAttributes',
      ],
      resources: ['*'],
    }));

    // Container role
    const container = taskDefinition.addContainer('UdpReceiverContainer', {
      image: ecs.ContainerImage.fromEcrRepository(ecrRepository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'udp-receiver',
      }),
      environment: {
        LANGUAGE_CODE: 'en-US',
        AWS_REGION: this.region,
        TABLE_NAME: subtitleTable.tableName,
        QUEUE_URL: process.env.QUEUE_URL || '',
        UDP_PORT: '7950',
        HTTP_PORT: '8080',
      },
    });

    container.addPortMappings(
      {
        containerPort: 8080,
        hostPort: 8080,
        protocol: ecs.Protocol.TCP,
      },
      {
        containerPort: UDP_PORT,
        hostPort: UDP_PORT,
        protocol: ecs.Protocol.UDP,
      }
    );

    // Security group for fargate
    const securityGroup = new ec2.SecurityGroup(this, 'UdpReceiverSecurityGroup', {
      vpc,
      description: 'Security group for UDP receiver',
      allowAllOutbound: true,
    });

    // UDP port
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(UDP_PORT),
      'Allow UDP traffic',
    );

    // TCP 8080 port
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8080),
      'Allow TCP 8080 traffic',
    );

    // NLB
    const lb = new elbv2.NetworkLoadBalancer(this, 'UdpReceiverNLB', {
      vpc,
      internetFacing: true,
    });

    // UDP target group + HealthCheck
    const udpTargetGroup = new elbv2.NetworkTargetGroup(this, 'UdpReceiverTargetGroup', {
      port: UDP_PORT,
      protocol: elbv2.Protocol.UDP,
      vpc,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        enabled: true,
        protocol: elbv2.Protocol.TCP,
        port: '8080',
      },
    });

    // TCP target group
    const tcpTargetGroup = new elbv2.NetworkTargetGroup(this, 'TcpReceiverTargetGroup', {
      port: 8080,
      protocol: elbv2.Protocol.TCP,
      vpc,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        enabled: true,
        protocol: elbv2.Protocol.TCP,
        port: '8080',
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
        timeout: cdk.Duration.seconds(6),
        interval: cdk.Duration.seconds(30),
      },
    });

    // UDP Listener
    const udpListener = lb.addListener('UdpListener', {
      port: UDP_PORT,
      protocol: elbv2.Protocol.UDP,
      defaultTargetGroups: [udpTargetGroup],
    });

    // TCP Listener
    const tcpListener = lb.addListener('TcpListener', {
      port: 8080,
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [tcpTargetGroup],
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'UdpReceiverCluster', {
      vpc,
    });

    // Fargate Service
    const service = new ecs.FargateService(this, 'UdpReceiverService', {
      cluster,
      taskDefinition,
      desiredCount: isProduction ? 2 : 1,
      securityGroups: [securityGroup],
      assignPublicIp: true,
      healthCheckGracePeriod: cdk.Duration.seconds(0),
    });


    udpTargetGroup.addTarget(service);
    tcpTargetGroup.addTarget(service);


    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: lb.loadBalancerDnsName,
      description: 'Network Load Balancer DNS name'
    });

    // Video Start Lambda
    const processVideoLambda = new lambda.Function(this, 'ProcessVideoLambda', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lib/lambdas/video-start'),
      environment: {
        NLB_ENDPOINT: lb.loadBalancerDnsName,
        NLB_PORT: '8080',
        MEDIALIVE_CHANNEL_ARN: cdk.Fn.importValue('MediaLiveChannelArn') 
      },
      timeout: cdk.Duration.seconds(30),
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    //MediaLive Role
    processVideoLambda.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
            'medialive:ListChannels',
            'medialive:DescribeChannel',
            'medialive:StartChannel',
            'medialive:StopChannel'
        ],
        resources: ['*']
    }));

    const mediaLiveChannel = cdk.Fn.importValue('MediaLiveChannelArn');

    // MediaLive Channel status change detection EventBridge Rule
    const mediaLiveEventRule = new events.Rule(this, 'MediaLiveChannelEventRule', {
      eventPattern: {
          source: ['aws.medialive'],
          detailType: ['MediaLive Channel State Change'],
          detail: {
              state: ['RUNNING'],
              channel_arn: [mediaLiveChannel]
          }
      }
    });
    //LambdaTarget for EventRule(Channel start)
    mediaLiveEventRule.addTarget(new targets.LambdaFunction(processVideoLambda));

    processVideoLambda.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
            'medialive:ListInputs',
            'medialive:DescribeInput'
        ],
        resources: ['*']
    }));

    // Reset Lambda
    const resetLambda = new lambda.Function(this, 'ResetLambda', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lib/lambdas/video-reset'),
      environment: {
        NLB_ENDPOINT: lb.loadBalancerDnsName,
        NLB_PORT: '8080',
        MEDIALIVE_CHANNEL_ID: mediaLiveChannelId,
      },
      timeout: cdk.Duration.seconds(30),
      vpc: vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    resetLambda.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
            'medialive:ListChannels',
            'medialive:DescribeChannel',
            'medialive:StartChannel',
            'medialive:StopChannel'
        ],
        resources: ['*']
    }));

    // MediaLive Channel ARN
    const mediaLiveChannelArn = cdk.Fn.importValue('MediaLiveChannelArn');

    processVideoLambda.addEnvironment('MEDIALIVE_CHANNEL_ARN', mediaLiveChannelArn);

    // API Gateway
    const api = new apigateway.RestApi(this, 'VideoProcessingApi', {
      restApiName: 'Video Processing API',
      description: 'API for video processing and subtitle generation',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // API lists
    const videoResource = api.root.addResource('video');
    const processVideoResource = videoResource.addResource('process-video');
    const resetResource = videoResource.addResource('reset');
    const getSubtitlesResource = videoResource.addResource('get-subtitles');

    processVideoResource.addMethod('POST', new apigateway.LambdaIntegration(processVideoLambda));
 
    resetResource.addMethod('POST', new apigateway.LambdaIntegration(resetLambda));
    
    getSubtitlesResource.addMethod('POST', new apigateway.LambdaIntegration(processVideoLambda, {
        requestTemplates: {
            'application/json': '{ "action": "get-subtitles", "body": $input.json("$") }'
        }
    }));

    // API Gateway URL
    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: api.url,
      description: 'API Gateway URL'
    });

    // Export for other stacks
    this.apiGatewayUrl = api.url;

    // Output the table name
    new cdk.CfnOutput(this, 'SubtitleTableName', {
      value: subtitleTable.tableName,
      description: 'DynamoDB table name for subtitles'
    });

    // Export values for other stacks 
    this.nlbEndpoint = lb.loadBalancerDnsName;
    this.subtitleTable = subtitleTable;
    this.loadBalancerDnsName = lb.loadBalancerDnsName;
  }
}

module.exports = { UDPAudioReceiverStack }
