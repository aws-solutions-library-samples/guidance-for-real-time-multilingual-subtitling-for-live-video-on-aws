const cdk = require('aws-cdk-lib');
const iam = require('aws-cdk-lib/aws-iam');
const ec2 = require('aws-cdk-lib/aws-ec2');
const ecs = require('aws-cdk-lib/aws-ecs');
const ecr = require('aws-cdk-lib/aws-ecr');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const elbv2 = require('aws-cdk-lib/aws-elasticloadbalancingv2');
const apigateway = require('aws-cdk-lib/aws-apigateway'); // VIdeoStart, Reset control --taehoon 06.21
const lambda = require('aws-cdk-lib/aws-lambda'); 
const events = require('aws-cdk-lib/aws-events');
const targets = require('aws-cdk-lib/aws-events-targets');
const s3 = require('aws-cdk-lib/aws-s3');
const s3deploy = require('aws-cdk-lib/aws-s3-deployment');
const s3assets = require('aws-cdk-lib/aws-s3-assets');
const fs = require('fs');
const path = require('path');
const { DockerImageAsset } = require('aws-cdk-lib/aws-ecr-assets');


class UDPAudioReceiverStack extends cdk.Stack {
  /**
   *
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   */
  constructor(scope, id, props = {}) {
    super(scope, id, props);

    const isProduction = props.isProduction || false;

    // Create DynamoDB table for subtitle storage 
    const subtitleTable = new dynamodb.Table(this, 'SubtitleTable', {
      tableName: 'SubtitleTable',
      partitionKey: { name: 'id_name', type: dynamodb.AttributeType.STRING }, 
      sortKey: { name: 'id_lang', type: dynamodb.AttributeType.STRING },    
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'timestamp_ttl',
      pointInTimeRecovery: true, 
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Add GSI for language-based queries (Python schema compatible)
    subtitleTable.addGlobalSecondaryIndex({
      indexName: 'id_lang-created_time-index',
      partitionKey: { name: 'id_lang', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_time', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['content', 'start_time', 'end_time', 'IsPartial', 'create_htime', 'create_Acttime', 'timestamp_ttl']
    });


    // VPC
    const vpc = new ec2.Vpc(this, 'UdpReceiverVpc', {
      maxAzs: 2,
      natGateways: isProduction ? 2 : 1,
      restrictDefaultSecurityGroup: false,
    });
    

    // ec2Role
    const ec2Role = new iam.Role(this, 'EC2MediaProcessingRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Policy for ec2
    ec2Role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['transcribe:*'],
      resources: ['*'],
    }));

    ec2Role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:*'],
      resources: ['*'],
    }));

    ec2Role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:*'],
      resources: ['*'],
    }));

    ec2Role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['translate:TranslateText'],
      resources: ['*'],
    }));

 
    const securityGroup = new ec2.SecurityGroup(this, 'RTPReceiverSecurityGroup', {
      vpc,
      description: 'Security group for UDP receiver',
      allowAllOutbound: true,
    });

    // RTP port for MediaConnect
    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(5000),
      'Allow RTP traffic from MediaConnect',
    );

    // // NLB
    // const lb = new elbv2.NetworkLoadBalancer(this, 'UdpReceiverNLB', {
    //   vpc,
    //   internetFacing: true,
    // });

    // // RTP target group for port 5000
    // const rtpTargetGroup = new elbv2.NetworkTargetGroup(this, 'RtpTargetGroup', {
    //   port: 5000,
    //   protocol: elbv2.Protocol.UDP,
    //   vpc,
    //   targetType: elbv2.TargetType.IP,
    //   // healthCheck: {
    //   //   enabled: true,
    //   //   protocol: elbv2.Protocol.TCP,
    //   //   port: '8080',
    //   // },
    // });

    // // RTP Listener for port 5000
    // const rtpListener = lb.addListener('RtpListener', {
    //   port: 5000,
    //   protocol: elbv2.Protocol.UDP,
    //   defaultTargetGroups: [rtpTargetGroup],
    // });

    // // ECS Cluster
    // const cluster = new ecs.Cluster(this, 'UdpReceiverCluster', {
    //   vpc,
    // });

    // // Fargate Service
    // const service = new ecs.FargateService(this, 'UdpReceiverService', {
    //   cluster,
    //   taskDefinition,
    //   desiredCount: isProduction ? 2 : 1,
    //   securityGroups: [securityGroup],
    //   assignPublicIp: true,
    //   healthCheckGracePeriod: cdk.Duration.seconds(0),
    // });


    // rtpTargetGroup.addTarget(service.loadBalancerTarget({
    //   containerName: 'UdpReceiverContainer',
    //   containerPort: 5000,
    //   protocol: ecs.Protocol.UDP
    // }));


    // new cdk.CfnOutput(this, 'LoadBalancerDNS', {
    //   value: lb.loadBalancerDnsName,
    //   description: 'Network Load Balancer DNS name'
    // });

    // new cdk.CfnOutput(this, 'LoadBalancerIP', {
    //   value: lb.loadBalancerDnsName, // In production, you'd get the actual IP
    //   description: 'Network Load Balancer IP for MediaConnect output',
    //   exportName: 'FargateNLBEndpoint'
    // });
   
    const instanceProfile = new iam.CfnInstanceProfile(this, 'EC2InstanceProfile', {
      roles: [ec2Role.roleName],
    });

    // Create Asset for the subtitle processor script
    const subtitleScriptAsset = new s3assets.Asset(this, 'SubtitleScriptAssetV3', {
      path: path.join(__dirname, 'IBC2025_Subtitle_v3.js')
    });

    // Grant EC2 role permission to read the asset
    subtitleScriptAsset.grantRead(ec2Role);

    const userDataScript = fs.readFileSync(
      path.join(__dirname, 'user-data/ec2-bootstrap.sh'), 
      'utf8'
    );
    
    const userData = ec2.UserData.forLinux();
    userData.addCommands(userDataScript);
    
    // Add commands to download the script from S3 asset using direct aws s3 cp
    userData.addCommands(
      'apt update',
      'snap install aws-cli --classic',
      'mkdir -p /opt/subtitle-processor',
      `aws s3 cp s3://${subtitleScriptAsset.bucket.bucketName}/${subtitleScriptAsset.s3ObjectKey} /opt/subtitle-processor/subtitle-processor.js --region ${this.region}`,
      'chmod +x /opt/subtitle-processor/subtitle-processor.js',
      'chown ubuntu:ubuntu /opt/subtitle-processor/subtitle-processor.js',
      'until [ -f /opt/subtitle-processor/subtitle-processor.js ] && [ -s /opt/subtitle-processor/subtitle-processor.js ]; do sleep 2; done',
      'systemctl daemon-reload',
      'systemctl enable subtitle-processor',
      'systemctl start subtitle-processor',
      'echo "=== Service Status ===" >> /var/log/userdata.log',
      'systemctl status subtitle-processor >> /var/log/userdata.log 2>&1',
      'echo "UserData script completed successfully" >> /var/log/userdata.log'
    );

    const ec2Instance = new ec2.Instance(this, 'RealtimeTranscription', {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.C5, ec2.InstanceSize.XLARGE2),
      machineImage: ec2.MachineImage.fromSsmParameter('/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id'),
      vpc: vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: securityGroup,
      role: ec2Role,
      userData: userData,
    });
 
    
    

    // Video Start Lambda
    // const processVideoLambda = new lambda.Function(this, 'ProcessVideoLambda', {
    //   runtime: lambda.Runtime.NODEJS_18_X,
    //   handler: 'index.handler',
    //   code: lambda.Code.fromAsset('lib/lambdas/video-start'),
    //   environment: {
    //     // NLB_ENDPOINT: lb.loadBalancerDnsName,
    //     // NLB_PORT: '8080',
    //     MEDIALIVE_CHANNEL_ARN: process.env.MEDIALIVE_CHANNEL_ARN || '',
    //     MEDIACONNECT_FLOW_ARN: mediaConnectFlow.attrFlowArn
    //   },
    //   timeout: cdk.Duration.seconds(30),
    //   vpc: vpc,
    //   vpcSubnets: {
    //     subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    //   },
    // });

    // //MediaLive and MediaConnect Role
    // processVideoLambda.addToRolePolicy(new iam.PolicyStatement({
    //     effect: iam.Effect.ALLOW,
    //     actions: [
    //         'medialive:ListChannels',
    //         'medialive:DescribeChannel',
    //         'medialive:StartChannel',
    //         'medialive:StopChannel'
    //     ],
    //     resources: ['*']
    // }));

    // // Add MediaConnect permissions
    // processVideoLambda.addToRolePolicy(new iam.PolicyStatement({
    //     effect: iam.Effect.ALLOW,
    //     actions: [
    //         'mediaconnect:DescribeFlow',
    //         'mediaconnect:ListFlows'
    //     ],
    //     resources: [mediaConnectFlow.attrFlowArn]
    // }));

    // const mediaLiveChannel = process.env.MEDIALIVE_CHANNEL_ARN || '';

    // const mediaConnectStatusRule = new events.Rule(this, 'MediaConnectStatusRule', {
    //   eventPattern: {
    //     source: ['aws.mediaconnect'],
    //     detailType: ['AWS API Call via CloudTrail'],
    //     detail: {
    //       eventSource: ['mediaconnect.amazonaws.com'],
    //       eventName: ['StartFlow'],
    //       responseElements: {
    //         flowArn: [mediaConnectFlow.attrFlowArn]
    //       }
    //     }
    //   }
    // });

    // mediaConnectStatusRule.addTarget(new targets.LambdaFunction(processVideoLambda));

    // processVideoLambda.addToRolePolicy(new iam.PolicyStatement({
    //     effect: iam.Effect.ALLOW,
    //     actions: [
    //         'medialive:ListInputs',
    //         'medialive:DescribeInput'
    //     ],
    //     resources: ['*']
    // }));

    /* // Reset Lambda
    const resetLambda = new lambda.Function(this, 'ResetLambda', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lib/lambdas/video-reset'),
      environment: {
        MEDIACONNECT_FLOW_ARN: mediaConnectFlow.attrFlowArn,
        SUBTITLE_TABLE_NAME: subtitleTable.tableName,
      },
      timeout: cdk.Duration.seconds(900),
      // 
    }); */

    /* // MediaConnect permissions for reset lambda
    resetLambda.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
            'mediaconnect:StopFlow',
            'mediaconnect:DescribeFlow'
        ],
        resources: [mediaConnectFlow.attrFlowArn]
    })); */

    // DynamoDB permissions for reset lambda
    /* resetLambda.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
            'dynamodb:Scan',
            'dynamodb:BatchWriteItem'
        ],
        resources: [subtitleTable.tableArn]
    })); */ 

    // API Gateway for 'Reset'
    const api = new apigateway.RestApi(this, 'VideoProcessingApi', {
      restApiName: 'Video Processing API',
      description: 'API for video reset functionality',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // API resources
    const videoResource = api.root.addResource('video');
    // const resetResource = videoResource.addResource('reset');
    
    // resetResource.addMethod('POST', new apigateway.LambdaIntegration(resetLambda));

    // API Gateway URL output
    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: api.url,
      description: 'API Gateway URL',
      exportName: 'ApiGatewayUrl'
    });

    // Export for other stacks
    this.apiGatewayUrl = api.url;

    // Output the table name
    new cdk.CfnOutput(this, 'SubtitleTableName', {
      value: subtitleTable.tableName,
      description: 'DynamoDB table name for subtitles'
    });


    new cdk.CfnOutput(this, 'EC2PublicIP', {
      value: ec2Instance.instancePublicIp,
      exportName: 'EC2PublicIP'
    });

    const videoPlayerBucketName = cdk.Fn.importValue('VideoPlayerBucket');
    const videoPlayerBucket = s3.Bucket.fromBucketName(this, 'ImportedVideoPlayerBucket', videoPlayerBucketName);

    // Upload custom vocabulary file to S3
    const vocabularyDeployment = new s3deploy.BucketDeployment(this, 'VocabularyDeployment', {
      sources: [s3deploy.Source.asset('lib')],
      destinationBucket: videoPlayerBucket,
      include: ['custom_vocabulary.txt']
    });

    // Export values for other stacks 

    this.subtitleTable = subtitleTable;
  }
}

module.exports = { UDPAudioReceiverStack }
