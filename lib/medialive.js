const { aws_medialive: medialive, aws_iam: iam, Aws, CfnOutput, Fn } = require("aws-cdk-lib");
const { Construct } = require("constructs");

class MediaLiveConstruct extends Construct {
  constructor(scope, id, configuration, mediaPackageChannelId = "", hlsIngestEndpoint1 = "", hlsIngestEndpoint2 = "") {
    super(scope, id);
    
    const myMediaLiveChannelName = Aws.STACK_NAME + "_Channel1";
    let destinationValue = [];
    let inputSettingsValue = {};

    /*
     * First step: Create MediaLive Policy & Role 👇
     */

    //👇Generate Policy for MediaLive to access MediaPackage, MediaConnect, S3, MediaStore...
    const customPolicyMediaLive = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          resources: ["*"],
          actions: [
            "s3:ListBucket",
            "s3:PutObject",
            "s3:GetObject",
            "s3:DeleteObject",
            "mediastore:ListContainers",
            "mediastore:PutObject",
            "mediastore:GetObject",
            "mediastore:DeleteObject",
            "mediastore:DescribeObject",
            "mediaconnect:ManagedDescribeFlow",
            "mediaconnect:ManagedAddOutput",
            "mediaconnect:ManagedRemoveOutput",
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents",
            "logs:DescribeLogStreams",
            "logs:DescribeLogGroups",
            "mediaconnect:ManagedDescribeFlow",
            "mediaconnect:ManagedAddOutput",
            "mediaconnect:ManagedRemoveOutput",
            "ec2:describeSubnets",
            "ec2:describeNetworkInterfaces",
            "ec2:createNetworkInterface",
            "ec2:createNetworkInterfacePermission",
            "ec2:deleteNetworkInterface",
            "ec2:deleteNetworkInterfacePermission",
            "ec2:describeSecurityGroups",
            "mediapackage:DescribeChannel",
            "mediapackagev2:PutObject",
          ],
        }),
      ],
    });

    const role = new iam.Role(this, "MediaLiveAccessRole", {
      inlinePolicies: {
        policy: customPolicyMediaLive,
      },
      assumedBy: new iam.ServicePrincipal("medialive.amazonaws.com"),
    });
    this.roleArn = role.roleArn;

    const mediaLiveSG = new medialive.CfnInputSecurityGroup(
      this,
      "MediaLiveInputSecurityGroup",
      {
        whitelistRules: [
          {
            cidr: configuration["inputCidr"],
          },
        ],
      }
    );

    const inputName =
      Aws.STACK_NAME + "_" + configuration["inputType"] + "_MediaLiveInput";

    let cfnInputProps = {
      name: "",
      roleArn: "",
      type: "",
      inputSecurityGroups: [],
      destinations: [
        {
          streamName: "",
        },
      ],
      inputDevices: [
        {
          id: "",
        },
      ],
      mediaConnectFlows: [
        {
          flowArn: "",
        },
      ],
      sources: [
        {
          passwordParam: "passwordParam",
          url: "url",
          username: "username",
        },
      ],
      vpc: {
        securityGroupIds: [""],
        subnetIds: [""],
      },
    };

    switch (configuration["inputType"]) {
      case "INPUT_DEVICE":
        if (configuration["channelClass"] == "STANDARD") {
          destinationValue = [
            { id: configuration["priLink"] },
            { id: configuration["secLink"] },
          ];
        } else {
          destinationValue = [{ id: configuration["priLink"] }];
        }
        cfnInputProps = {
          name: inputName,
          type: configuration["inputType"],
          inputDevices: destinationValue,
        };
        break;

      case "RTP_PUSH":
        cfnInputProps = {
          name: inputName,
          type: configuration["inputType"],
          inputSecurityGroups: [mediaLiveSG.ref],
        };
        break;

      case "RTMP_PUSH":
        if (configuration["channelClass"] == "STANDARD") {
          destinationValue = [
            { streamName: configuration["streamName"] + "/primary" },
            { streamName: configuration["streamName"] + "/secondary" },
          ];
        } else {
          destinationValue = [
            { streamName: configuration["streamName"] + "/primary" },
          ];
        }
        cfnInputProps = {
          name: inputName,
          type: configuration["inputType"],
          inputSecurityGroups: [mediaLiveSG.ref],
          destinations: destinationValue,
        };
        break;

      case "MP4_FILE":
      case "RTMP_PULL":
      case "URL_PULL":
      case "TS_FILE":
        if (configuration["channelClass"] == "STANDARD") {
          destinationValue = [
            { url: configuration["priUrl"] },
            { url: configuration["secUrl"] },
          ];
        } else {
          destinationValue = [{ url: configuration["priUrl"] }];
        }
        cfnInputProps = {
          name: inputName,
          type: configuration["inputType"],
          sources: destinationValue,
        };
        inputSettingsValue = {
          sourceEndBehavior: configuration["sourceEndBehavior"],
        };
        break;

      case "MEDIACONNECT":
        if (configuration["channelClass"] == "STANDARD") {
          destinationValue = [
            { flowArn: configuration["priFlow"] },
            { flowArn: configuration["secFlow"] },
          ];
        } else {
          destinationValue = [{ flowArn: configuration["priFlow"] }];
        }
        cfnInputProps = {
          name: inputName,
          type: configuration["inputType"],
          roleArn: role.roleArn,
          mediaConnectFlows: destinationValue,
        };
        break;
    }

    const mediaLiveInput = new medialive.CfnInput(
      this,
      "MediaInputChannel",
      cfnInputProps
    );

    let params = {
      resolution: "",
      maximumBitrate: "",
    };
    let encoderSettings = null;

    switch (configuration["encodingProfile"]) {
      case "HD-1080p":
        params.resolution = "HD";
        params.maximumBitrate = "MAX_20_MBPS";
        encoderSettings = require("../config/encoding-profiles/hd-1080p-30fps");
        break;
      case "HD-720p":
        params.resolution = "HD";
        params.maximumBitrate = "MAX_10_MBPS";
        encoderSettings = require("../config/encoding-profiles/hd-720p-25fps");
        break;
      case "SD-540p":
        params.resolution = "SD";
        params.maximumBitrate = "MAX_10_MBPS";
        encoderSettings = require("../config/encoding-profiles/sd-540p-30fps");
        break;
      default:
        throw new Error(
          `EncodingProfile is invalid or undefined: ${configuration["encodingProfile"]}`
        );
    }

    const outputGroupType =
      hlsIngestEndpoint1 && hlsIngestEndpoint2
        ? "HLS_OUTPUT_GROUP"
        : "MEDIAPACKAGE_OUTPUT_GROUP";
    let mediaLiveDestination = null;

    if (outputGroupType == "HLS_OUTPUT_GROUP") {
      mediaLiveDestination = {
        id: "media-destination",
        settings: [
          {
            url: hlsIngestEndpoint1,
          },
          {
            url: hlsIngestEndpoint2,
          },
        ],
      };

      encoderSettings.outputGroups[0].outputGroupSettings = {
        hlsGroupSettings: {
          adMarkers: [],
          destination: {
            destinationRefId: "media-destination",
          },
          hlsCdnSettings: {
            hlsBasicPutSettings: {
              connectionRetryInterval: 1,
              filecacheDuration: 300,
              numRetries: 10,
              restartDelay: 15,
            },
          },
          hlsId3SegmentTagging: "ENABLED",
          inputLossAction: "PAUSE_OUTPUT",
          segmentLength: 1,  // 1초 세그먼트로 변경
          minSegmentLength: 1,
          programDateTime: "INCLUDE",
          programDateTimeClock: "SYSTEM_CLOCK",
          programDateTimePeriod: 1,  // 1초로 변경
        },
      };

      const commonOutputSettings = {
        hlsOutputSettings: {
          h265PackagingType: "HVC1",
          hlsSettings: {
            standardHlsSettings: {
              audioRenditionSets: "program_audio",
              m3u8Settings: {  // m3u8Settings 추가
                scte35Behavior: "NO_PASSTHROUGH",
                scte35Pid: "500",
                audioFramesPerPes: 4,
                audioPids: "492-498",
                ecmPid: "8182",
                nielsenId3Behavior: "NO_PASSTHROUGH",
                patInterval: 0,
                pcmControl: "PCR_EVERY_PES_PACKET",
                pcrControl: "PCR_EVERY_PES_PACKET",
                pcrPeriod: 80,
                pcrPid: "481",
                pmtInterval: 0,
                pmtPid: "480",
                programNum: 1,
                scte35Pid: "500",
                timedMetadataBehavior: "NO_PASSTHROUGH",
                timedMetadataPid: "502",
                transportStreamId: 1,
                videoPid: "481"
              },
            },
          },
        },
      };

      for (let i = 0; i < encoderSettings.outputGroups[0].outputs.length; i++) {
        encoderSettings.outputGroups[0].outputs[i].outputSettings =
          commonOutputSettings;
      }
    } else {
      mediaLiveDestination = {
        id: "media-destination",
        mediaPackageSettings: [
          {
            channelId: mediaPackageChannelId,
          },
        ],
        settings: [],
      };
      encoderSettings.outputGroups[0].outputGroupSettings = {
        mediaPackageGroupSettings: {
          destination: {
            destinationRefId: "media-destination",
          },
        },
      };
    }

    const channelLive = new medialive.CfnChannel(this, "MediaLiveChannel", {
      channelClass: configuration["channelClass"],
      destinations: [mediaLiveDestination],
      inputSpecification: {
        codec: configuration.codec,
        resolution: params.resolution,
        maximumBitrate: params.maximumBitrate,
      },
      name: myMediaLiveChannelName,
      roleArn: role.roleArn,
      inputAttachments: [
        {
          inputId: mediaLiveInput.ref,
          inputAttachmentName: inputName,
          inputSettings: inputSettingsValue,
        },
      ],
      encoderSettings: encoderSettings,
    });

    this.channelLive = channelLive;
    this.channelInput = mediaLiveInput;

    new CfnOutput(this, "MyMediaLiveChannelArn", {
      value: this.channelLive.attrArn,
      exportName: Aws.STACK_NAME + "mediaLiveChannelArn",
      description: "The Arn of the MediaLive Channel",
    });

    new CfnOutput(this, "MyMediaLiveChannelInputName", {
      value: inputName,
      exportName: Aws.STACK_NAME + "mediaLiveChannelInputName",
      description: "The Input Name of the MediaLive Channel",
    });

    if (
      ["UDP_PUSH", "RTP_PUSH", "RTMP_PUSH"].includes(configuration["inputType"])
    ) {
      if (configuration["channelClass"] == "STANDARD") {
        new CfnOutput(this, "MyMediaLiveChannelDestPri", {
          value: Fn.join("", [
            Fn.select(0, this.channelInput.attrDestinations),
          ]),
          exportName: Aws.STACK_NAME + "mediaLiveChannelDestPri",
          description: "Primary MediaLive input Url",
        });
        new CfnOutput(this, "MyMediaLiveChannelDestSec", {
          value: Fn.join("", [
            Fn.select(1, this.channelInput.attrDestinations),
          ]),
          exportName: Aws.STACK_NAME + "mediaLiveChannelDestSec",
          description: "Secondary MediaLive input Url",
        });
      } else {
        new CfnOutput(this, "MyMediaLiveChannelDestPri", {
          value: Fn.join("", [
            Fn.select(0, this.channelInput.attrDestinations),
          ]),
          exportName: Aws.STACK_NAME + "mediaLiveChannelDestPri",
          description: "Primary MediaLive input Url",
        });
      }
    }

  }
}

module.exports = { MediaLiveConstruct };
