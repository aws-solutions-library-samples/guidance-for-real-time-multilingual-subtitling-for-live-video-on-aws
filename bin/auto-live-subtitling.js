#!/usr/bin/env node

const cdk = require('aws-cdk-lib');
const { VideoPlayerStack } = require('../lib/video-player-stack');
const { CognitoStack } = require('../lib/cognito-stack');
const { MetadataApiStack } = require('../lib/metadata-api-stack');
const { BaseLiveStreamingStack } = require('../lib/base-live-streaming-stack');
const { UDPAudioReceiverStack } = require('../lib/udp-audio-receiver-stack');
const { SubtitleOriginStack } = require('../lib/subtitle-origin-stack');
const { DeployStack } = require('../lib/deploy-stack');


const app = new cdk.App();
const video_player = new VideoPlayerStack(app, 'VideoPlayerStack', {});
const cognito = new CognitoStack(app, 'CognitoStack', {video_player: video_player});
const metadata_api = new MetadataApiStack(app, 'MetadataApiStack', {cognito: cognito});
const base_live_streaming = new BaseLiveStreamingStack(app, 'BaseLiveStreamingStack', {});
const udp_audio_receiver = new UDPAudioReceiverStack(app, 'UDPAudioReceiverStack', {metadata_api: metadata_api});
const subtitle_origin = new SubtitleOriginStack(app, 'SubtitleOriginStack', {metadata_api: metadata_api});
const deploy = new DeployStack(app, 'DeployStack', {video_player: video_player, udp_audio_receiver: udp_audio_receiver});
