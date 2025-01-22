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
    
    // deploy web video player front-end to s3 bucket (including newly created config.json)
    const bucket_deployment = new BucketDeployment(this, 'video-player-deployment', {
      destinationBucket: props.video_player.video_player_bucket,
      sources: [Source.asset('lib/front-end/video-player/')],
      distribution: props.video_player.CDN_video_player,
      distributionPaths: ['/*']
    })
    //bucket_deployment.node.addDependency(props.ad_break_processing)
  }
    
}

module.exports = { DeployStack }
