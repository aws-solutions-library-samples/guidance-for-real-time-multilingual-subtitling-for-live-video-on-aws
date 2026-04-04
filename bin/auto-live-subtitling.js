#!/usr/bin/env node

const cdk = require('aws-cdk-lib');
const { VideoPlayerStack } = require('../lib/video-player-stack');
const { CognitoStack } = require('../lib/cognito-stack');
const { BaseLiveStreamingStack } = require('../lib/base-live-streaming-stack');
const { MediaLiveStack } = require('../lib/medialive-stack');
const { UDPAudioReceiverStack } = require('../lib/udp-audio-receiver-stack');
const { DeployStack } = require('../lib/deploy-stack');
const { EcsSubtitleProcessorStack } = require('../lib/ecs-subtitle-processor-stack');


const app = new cdk.App();

// Lambda@Edge requires us-east-1, so all stacks must be in us-east-1
const stackEnv = { region: 'us-east-1' };

const video_player = new VideoPlayerStack(app, 'VideoPlayerStack', { env: stackEnv });
const cognito = new CognitoStack(app, 'CognitoStack', {
  video_player: video_player,
  env: stackEnv
});
const udp_audio_receiver = new UDPAudioReceiverStack(app, 'UDPAudioReceiverStack', { env: stackEnv });
const base_live_streaming = new BaseLiveStreamingStack(app, 'BaseLiveStreamingStack', {
  subtitleTable: udp_audio_receiver.subtitleTable,
  env: stackEnv
});

// MediaLive stack depends on BaseLiveStreamingStack
const media_live = new MediaLiveStack(app, 'MediaLiveStack', { env: stackEnv });
media_live.addDependency(base_live_streaming);

base_live_streaming.addDependency(udp_audio_receiver);

// ECS Fargate subtitle processor (parallel to EC2 — Phase 3 testing)
const ecs_subtitle_processor = new EcsSubtitleProcessorStack(app, 'EcsSubtitleProcessorStack', {
  vpc: udp_audio_receiver.vpc,
  env: stackEnv
});
ecs_subtitle_processor.addDependency(udp_audio_receiver);

const deploy = new DeployStack(app, 'DeployStack', {
  video_player: video_player,
  apiGatewayUrl: udp_audio_receiver.apiGatewayUrl,
  cognitoLoginUrl: cognito.loginUrl,
  hlsUrl: base_live_streaming.hlsStreamUrl,
  cfDomainName: base_live_streaming.distributionDomainName,
  udpAudioReceiverStack: udp_audio_receiver,
  baseLiveStreamingStack: base_live_streaming,
  cognitoStack: cognito,
  env: stackEnv
});

