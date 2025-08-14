// Stack for deploying video player frontend to S3
const cdk = require('aws-cdk-lib');
const {BucketDeployment, Source} = require('aws-cdk-lib/aws-s3-deployment');


class DeployStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    
    // Add explicit dependency to ensure other stacks are deployed first
    if (props.udpAudioReceiverStack) {
      this.addDependency(props.udpAudioReceiverStack);
    }
    if (props.baseLiveStreamingStack) {
      this.addDependency(props.baseLiveStreamingStack);
    }
    if (props.cognitoStack) {
      this.addDependency(props.cognitoStack);
    }

    // Deploy video player frontend to S3 bucket
    new BucketDeployment(this, 'video-player-deployment', {
      destinationBucket: props.video_player.video_player_bucket,
      sources: [Source.asset('lib/front-end/video-player/')],
      distribution: props.video_player.CDN_video_player,
      distributionPaths: ['/*']
    })

  }
}

module.exports = { DeployStack }