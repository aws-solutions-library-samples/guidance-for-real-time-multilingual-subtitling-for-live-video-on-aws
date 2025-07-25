// Lambda function for MediaLive input processing
const { MediaLiveClient, ListInputsCommand } = require('@aws-sdk/client-medialive');
const http = require('http');

const medialive = new MediaLiveClient({ region: process.env.AWS_REGION || 'us-east-1' });
const NLB_ENDPOINT = process.env.NLB_ENDPOINT;
const NLB_PORT = process.env.NLB_PORT || '8080';

exports.handler = async (event) => {
    try {
        if (!NLB_ENDPOINT) {
            throw new Error('NLB_ENDPOINT environment variable not set');
        }
        
        let requestBody = {};
        if (event.body) {
            try {
                requestBody = JSON.parse(event.body);
            } catch (e) {
                // Handle parsing error silently
            }
        }
        
        const action = event.action || 'process-video';
        
        // Handle subtitle data requests
        if (action === 'get-subtitles') {
            const subtitlesResponse = await forwardRequestToNLB('/get-subtitles', requestBody);
            return formatResponse(200, subtitlesResponse);
        }
        
        const mediaLiveInputUrl = await getMediaLiveInputUrl();
        const sessionId = requestBody.sessionId || Date.now().toString();
        const videoUrl = requestBody.videoUrl || mediaLiveInputUrl;

        const isEventBridgeCall = event.source === 'aws.medialive' ||
                                 (requestBody.source === 'aws.medialive');

        const processRequestBody = {
            videoUrl: videoUrl,
            sessionId: sessionId,
            sourceType: 'medialive-input',
            triggerSource: isEventBridgeCall ? 'medialive-auto' : 'manual'
        };

        const response = await forwardRequestToNLB('/process-video', processRequestBody);

        return formatResponse(200, {
            success: true,
            message: 'MediaLive input processing started',
            videoUrl: videoUrl,
            sessionId: sessionId,
            fargateResponse: response
        });

    } catch (error) {
        return formatResponse(500, {
            error: 'Server error',
            message: error.message
        });
    }
};

// Get MediaLive input URL
async function getMediaLiveInputUrl() {
    try {
        const command = new ListInputsCommand({});
        const inputsResponse = await medialive.send(command);

        const attachedInput = inputsResponse.Inputs.find(input => {
            return input.State === 'ATTACHED' && 
                   input.Sources && 
                   input.Sources.length > 0;
        });

        if (!attachedInput) {
            throw new Error('No ATTACHED MediaLive input found');
        }

        const inputUrl = attachedInput.Sources[0].Url;
        return inputUrl;
    } catch (error) {
        throw new Error(`MediaLive input query failed: ${error.message}`);
    }
}

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
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const responseData = data ? JSON.parse(data) : {};
                    resolve(responseData);
                } catch (error) {
                    resolve({ message: 'Error processing response', rawResponse: data });
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

        req.write(JSON.stringify(requestBody));
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