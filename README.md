# Auto_live_subtitling - `@amzn/auto-live-subtitling`

The NPM package name should always start with `@amzn/` to cleanly separate from
public packages, avoid accidental publish to public repository, and allow
publishing to CodeArtifact.

The package is built with
[NpmPrettyMuch](https://w.amazon.com/bin/view/NpmPrettyMuch/GettingStarted/v1)
and allows using internal (first-party) dependencies as well as external
npmjs.com packages.

Add registry dependencies with `brazil-build install` exactly the same as [`npm
install`](https://docs.npmjs.com/cli-commands/install.html). You can check
latest state of external dependencies on https://npmpm.corp.amazon.com/
Important: always use `brazil-build` wrapper for npm, using `npm` directly will
use the public registry instead of the internal registry.

Add brazil packages that build npm packages to the `dependencies` or
`test-dependencies` sections in the Config file,  then add a `*` dependency or
devDependencies to package.json. You should match `test-dependencies` with
`devDependencies`, and normal `dependencies` with `dependencies`.

NpmPrettyMuch 1.0 has special behavior for running tests during build. The
option `"runTest": "never"` disabled this and instead tests are wired up in
`prepublishOnly`. NpmPrettyMuch will invoke `prepublishOnly` and everything can
configured in there the [same as with external
npm](https://docs.npmjs.com/misc/scripts). Files to published are configured
using [`files` in
`package.json`](https://docs.npmjs.com/configuring-npm/package-json.html#files).
The option `ciBuild` uses [`npm
ci`](https://docs.npmjs.com/cli-commands/ci.html) instead of `npm install` and
results in faster install times and guarantees all of your dependencies are
locked appropriately.








finch run --env-file dev.env -p 7950:7950/udp udp-audio-receiver




# Current deployment error ...

Interestingly the synthesised templates don't seem to include any section for m3u8Settings, in spite of it being present in the CDK definition.

```
BaseLiveStreamingStack
DeployStack: start: Publishing f810d67fe7d69bf5d4f2cfe33984835b0e5ad35016de745af5e11aebb565c3b8:current_account-current_region
BaseLiveStreamingStack: deploying... [3/6]
DeployStack: success: Published f810d67fe7d69bf5d4f2cfe33984835b0e5ad35016de745af5e11aebb565c3b8:current_account-current_region
BaseLiveStreamingStack: creating CloudFormation changeset...
BaseLiveStreamingStack | 0/4 | 10:06:35 AM | UPDATE_IN_PROGRESS   | AWS::CloudFormation::Stack             | BaseLiveStreamingStack User Initiated
BaseLiveStreamingStack | 0/4 | 10:06:40 AM | UPDATE_IN_PROGRESS   | AWS::CDK::Metadata                     | CDKMetadata/Default (CDKMetadata) 
BaseLiveStreamingStack | 0/4 | 10:06:41 AM | CREATE_IN_PROGRESS   | AWS::MediaLive::Channel                | MediaLiveChannel 
BaseLiveStreamingStack | 1/4 | 10:06:41 AM | UPDATE_COMPLETE      | AWS::CDK::Metadata                     | CDKMetadata/Default (CDKMetadata) 
BaseLiveStreamingStack | 1/4 | 10:07:03 AM | CREATE_FAILED        | AWS::MediaLive::Channel                | MediaLiveChannel outputGroups[0].outputs[0].outputSettings.hlsSettings.m3u8Settings requires property "m3u8Settings"; outputGroups[0].outputs[0].outputSettings.hlsOutputSettings.hlsSettings Object does not match "standard"; outputGroups[0].outputs[0].outputSettings Object does not match "hls" (Service: AWSMediaLive; Status Code: 422; Error Code: UnprocessableEntityException; Request ID: c14e745e-370e-4bc4-ac08-0b295ee337ea; Proxy: null)
BaseLiveStreamingStack | 1/4 | 10:07:06 AM | UPDATE_FAILED        | AWS::CloudFormation::Stack             | BaseLiveStreamingStack The following resource(s) failed to create: [MediaLiveChannel]. 

Failed resources:
BaseLiveStreamingStack | 10:07:03 AM | CREATE_FAILED        | AWS::MediaLive::Channel                | MediaLiveChannel outputGroups[0].outputs[0].outputSettings.hlsSettings.m3u8Settings requires property "m3u8Settings"; outputGroups[0].outputs[0].outputSettings.hlsOutputSettings.hlsSettings Object does not match "standard"; outputGroups[0].outputs[0].outputSettings Object does not match "hls" (Service: AWSMediaLive; Status Code: 422; Error Code: UnprocessableEntityException; Request ID: c14e745e-370e-4bc4-ac08-0b295ee337ea; Proxy: null)

NOTICES         (What's this? https://github.com/aws/aws-cdk/wiki/CLI-Notices)

32775   (cli): CLI versions and CDK library versions have diverged

        Overview: Starting in CDK 2.179.0, CLI versions will no longer be in
                  lockstep with CDK library versions. CLI versions will now be
                  released as 2.1000.0 and continue with 2.1001.0, etc.

        Affected versions: cli: >=2.0.0 <=2.1005.0

        More information at: https://github.com/aws/aws-cdk/issues/32775


If you don’t want to see a notice anymore, use "cdk acknowledge <id>". For example, "cdk acknowledge 32775".
❌  BaseLiveStreamingStack failed: _ToolkitError: The stack named BaseLiveStreamingStack failed to deploy: UPDATE_FAILED (The following resource(s) failed to create: [MediaLiveChannel]. ): outputGroups[0].outputs[0].outputSettings.hlsSettings.m3u8Settings requires property "m3u8Settings"; outputGroups[0].outputs[0].outputSettings.hlsOutputSettings.hlsSettings Object does not match "standard"; outputGroups[0].outputs[0].outputSettings Object does not match "hls" (Service: AWSMediaLive; Status Code: 422; Error Code: UnprocessableEntityException; Request ID: c14e745e-370e-4bc4-ac08-0b295ee337ea; Proxy: null)```