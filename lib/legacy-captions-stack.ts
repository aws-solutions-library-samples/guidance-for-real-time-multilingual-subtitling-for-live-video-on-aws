#!/usr/bin/env node

import "source-map-support/register";

import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";

const getEnv = (key: string) => {
	const envVar = process.env[key];

	if (!envVar) {
		throw new Error(`Required environment variable '${key}' is not set.`);
	}

	return envVar;
};

const stageId = getEnv("STAGE_ID");
const languageCodeKey = getEnv("LANGUAGE_CODE_KEY");

const taskResource = {
	cpu: +getEnv("TASK_RESOURCE_CPU"),
	memory: +getEnv("TASK_RESOURCE_MEMORY"),
};

const ports = {
	httpHealthCheck: +getEnv("CONTAINER_HEALTH_CHECK_PORT"),
	udpInput: +getEnv("CONTAINER_INPUT_PORT"),
};

const captionsStack = new cdk.Stack(new cdk.App(), `captions-stack-${stageId}`);

const captionsTable = new dynamodb.TableV2(captionsStack, "captions-table", {
	tableName: `captions-table-${stageId}`,
	partitionKey: {
		name: "id",
		type: dynamodb.AttributeType.STRING,
	},
	removalPolicy: cdk.RemovalPolicy.DESTROY,
});

const captionsTask = new ecs.FargateTaskDefinition(captionsStack, "captions-task", {
	family: `captions-task-${stageId}`,
	cpu: taskResource.cpu,
	memoryLimitMiB: taskResource.memory,
});

captionsTask.taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonTranscribeFullAccess"));
captionsTable.grantWriteData(captionsTask.taskRole);

const captionsVpc = new ec2.Vpc(captionsStack, "captions-vpc", {
	maxAzs: 2,
});

const captionsSecurityGroup = new ec2.SecurityGroup(captionsStack, "captions-sg", { vpc: captionsVpc, securityGroupName: `captions-sg-${stageId}` });

captionsSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(ports.httpHealthCheck));
captionsSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(ports.udpInput));

const captionsContainer = captionsTask.addContainer("captions-container", {
	containerName: `captions-container-${stageId}`,
	image: ecs.ContainerImage.fromEcrRepository(ecr.Repository.fromRepositoryName(captionsStack, "captions-audio-receiver-repository", "aws-captions-audio-receiver"), "latest"),
	portMappings: [
		{
			containerPort: ports.httpHealthCheck,
		},
		{
			containerPort: ports.udpInput,
			protocol: ecs.Protocol.UDP,
		},
	],
	environment: {
		region: captionsStack.region,
		LANGUAGE_CODE_KEY: languageCodeKey,
		TABLE_NAME: captionsTable.tableName,
	},
	logging: new ecs.AwsLogDriver({ streamPrefix: `captions-container-${stageId}` }),
});

const captionsFargateService = new ecs.FargateService(captionsStack, "captions-service", {
	cluster: new ecs.Cluster(captionsStack, "captions-cluster", { clusterName: `captions-cluster-${stageId}`, vpc: captionsVpc }),
	taskDefinition: captionsTask,
	serviceName: `captions-service-${stageId}`,
	securityGroups: [captionsSecurityGroup],
});

const captionsNetworkTargetGroup = new elbv2.NetworkTargetGroup(captionsStack, "captions-tg", {
	targetType: elbv2.TargetType.IP,
	targetGroupName: `captions-tg-${stageId}`,
	protocol: elbv2.Protocol.UDP,
	port: ports.udpInput,
	vpc: captionsVpc,
	healthCheck: {
		protocol: elbv2.Protocol.HTTP,
		port: ports.httpHealthCheck.toString(),
		timeout: cdk.Duration.seconds(5),
		interval: cdk.Duration.seconds(10),
	},
	targets: [
		captionsFargateService.loadBalancerTarget({
			containerName: captionsContainer.containerName,
			containerPort: ports.udpInput,
			protocol: ecs.Protocol.UDP,
		}),
	],
});

new elbv2.NetworkLoadBalancer(captionsStack, "captions-lb", {
	loadBalancerName: `captions-lb-${stageId}`,
	vpc: captionsVpc,
	securityGroups: [captionsSecurityGroup],
})
	.addListener("captions-listener", {
		port: ports.udpInput,
		protocol: elbv2.Protocol.UDP,
	})
	.addTargetGroups("captions-tg", captionsNetworkTargetGroup);
