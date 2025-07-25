const cdk = require('aws-cdk-lib');
const {BucketDeployment, Source} = require('aws-cdk-lib/aws-s3-deployment');

class DeployStack extends cdk.Stack {
  /**
   *
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);
    // config.json 생성
    const config = {
      UDPAudioReceiverStack: {
        ApiGatewayUrl: props.apiGatewayUrl
      },
      CLOUDFRONT_HLS_URL: props.hlsUrl,
      CognitoStack: {
        loginurl: props.cognitoLoginUrl
      }
    };

    // deploy web video player front-end to s3 bucket (including newly created config.json)
    const bucket_deployment = new BucketDeployment(this, 'video-player-deployment', {
      destinationBucket: props.video_player.video_player_bucket,
      sources: [Source.asset('lib/front-end/video-player/')],
      distribution: props.video_player.CDN_video_player,
      distributionPaths: ['/*']
      
    })

  }
}

module.exports = { DeployStack }
