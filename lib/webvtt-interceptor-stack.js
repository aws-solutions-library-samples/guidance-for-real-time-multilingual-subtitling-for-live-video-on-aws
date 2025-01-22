const cdk = require('aws-cdk-lib');
const iam = require('aws-cdk-lib/aws-iam');

class WebvttInterceptorStack extends cdk.Stack {
  /**
   *
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    // Create Cloudfront distribution
    // Create Lambda @ Edge for webvtt augmenter

    new cdk.CfnOutput(this, "webvtt-interceptor-url", {
      value: cdn.url,
      exportName: "webvtt-interceptor-url"
    })

  }
    
}

module.exports = { WebvttInterceptorStack }
