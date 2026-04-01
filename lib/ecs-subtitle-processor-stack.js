const cdk = require('aws-cdk-lib');
const ec2 = require('aws-cdk-lib/aws-ec2');
const ecs = require('aws-cdk-lib/aws-ecs');
const iam = require('aws-cdk-lib/aws-iam');
const elbv2 = require('aws-cdk-lib/aws-elasticloadbalancingv2');
const logs = require('aws-cdk-lib/aws-logs');
const path = require('path');
const { DockerImageAsset } = require('aws-cdk-lib/aws-ecr-assets');

class EcsSubtitleProcessorStack extends cdk.Stack {
  constructor(scope, id, props = {}) {
    super(scope, id, props);

    // MediaConnect AZ — must match for minimal latency and NLB routing
    const mediaConnectAz = props.mediaConnectAz || `${this.region}a`;

    // Import VPC from UDPAudioReceiverStack (passed as prop)
    const vpc = props.vpc;

    // --- Elastic IP for NLB (MediaConnect requires static IP) ---
    const eip = new ec2.CfnEIP(this, 'SubtitleNlbEip', {
      tags: [{ key: 'Name', value: 'subtitle-processor-nlb-eip' }]
    });

    // --- Security Group ---
    const securityGroup = new ec2.SecurityGroup(this, 'EcsSubtitleSG', {
      vpc,
      description: 'Security group for ECS subtitle processor',
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(5000),
      'Allow RTP traffic from NLB'
    );

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8080),
      'Allow NLB TCP health check'
    );

    // --- NLB (single AZ with EIP for MediaConnect static IP) ---
    const publicSubnets = vpc.publicSubnets.filter(
      s => s.availabilityZone === mediaConnectAz
    );

    const nlb = new elbv2.NetworkLoadBalancer(this, 'SubtitleNLB', {
      vpc,
      internetFacing: true,
      crossZoneEnabled: false,
      vpcSubnets: { subnets: publicSubnets },
    });

    // L1 override: replace Subnets with SubnetMappings to attach EIP
    const cfnNlb = nlb.node.defaultChild;
    if (publicSubnets.length > 0) {
      cfnNlb.addPropertyOverride('SubnetMappings', [{
        SubnetId: publicSubnets[0].subnetId,
        AllocationId: eip.attrAllocationId,
      }]);
      cfnNlb.addPropertyDeletionOverride('Subnets');
    }

    // --- UDP Target Group ---
    const udpTargetGroup = new elbv2.NetworkTargetGroup(this, 'SubtitleUdpTG', {
      port: 5000,
      protocol: elbv2.Protocol.UDP,
      vpc,
      targetType: elbv2.TargetType.IP,
      deregistrationDelay: cdk.Duration.seconds(0),
      healthCheck: {
        enabled: true,
        protocol: elbv2.Protocol.TCP,
        port: '8080',
        interval: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5,
        timeout: cdk.Duration.seconds(6),
      },
    });

    // UDP Listener
    nlb.addListener('UdpListener', {
      port: 5000,
      protocol: elbv2.Protocol.UDP,
      defaultTargetGroups: [udpTargetGroup],
    });

    // --- ECS Cluster ---
    const cluster = new ecs.Cluster(this, 'SubtitleProcessorCluster', {
      vpc,
      containerInsights: true,
    });

    // --- Task Role (same permissions as EC2) ---
    const taskRole = new iam.Role(this, 'SubtitleTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['transcribe:*'],
      resources: ['*'],
    }));

    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:*'],
      resources: ['*'],
    }));

    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:*'],
      resources: ['*'],
    }));

    taskRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['translate:TranslateText'],
      resources: ['*'],
    }));

    // --- CloudWatch Log Group ---
    const logGroup = new logs.LogGroup(this, 'SubtitleProcessorLogs', {
      logGroupName: '/ecs/subtitle-processor',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Docker Image ---
    const dockerImage = new DockerImageAsset(this, 'SubtitleProcessorImage', {
      directory: path.join(__dirname, 'containers/subtitle-processor'),
      platform: require('aws-cdk-lib/aws-ecr-assets').Platform.LINUX_AMD64,
    });

    // --- Fargate Task Definition ---
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'SubtitleTaskDef', {
      cpu: 4096,       // 4 vCPU
      memoryLimitMiB: 8192, // 8 GB
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const container = taskDefinition.addContainer('SubtitleProcessorContainer', {
      image: ecs.ContainerImage.fromDockerImageAsset(dockerImage),
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'subtitle',
      }),
      environment: {
        AWS_REGION: this.region,
        DYNAMODB_TABLE: 'SubtitleTable',
        LANGUAGE_CONFIG_TABLE: 'LanguageConfigTable',
        LANGUAGE_CODE: 'en-US',
        SOURCE_LANGUAGE: 'en',
        VOCABULARY_NAME: 'custom-vocabulary',
        RTP_BIND_ADDRESS: '0.0.0.0',
        RTP_PORT: '5000',
      },
      essential: true,
    });

    container.addPortMappings(
      { containerPort: 5000, protocol: ecs.Protocol.UDP },
      { containerPort: 8080, protocol: ecs.Protocol.TCP },
    );

    // --- Fargate Service ---
    // Find private subnet in MediaConnect AZ
    const privateSubnets = vpc.privateSubnets.filter(
      s => s.availabilityZone === mediaConnectAz
    );

    const service = new ecs.FargateService(this, 'SubtitleProcessorService', {
      cluster,
      taskDefinition,
      desiredCount: 1,
      securityGroups: [securityGroup],
      assignPublicIp: false,
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      vpcSubnets: privateSubnets.length > 0
        ? { subnets: privateSubnets }
        : { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });

    // Register service with NLB target group
    udpTargetGroup.addTarget(
      service.loadBalancerTarget({
        containerName: 'SubtitleProcessorContainer',
        containerPort: 5000,
        protocol: ecs.Protocol.UDP,
      })
    );

    // --- Outputs ---
    new cdk.CfnOutput(this, 'NlbEipAddress', {
      value: eip.ref,
      description: 'NLB Elastic IP address for MediaConnect RTP output',
      exportName: 'SubtitleNlbEipAddress',
    });

    new cdk.CfnOutput(this, 'NlbDnsName', {
      value: nlb.loadBalancerDnsName,
      description: 'NLB DNS name',
    });

    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: cluster.clusterName,
      description: 'ECS Cluster name',
    });

    new cdk.CfnOutput(this, 'EcsServiceName', {
      value: service.serviceName,
      description: 'ECS Service name',
    });

    // Export EIP for MediaConnect stack to reference
    this.nlbEipAddress = eip.ref;
  }
}

module.exports = { EcsSubtitleProcessorStack };
