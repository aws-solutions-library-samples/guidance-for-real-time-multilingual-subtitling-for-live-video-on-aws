#!/usr/bin/env node

const { execSync } = require('child_process');

console.log('Starting deployment configuration update...');

// S3 config update
console.log('📁 Updating S3 config...');
const bucketName = execSync('aws cloudformation describe-stacks --stack-name VideoPlayerStack --query "Stacks[0].Outputs[?OutputKey==\'ExportsOutputRefvideoplayerbucketB70188454D54F8C6\'].OutputValue" --output text --region us-east-1', { encoding: 'utf8' }).trim();
execSync(`aws s3 cp lib/front-end/video-player/config.json s3://${bucketName}/config.json --content-type application/json --region us-east-1`);
console.log('✅ S3 config updated');

// MediaPackage 
console.log('🔍 Getting MediaPackage HLS ingest information...');

const channelInfo = JSON.parse(execSync(
  'aws mediapackage describe-channel --id "live-streaming-channel" --region us-east-1',
  { encoding: 'utf8' }
));

const primaryIngest = channelInfo.HlsIngest.IngestEndpoints[0];
const ingestDomain = new URL(primaryIngest.Url).hostname;
const ingestUsername = primaryIngest.Username;
const ingestPassword = primaryIngest.Password;


// 1. CloudFront Origin update
console.log('🔄 Updating WebVTT CloudFront origin...');

const webvttDistributionId = execSync(
  'aws cloudformation describe-stacks --stack-name BaseLiveStreamingStack --query "Stacks[0].Outputs[?OutputKey==\'WebVTTDistributionId\'].OutputValue" --output text --region us-east-1',
  { encoding: 'utf8' }
).trim();

const currentConfig = JSON.parse(execSync(
  `aws cloudfront get-distribution-config --id "${webvttDistributionId}" --region us-east-1`,
  { encoding: 'utf8' }
));

currentConfig.DistributionConfig.Origins.Items[0].DomainName = ingestDomain;

execSync(`aws cloudfront update-distribution --id "${webvttDistributionId}" --distribution-config '${JSON.stringify(currentConfig.DistributionConfig)}' --if-match "${currentConfig.ETag}" --region us-east-1`);

console.log(`✅ WebVTT CloudFront origin updated to: ${ingestDomain}`);

// 2. SSM Parameter Store
console.log('💾 Storing password in SSM Parameter Store...');

execSync(`aws ssm put-parameter --name "/medialive/live-streaming-pw" --value "${ingestPassword}" --type "SecureString" --overwrite --region us-east-1`);

console.log('✅ Password stored in SSM Parameter Store as "live-streaming-pw"');

// 3. MediaLive Channel 
console.log('🔄 Updating MediaLive Channel credentials...');

try {
  // MediaLive Channel ID 
  const mediaLiveChannelId = execSync(
    'aws cloudformation describe-stacks --stack-name MediaLiveStack --query "Stacks[0].Outputs[?OutputKey==\'MediaLiveChannelId\'].OutputValue" --output text --region us-east-1',
    { encoding: 'utf8' }
  ).trim();

  // MediaLive Channel Config
  const mediaLiveConfig = JSON.parse(execSync(
    `aws medialive describe-channel --channel-id "${mediaLiveChannelId}" --region us-east-1`,
    { encoding: 'utf8' }
  ));

  // Username, PasswordParam, and URL update for MediaLive output destination
  if (mediaLiveConfig.Destinations && mediaLiveConfig.Destinations[0] && mediaLiveConfig.Destinations[0].Settings && mediaLiveConfig.Destinations[0].Settings[0]) {
    // Extract ingest endpoint ID from MediaPackage URL
    const ingestEndpointId = primaryIngest.Id;
    
    // Get Playback Distribution CloudFront domain (WebVTT Distribution)
    const playbackCloudFrontDomain = execSync(
      'aws cloudformation describe-stacks --stack-name BaseLiveStreamingStack --query "Stacks[0].Outputs[?OutputKey==\'WebVTTCFDomainName\'].OutputValue" --output text --region us-east-1',
      { encoding: 'utf8' }
    ).trim();
        
    const newUrl = `https://${playbackCloudFrontDomain}/in/v2/${ingestEndpointId}/${ingestEndpointId}/channel`;
    console.log(`🔍 Debug - New URL: ${newUrl}`);
    
    // Update MediaLive destination settings
    mediaLiveConfig.Destinations[0].Settings[0].Username = ingestUsername;
    mediaLiveConfig.Destinations[0].Settings[0].PasswordParam = '/medialive/live-streaming-pw';
    mediaLiveConfig.Destinations[0].Settings[0].Url = `https://${playbackCloudFrontDomain}/in/v2/${ingestEndpointId}/${ingestEndpointId}/channel`;

    // MediaLive Channel Update
    const updateParams = {
      ChannelId: mediaLiveChannelId,
      Destinations: mediaLiveConfig.Destinations,
      EncoderSettings: mediaLiveConfig.EncoderSettings,
      InputAttachments: mediaLiveConfig.InputAttachments,
      InputSpecification: mediaLiveConfig.InputSpecification,
      Name: mediaLiveConfig.Name,
      RoleArn: mediaLiveConfig.RoleArn
    };

    execSync(`aws medialive update-channel --cli-input-json '${JSON.stringify(updateParams)}' --region us-east-1`);

    console.log(`✅ MediaLive Channel credentials updated:`);
    console.log(`   Username: ${ingestUsername}`);
    console.log(`   Password Parameter: live-streaming-pw`);
  } else {
    console.log('⚠️  MediaLive Channel destinations structure not found');
  }

} catch (error) {
  console.log('⚠️  Failed to update MediaLive Channel:', error.message);
}

// 4. Amazon Transcribe Custom Voc
console.log('📚 Creating Custom Vocabulary...');
try {
  const fs = require('fs');
  const vocabularyPath = 'lib/custom_vocabulary.csv'; //Switch to different csv file name
  
  if (fs.existsSync(vocabularyPath)) {

    execSync(`aws s3 cp ${vocabularyPath} s3://${bucketName}/custom_vocabulary.csv --region us-east-1`);
    console.log('✅ Vocabulary file uploaded to S3');
    
    const vocabularyUri = `s3://${bucketName}/custom_vocabulary.csv`;
    
    try {
      execSync(`aws transcribe get-vocabulary --vocabulary-name "custom-vocabulary" --region us-east-1`, { stdio: 'ignore' });
      execSync(`aws transcribe update-vocabulary --vocabulary-name "custom-vocabulary" --language-code "en-US" --vocabulary-file-uri "${vocabularyUri}" --region us-east-1`, { stdio: 'ignore' });
      console.log('✅ Custom Vocabulary updated with DisplayAs');
    } catch (describeError) {
      execSync(`aws transcribe create-vocabulary --vocabulary-name "custom-vocabulary" --language-code "en-US" --vocabulary-file-uri "${vocabularyUri}" --region us-east-1`, { stdio: 'ignore' });
      console.log('✅ Custom Vocabulary created with DisplayAs');
    }
  } else {
    console.log('⚠️ custom_vocabulary.csv file not found');
  }
} catch (error) {
  console.log('⚠️ Custom Vocabulary failed:', error.message);
}

// 5. MediaConnect Flow Start
console.log('🔄 Starting MediaConnect Flow...');

try {
  const mediaConnectFlowArn = execSync('aws cloudformation describe-stacks --stack-name UDPAudioReceiverStack --query "Stacks[0].Outputs[?OutputKey==\'MediaConnectFlowArn\'].OutputValue" --output text --region us-east-1', { encoding: 'utf8' }).trim();
  execSync(`aws mediaconnect start-flow --flow-arn "${mediaConnectFlowArn}" --region us-east-1`, { stdio: 'ignore' });
  console.log('✅ MediaConnect Flow started');
} catch (error) {
  console.log('⚠️  MediaConnect Flow already running or failed to start');
}

// 6. MediaLive Channel Start
console.log('🔄 Starting MediaLive Channel...');

try {
  const mediaLiveChannelId = execSync(
    'aws cloudformation describe-stacks --stack-name MediaLiveStack --query "Stacks[0].Outputs[?OutputKey==\'MediaLiveChannelId\'].OutputValue" --output text --region us-east-1',
    { encoding: 'utf8' }
  ).trim();
  
  execSync(`aws medialive start-channel --channel-id "${mediaLiveChannelId}" --region us-east-1`, { stdio: 'ignore' });
  console.log('✅ MediaLive Channel started');
} catch (error) {
  console.log('⚠️  MediaLive Channel already running or failed to start');
}

console.log('📋 Summary:');
console.log(`   ✅ S3 Config updated`);
console.log(`   ✅ CloudFront Origin: ${ingestDomain}`);
console.log(`   ✅ SSM Parameter "live-streaming-password": [SECURE]`);
console.log(`   ✅ MediaLive Username: ${ingestUsername}`);
console.log(`   ✅ MediaConnect Flow: Started`);

