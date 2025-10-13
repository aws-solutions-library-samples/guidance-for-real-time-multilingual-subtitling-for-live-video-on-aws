// Cognito stack for user authentication
const cdk = require('aws-cdk-lib');
const cognito = require('aws-cdk-lib/aws-cognito');

class CognitoStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    
    const account = cdk.Stack.of(this).account;
    const domainPrefix = `auto-live-subtitling-${account}`;
    
    // Create Cognito user pool
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

    // Create Cognito client for video player
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
        domainPrefix: domainPrefix
      }
    });
    this.user_pool = user_pool

    new cdk.CfnOutput(this, "login-url", {
      value: `https://${domainPrefix}.auth.${cdk.Stack.of(this).region}.amazoncognito.com/oauth2/authorize?client_id=${video_player_client.userPoolClientId}&response_type=token&scope=openid&redirect_uri=https://${props.video_player.CDN_video_player.distributionDomainName}/`,
      exportName: "login-url"
    });
    this.loginUrl = `https://${domainPrefix}.auth.${cdk.Stack.of(this).region}.amazoncognito.com/oauth2/authorize?client_id=${video_player_client.userPoolClientId}&response_type=token&scope=openid&redirect_uri=https://${props.video_player.CDN_video_player.distributionDomainName}/`;
  
  }
    
}

module.exports = { CognitoStack }
