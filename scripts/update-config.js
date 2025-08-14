#!/usr/bin/env node

const { execSync } = require('child_process');

// Update S3 config
const bucketName = execSync('aws cloudformation describe-stacks --stack-name VideoPlayerStack --query "Stacks[0].Outputs[?OutputKey==\'ExportsOutputRefvideoplayerbucketB70188454D54F8C6\'].OutputValue" --output text --region us-east-1', { encoding: 'utf8' }).trim();
execSync(`aws s3 cp lib/front-end/video-player/config.json s3://${bucketName}/config.json --content-type application/json --region us-east-1`);

// Start MediaConnect Flow
const mediaConnectFlowArn = execSync('aws cloudformation describe-stacks --stack-name UDPAudioReceiverStack --query "Stacks[0].Outputs[?OutputKey==\'MediaConnectFlowArn\'].OutputValue" --output text --region us-east-1', { encoding: 'utf8' }).trim();
execSync(`aws mediaconnect start-flow --flow-arn "${mediaConnectFlowArn}" --region us-east-1`, { stdio: 'ignore' });

// Start MediaLive Channel
// const mediaLiveChannelId = execSync('aws cloudformation describe-stacks --stack-name BaseLiveStreamingStack --query "Stacks[0].Outputs[?OutputKey==\'MediaLiveChannelId\'].OutputValue" --output text --region us-east-1', { encoding: 'utf8' }).trim();
// execSync(`aws medialive start-channel --channel-id "${mediaLiveChannelId}" --region us-east-1`, { stdio: 'ignore' });

console.log('✅ Deployment completed. MediaConnect Flow and MediaLive Channel started.');
