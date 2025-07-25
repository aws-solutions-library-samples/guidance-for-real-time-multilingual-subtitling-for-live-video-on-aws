// Lambda function for video processing reset
const http = require('http');
const { MediaLiveClient, StopChannelCommand } = require('@aws-sdk/client-medialive');

const NLB_ENDPOINT = process.env.NLB_ENDPOINT;
const NLB_PORT = process.env.NLB_PORT || '8080';
const MEDIALIVE_CHANNEL_ID = process.env.MEDIALIVE_CHANNEL_ID;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

// Stop MediaLive channel
async function stopMediaLiveChannel(channelId) {
    try {
        const medialive = new MediaLiveClient({ region: AWS_REGION });
        const command = new StopChannelCommand({ ChannelId: channelId });
        const response = await medialive.send(command);
        return {
            success: true,
            channelId: channelId,
            state: response.State || 'STOPPING'
        };
    } catch (error) {
        throw new Error(`MediaLive channel stop failed: ${error.message}`);
    }
}

exports.handler = async (event) => {
    try {
        if (!NLB_ENDPOINT) {
            return formatResponse(500, {
                error: 'Server configuration error',
                message: 'NLB_ENDPOINT environment variable not set'
            });
        }

        let requestBody = {};
        if (event.body) {
            try {
                requestBody = JSON.parse(event.body);
            } catch (e) {
                // Handle parsing error silently
            }
        }

        const response = await forwardRequestToNLB('/reset', requestBody);
        
        let mediaLiveResponse = null;
        if (MEDIALIVE_CHANNEL_ID) {
            try {
                mediaLiveResponse = await stopMediaLiveChannel(MEDIALIVE_CHANNEL_ID);
            } catch (mediaLiveError) {
                mediaLiveResponse = {
                    success: false,
                    error: mediaLiveError.message
                };
            }
        } else {
            mediaLiveResponse = {
                success: false,
                message: 'MEDIALIVE_CHANNEL_ID environment variable not set'
            };
        }

        return formatResponse(200, {
            success: true,
            message: 'Video processing reset successfully',
            details: response,
            mediaLive: mediaLiveResponse
        });
    } catch (error) {
        return formatResponse(500, {
            success: false,
            error: 'Server error',
            message: error.message
        });
    }
};

// Forward request to Network Load Balancer
async function forwardRequestToNLB(path, requestBody) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: NLB_ENDPOINT,
            port: parseInt(NLB_PORT),
            path: path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 30000
        };

        const req = http.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const responseData = data ? JSON.parse(data) : {};
                    resolve({
                        statusCode: res.statusCode,
                        data: responseData
                    });
                } catch (error) {
                    resolve({ 
                        statusCode: res.statusCode,
                        message: 'Error processing response',
                        rawData: data
                    });
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });
        
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('NLB request timeout'));
        });

        if (requestBody) {
            req.write(JSON.stringify(requestBody));
        } else {
            req.write(JSON.stringify({}));
        }

        req.end();
    });
}

// Format response for API Gateway
function formatResponse(statusCode, body) {
    return {
        statusCode: statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
        },
        body: JSON.stringify(body)
    };
}