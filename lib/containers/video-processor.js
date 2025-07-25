// Lambda function for video processing via API Gateway to Fargate containers
const https = require('https');
const http = require('http');

const NLB_ENDPOINT = process.env.NLB_ENDPOINT;
const NLB_PORT = process.env.NLB_PORT || '8080';
const USE_HTTPS = process.env.USE_HTTPS === 'true';

// Main handler for video processing requests
exports.handler = async (event) => {
    try {
        let requestBody;
        if (event.body) {
            requestBody = JSON.parse(event.body);
        } else {
            requestBody = event;
        }

        // Set default video URL if not provided
        if (!requestBody.videoUrl) {
            requestBody.videoUrl = 'https://dhgd8ucc6ahc0.cloudfront.net/uefa_barcelona_frankfurt_lowres.mp4';
        }

        if (!NLB_ENDPOINT) {
            return formatResponse(500, {
                error: 'Server configuration error',
                message: 'NLB_ENDPOINT environment variable not set'
            });
        }

        const sessionId = Date.now().toString();
        requestBody.sessionId = sessionId;

        const response = await forwardRequestToNLB('/process-video', requestBody);
        response.sessionId = sessionId;

        return formatResponse(200, response);
    } catch (error) {
        return formatResponse(500, {
            error: 'Server error',
            message: error.message
        });
    }
};

// Handler for reset requests
exports.resetHandler = async (event) => {
    try {
        if (!NLB_ENDPOINT) {
            return formatResponse(500, {
                error: 'Server configuration error',
                message: 'NLB_ENDPOINT environment variable not set'
            });
        }

        const response = await forwardRequestToNLB('/reset', {});
        return formatResponse(200, response);
    } catch (error) {
        return formatResponse(500, {
            error: 'Server error',
            message: error.message
        });
    }
};

// Handler for subtitle data requests
exports.getSubtitlesHandler = async (event) => {
    try {
        let requestBody;
        if (event.body) {
            requestBody = JSON.parse(event.body);
        } else {
            requestBody = event;
        }

        if (!NLB_ENDPOINT) {
            return formatResponse(500, {
                error: 'Server configuration error',
                message: 'NLB_ENDPOINT environment variable not set'
            });
        }

        const response = await forwardRequestToNLB('/get-subtitles', requestBody);
        return formatResponse(200, response);
    } catch (error) {
        return formatResponse(500, {
            error: 'Server error',
            message: error.message
        });
    }
};

// Forward requests to Network Load Balancer
async function forwardRequestToNLB(path, requestBody) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: NLB_ENDPOINT,
            port: NLB_PORT,
            path: path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const protocol = USE_HTTPS ? https : http;
        const req = protocol.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const responseData = data ? JSON.parse(data) : {};
                    resolve(responseData);
                } catch (error) {
                    resolve({ message: 'Error processing response' });
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        if (requestBody) {
            req.write(JSON.stringify(requestBody));
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