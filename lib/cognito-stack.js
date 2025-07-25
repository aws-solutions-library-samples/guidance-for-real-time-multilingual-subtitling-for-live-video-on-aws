const cdk = require('aws-cdk-lib');
const cognito = require('aws-cdk-lib/aws-cognito');

class CognitoStack extends cdk.Stack {
  /**
   *
   * @param {Construct} scope
   * @param {string} id
   * @param {StackProps=} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);
    
    // create cognito for user login
    const user_pool = new cognito.UserPool(this, "user-pool", {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: false },
      accountRecovery: cognito.AccountRecovery.NONE,
      passwordPolicy: {
        minLength: 6,
        requireLowercase: false,
        requireUppercase: false,
        requireDigits: false,
        requireSymbols: false      
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

     // create cognito client for video player
     const video_player_client = user_pool.addClient("video-player-client", {
      oAuth: {
        flows: {
          implicitCodeGrant: true,
        },
        scopes: [ cognito.OAuthScope.OPENID ],
        callbackUrls: [ 
          'https://' + props.video_player.CDN_video_player.distributionDomainName + '/', 
          'http://localhost:8080/'
         ]
      }
    });

    user_pool.addDomain("user-pool-domain", {
      cognitoDomain: {
        domainPrefix: "auto-live-subtitling"
      }
    });
    this.user_pool = user_pool

    new cdk.CfnOutput(this, "login-url", {
      value: `https://auto-live-subtitling.auth.${cdk.Stack.of(this).region}.amazoncognito.com/oauth2/authorize?client_id=${video_player_client.userPoolClientId}&response_type=token&scope=openid&redirect_uri=`,
      exportName: "login-url"
    });
    this.loginUrl = `https://auto-live-subtitling.auth.${cdk.Stack.of(this).region}.amazoncognito.com/oauth2/authorize?client_id=${video_player_client.userPoolClientId}&response_type=token&scope=openid&redirect_uri=`;
  
  }
    
}

module.exports = { CognitoStack }
