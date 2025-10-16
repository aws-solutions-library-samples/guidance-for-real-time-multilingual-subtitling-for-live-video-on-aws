
## Auto Live Multilingual Subtitling - Real-time Video Subtitle Generation

This project provides an automated live subtitling solution that generates real-time subtitles for video streams using AWS services. The system processes live video streams, extracts audio, performs speech-to-text transcription, and delivers synchronized subtitles to viewers.

## Architecture Overview

The solution is built using AWS CDK and consists of multiple interconnected stacks that work together to provide end-to-end live subtitling functionality.

![Alt text](Architecture.png)

## AWS Resources and Stack Configuration

### 1. BaseLiveStreamingStack
**Purpose**: Core live streaming infrastructure with MediaLive and MediaPackage

**Resources Created**:
- **MediaPackage Channel (v1)**: Live video packaging and distribution
- **MediaPackage HLS Endpoint**: HLS streaming endpoint with 2-second segments
- **CloudFront Distribution**: Global content delivery with caching policies
- **Lambda@Edge Function**: WebVTT augmentation for subtitle integration
- **IAM Roles**: MediaLive service permissions for MediaPackage and MediaConnect access

**Key Features**:
- Multi-bitrate adaptive streaming (1080p/720p/540p)
- Timecode embedding for subtitle synchronization

### 2. UDPAudioReceiverStack
**Purpose**: Audio processing and speech-to-text transcription infrastructure

**Resources Created**:
- **VPC**: Isolated network environment with public/private subnets
 -**EC2**: Compute service for realtime transcription and genAI based translation
- **DynamoDB Table**: Subtitle storage with TTL and GSI for session-based queries
- **API Gateway**: REST API for video processing control
- **Lambda Functions**:
  - **ProcessVideoLambda**: Video processing initiation and MediaLive integration
  - **ResetLambda**: System reset and cleanup operations
- **Security Groups**: Network access control for Fargate services

**Key Features**:
- Real-time UDP audio stream processing
- Amazon Transcribe integration for speech-to-text
- DynamoDB-based subtitle storage with session management

### 3. VideoPlayerStack
**Purpose**: Web-based video player frontend hosting

**Resources Created**:
- **S3 Bucket**: Static website hosting for video player frontend
- **CloudFront Distribution**: CDN for frontend asset delivery
- **Origin Access Identity**: Secure S3 access from CloudFront

**Key Features**:
- Responsive web video player interface
- HLS video playback support
- Real-time subtitle display
- CloudFront-accelerated content delivery

### 4. CognitoStack
**Purpose**: User authentication and authorization

**Resources Created**:
- **Cognito User Pool**: User management and authentication
- **Cognito User Pool Client**: OAuth2 integration for video player
- **Cognito Domain**: Authentication UI hosting

**Key Features**:
- OAuth2 implicit grant flow
- Email-based user authentication
- Integration with video player frontend

### 5. MediaLiveStack
**Purpose**: Live video encoding and multi-language subtitle generation

**Resources Created**:
- **MediaLive Channel**: Live video encoding with H.264 codec
- **MediaLive Input**: MP4 file input for video processing
- **MediaConnect Flow**: Signal acquisition for live video input(SRT)authentication

**Key Features**:
- Single pipeline MediaLive channel configuration
- MediaConnect for live content ingestion

### 6. DeployStack
**Purpose**: Frontend deployment and configuration management

**Resources Created**:
- **S3 Bucket Deployment**: Automated frontend asset deployment
- **Configuration Management**: Dynamic config.json generation

## Prerequisite
Make sure CDK is initialized before deployment.

## Deployment

The system deploys as interconnected CDK stacks with proper dependency management:


```bash
npm install
npm run deploy-all
```

## How to Start after Deployment

1. Start live streaming with OBS (Option1)
2. Local ffmpeg command like below. (Option2)

ffmpeg -re -stream_loop -1 -i ~/sample.mp4 \
  -vcodec libx264 -b:v 2000k -r 25 -vf scale=1920:1080 \
  -acodec aac -strict -2 -ac 2 -ab 128k -ar 48000 \
  -f mpegts \
  "srt://yourMediaConnectIP:3088?mode=caller"


 ## What you need to know
 1. Language options are preconfigured in 'lib/medialive-stack.js', lib/user-data/ec2-bootstrap.sh  and /lib/IBC2025_Subtitle_v3.js. If you want to test with different languages, make sure to configure language options before deployment. Default version displays "en,de,es,it,ko,hi"

 2. /lib/custom_vocabulary.csv is for 'Track and Field' event. If you want to try different sports event with custom vocabulary capability, please update the file. (Custom vocabulary is deployed automatically with the name 'custom-vocabulary') 

 ## Clean Resources
 1. Stop MediaConnect and MediaLive
 2. CDK destroy --all (Will meet some issues due to Lambda@ and unstopped resources, delete manually)


## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.

