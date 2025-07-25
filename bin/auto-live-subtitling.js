#!/usr/bin/env node

const cdk = require('aws-cdk-lib');
const { VideoPlayerStack } = require('../lib/video-player-stack');
const { CognitoStack } = require('../lib/cognito-stack');
const { WebvttInterceptorStack } = require('../lib/webvtt-interceptor-stack');
const { BaseLiveStreamingStack } = require('../lib/base-live-streaming-stack');
const { UDPAudioReceiverStack } = require('../lib/udp-audio-receiver-stack');
const { SubtitleOriginStack } = require('../lib/subtitle-origin-stack');
const { DeployStack } = require('../lib/deploy-stack');


const app = new cdk.App();
const video_player = new VideoPlayerStack(app, 'VideoPlayerStack', {});
const cognito = new CognitoStack(app, 'CognitoStack', {video_player: video_player});
// const webvtt_interceptor = new WebvttInterceptorStack(app, 'WebvttInterceptorStack', {cognito: cognito});  // Moved interceptor to live streaming stack to ease dependencies.
const base_live_streaming = new BaseLiveStreamingStack(app, 'BaseLiveStreamingStack', {});
const udp_audio_receiver = new UDPAudioReceiverStack(app, 'UDPAudioReceiverStack', {
  hlsStreamUrl: base_live_streaming.hlsStreamUrl
});
const subtitle_origin = new SubtitleOriginStack(app, 'SubtitleOriginStack', {base_live_streaming: BaseLiveStreamingStack});
const deploy = new DeployStack(app, 'DeployStack', {
  video_player: video_player,
  apiGatewayUrl: udp_audio_receiver.apiGatewayUrl, // API Gateway URL
  cognitoLoginUrl: cognito.loginUrl, // Cognito Login URL
  hlsUrl: base_live_streaming.hlsStreamUrl 
});
