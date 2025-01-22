const cdk = require('aws-cdk-lib');
const iam = require('aws-cdk-lib/aws-iam');


class BaseLiveStreamingStack extends cdk.Stack {
  /**
   *
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    //const METADATA_API_URL = props.metadata_api.api_gateway.url;
    
    // Create EMX
    // Create EML
    // Create EMP
    // Create CloudFront for media distribution to video player
    
  }
}

module.exports = { BaseLiveStreamingStack }
