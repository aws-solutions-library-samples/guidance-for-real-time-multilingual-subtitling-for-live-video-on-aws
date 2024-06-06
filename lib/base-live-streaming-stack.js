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

    const METADATA_API_URL = props.metadata_api.api_gateway.url;
    const AD_DECISION_SERVER_URL = "https://n8ljfs0h09.execute-api.us-west-2.amazonaws.com/v1/adproxy?aid=[player_params.aid]";

    
  }
}

module.exports = { BaseLiveStreamingStack }
