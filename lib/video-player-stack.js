const cdk = require('aws-cdk-lib');
const s3 = require('aws-cdk-lib/aws-s3');
const {S3Origin} = require('aws-cdk-lib/aws-cloudfront-origins');
const {Distribution, OriginAccessIdentity} = require('aws-cdk-lib/aws-cloudfront');

class VideoPlayerStack extends cdk.Stack {
  /**
   *
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    // Create s3 bucket for web video player front-end
    const video_player_bucket = new s3.Bucket(this, 'video-player-bucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    })
    this.video_player_bucket = video_player_bucket

    // create CloudFront CDN distribution for web video player front-end
    const video_player_access_identity = new OriginAccessIdentity(this, 'video-player-access-identity');
    video_player_bucket.grantRead(video_player_access_identity);
    const CDN_video_player = new Distribution(this, 'CDN-video-player', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: new S3Origin(video_player_bucket, {video_player_access_identity})
      },
    })
    this.CDN_video_player = CDN_video_player
    new cdk.CfnOutput(this, "CDN-video-player-url", {
      value: 'https://' + CDN_video_player.distributionDomainName + '/',
      exportName: "CDN-video-player-url"
    })

  }
    
}

module.exports = { VideoPlayerStack }
