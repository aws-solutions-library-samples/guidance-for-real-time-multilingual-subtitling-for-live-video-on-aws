const cdk = require('aws-cdk-lib');
const iam = require('aws-cdk-lib/aws-iam');
const ec2 = require('aws-cdk-lib/aws-ec2');
const { ecs, ecs_patterns } = require('aws-cdk-lib/aws-ecs-patterns');

class UDPAudioReceiverStack extends cdk.Stack {
  /**
   *
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    const UDP_PORT = 7950;

    // Create DynamoDB for Transcription store

    // Create ecs fargate udp service with network load balancer 
    // Create a new VPC
    const vpc = new ec2.Vpc(this, 'VPC', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrBlock: '10.0.0.0/18',
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrBlock: '10.0.64.0/18',
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // Create an ECS cluster in new VPC
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: vpc,
    });

    // Create a Fargate service with a network load balancer
    const fargateService = new ecs_patterns.NetworkLoadBalancedFargateService(this, 'FargateService', {
      cluster: cluster,
      taskImageOptions: {
        image: ecs.ContainerImage.fromEcrRepository(ecr.Repository.fromRepositoryName(captionsStack, "captions-audio-receiver-repository", "aws-captions-audio-receiver"), "latest"),
        containerPort: UDP_PORT, // port your UDP application is listening on
      },
      publicLoadBalancer: true,
      desiredCount: 2,
      cpu: 256,
      memoryLimitMiB: 512,
    });

    // Add a listener for UDP traffic on the network load balancer
    fargateService.listener.addUdpListener(UDP_PORT, {
      // Configure the UDP listener as needed
    });
  }
}

module.exports = { UDPAudioReceiverStack }
