// BY Taehoon Kyeong 08.11

## Auto Live Subtitling - Real-time Video Subtitle Generation

This project provides an automated live subtitling solution that generates real-time subtitles for video streams using AWS services. The system processes live video streams, extracts audio, performs speech-to-text transcription, and delivers synchronized subtitles to viewers.

## Architecture Overview

The solution is built using AWS CDK and consists of multiple interconnected stacks that work together to provide end-to-end live subtitling functionality.

## AWS Resources and Stack Configuration

### 1. BaseLiveStreamingStack
**Purpose**: Core live streaming infrastructure with MediaLive and MediaPackage

**Resources Created**:
- **MediaConnect Flow**: Signal acquisition for live video input
- **MediaPackage Channel (v1)**: Live video packaging and distribution
- **MediaPackage HLS Endpoint**: HLS streaming endpoint with 2-second segments
- **MediaLive Channel**: Live video encoding with multiple quality outputs (1080p, 720p, 540p)
- **MediaLive Input**: MP4 file input for video processing
- **CloudFront Distribution**: Global content delivery with caching policies
- **Lambda@Edge Function**: WebVTT augmentation for subtitle integration
- **IAM Roles**: MediaLive service permissions for MediaPackage and MediaConnect access

**Key Features**:
- Single pipeline MediaLive channel with H.264 encoding
- Multi-bitrate adaptive streaming (1080p/720p/540p)
- Timecode embedding for subtitle synchronization
- CloudFront distribution with CORS support

### 2. UDPAudioReceiverStack
**Purpose**: Audio processing and speech-to-text transcription infrastructure

**Resources Created**:
- **VPC**: Isolated network environment with public/private subnets
- **ECS Fargate Cluster**: Container orchestration for audio processing
- **ECS Fargate Service**: Containerized UDP audio receiver application
- **Network Load Balancer**: Load balancing for UDP (port 7950) and TCP (port 8080) traffic
- **DynamoDB Table**: Subtitle storage with TTL and GSI for session-based queries
- **ECR Repository Reference**: Container image repository for audio receiver
- **API Gateway**: REST API for video processing control
- **Lambda Functions**:
  - **ProcessVideoLambda**: Video processing initiation and MediaLive integration
  - **ResetLambda**: System reset and cleanup operations
- **EventBridge Rule**: MediaLive channel state change detection
- **Security Groups**: Network access control for Fargate services

**Key Features**:
- Real-time UDP audio stream processing
- Amazon Transcribe integration for speech-to-text
- DynamoDB-based subtitle storage with session management
- Auto-scaling Fargate services
- MediaLive channel lifecycle management

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
- **IAM Role**: MediaLive service permissions for MediaPackage and MediaConnect access
- **Multi-Language Caption Outputs**: WebVTT subtitle generation for 5 languages
- **Video Output**: Single 1080p H.264 encoded stream
- **SSM Parameter Integration**: Secure credential management for MediaPackage authentication

**Key Features**:
- Single pipeline MediaLive channel configuration
- Multi-language subtitle support (English, Korean, Spanish, German, Hindi)
- WebVTT format subtitle generation with proper language codes
- Automatic MediaPackage integration with secure authentication
- Timecode embedding for precise subtitle synchronization
- HLS output with 2-second segment duration


### 6. DeployStack
**Purpose**: Frontend deployment and configuration management

**Resources Created**:
- **S3 Bucket Deployment**: Automated frontend asset deployment
- **Configuration Management**: Dynamic config.json generation

**Key Features**:
- Automated frontend deployment to S3
- Dynamic configuration injection
- CloudFront cache invalidation

## System Workflow

1. **Video Input**: Live video stream enters through MediaLive input
2. **Video Processing**: MediaLive encodes video into multiple bitrates
3. **Audio Extraction**: Fargate container extracts audio via UDP stream
4. **Speech Recognition**: Amazon Transcribe converts audio to text
5. **Subtitle Storage**: Transcribed text stored in DynamoDB with timing
6. **Video Distribution**: MediaPackage delivers HLS stream via CloudFront
7. **Subtitle Synchronization**: Frontend polls API for real-time subtitles
8. **User Experience**: Viewers see synchronized video and subtitles

## Deployment

The system deploys as interconnected CDK stacks with proper dependency management:

```bash
npm run deploy-all
```

**Stack Dependencies**:
- VideoPlayerStack → CognitoStack → BaseLiveStreamingStack → UDPAudioReceiverStack → SubtitleOriginStack → DeployStack

## Key Integrations

- **MediaLive ↔ MediaPackage**: Live video encoding and packaging
- **MediaLive ↔ Fargate**: Audio stream extraction via UDP
- **EC2 ↔ Transcribe**: Real-time speech-to-text processing
- **EC2 ↔ DynamoDB**: Subtitle storage and retrieval
- **Frontend ↔ API Gateway**: Real-time subtitle polling
- **CloudFront ↔ MediaPackage**: Global video distribution


## How to Start
 1. 'npm run deploy-all'   --> cdk deploy --all && node scripts/update-config.js"

2.
ffmpeg -re -stream_loop -1 -i ~/sample.mp4 \
  -vcodec libx264 -b:v 2000k -r 25 -vf scale=1920:1080 \
  -acodec aac -strict -2 -ac 2 -ab 128k -ar 48000 \
  -f mpegts \
  "srt://52.200.153.138:3088?mode=caller"

## Instructions
If you have changed stack and try to redeploy a single stack, please make sure you run 'update-config.js' as well.

 ## Clean Resources
 1. Stop MediaConnect and MediaLive
 2. Delete Lambda Edge 
 3. CDK deploy --all
