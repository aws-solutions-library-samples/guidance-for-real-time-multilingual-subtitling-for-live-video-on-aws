const AWS = require('aws-sdk');

const dynamodb = new AWS.DynamoDB.DocumentClient({
    maxRetries: 1,
    httpOptions: {
        connectTimeout: 250,
        timeout: 250
    }
});

let DYNAMO_TABLE = 'not-set';
let DYNAMO_INDEX = 'not-set';
let PIPE_ID = 'not-set';
let CAPTION_PASSTHROUGH = false;
let CAPTION_REPLACE = true;
let CAPTION_BUFFER = 2;

function getEnvironmentVariables(customHeaders) {
    try {
        if (customHeaders.dynamo_index) {
            DYNAMO_INDEX = customHeaders.dynamo_index[0].value;
        } else {
            console.error('DYNAMO_INDEX NOT FOUND!');
            return false;
        }
        
        if (customHeaders.dynamo_table) {
            DYNAMO_TABLE = customHeaders.dynamo_table[0].value;
        } else {
            console.error('DYNAMO_TABLE NOT FOUND!');
            return false;
        }
        
        if (customHeaders.pipe_id) {
            PIPE_ID = customHeaders.pipe_id[0].value;
        } else {
            console.error('PIPE_ID NOT FOUND!');
            return false;
        }

        if (customHeaders.caption_passthrough) {
            CAPTION_PASSTHROUGH = customHeaders.caption_passthrough[0].value === 'true';
        }
        
        if (customHeaders.caption_replace) {
            CAPTION_REPLACE = customHeaders.caption_replace[0].value === 'true';
        }
        
        if (customHeaders.caption_buffer) {
            CAPTION_BUFFER = parseInt(customHeaders.caption_buffer[0].value);
        }

        return true;
    } catch (error) {
        console.error('Error getting environment variables:', error);
        return false;
    }
}

async function getLatestCaption(pipeId, langId) {
    const params = {
        TableName: DYNAMO_TABLE,
        IndexName: DYNAMO_INDEX,
        KeyConditionExpression: 'id_lang = :langId',
        ExpressionAttributeValues: {
            ':langId': langId
        },
        ScanIndexForward: false,
        Limit: 5
    };

    try {
        const response = await dynamodb.query(params).promise();
        
        if (!response.Items || response.Items.length === 0) {
            return false;
        }

        // Filter by pipe_id and get the most recent caption
        const filteredItems = response.Items.filter(item => item.id_pipe === pipeId);
        
        if (filteredItems.length === 0) {
            return false;
        }

        let captionString = filteredItems[0].transcript_transcript || filteredItems[0].text;
        const captionDuration = parseFloat(filteredItems[0].transcript_endtime || filteredItems[0].endTime) - 
                               parseFloat(filteredItems[0].transcript_starttime || filteredItems[0].startTime);
        
        if (captionDuration < CAPTION_BUFFER && filteredItems.length > 1) {
            captionString = '';
            for (let i = 0; i < filteredItems.length; i++) {
                const item = filteredItems[i];
                const itemText = item.transcript_transcript || item.text;
                captionString = itemText + '\n' + captionString;
                const itemDuration = parseFloat(item.transcript_endtime || item.endTime) - 
                                   parseFloat(item.transcript_starttime || item.startTime);
                if (itemDuration > CAPTION_BUFFER) {
                    break;
                }
            }
        }

        return captionString.trim();
    } catch (error) {
        console.error('DynamoDB error:', error);
        return false;
    }
}

exports.handler = async (event) => {
    const request = event.Records[0].cf.request;
    const originalRequest = JSON.parse(JSON.stringify(request));
    
    if (request.method !== 'PUT') {
        return originalRequest;
    }
    
    if (!getEnvironmentVariables(request.origin.custom.customHeaders)) {
        return originalRequest;
    }
    
    try {
        request.headers['user-agent'][0].value = 'AWS Lambda';
        
        let originalBody;
        try {
            originalBody = Buffer.from(request.body.data, 'base64').toString('utf-8');
        } catch (error) {
            console.error('Base64 decode error:', error);
            return originalRequest;
        }

        if (CAPTION_PASSTHROUGH) {
            return originalRequest;
        }
        
        if (CAPTION_REPLACE) {
            const lines = originalBody.split('\n');
            const newBody = [];
            let captionDetected = false;
            
            for (const line of lines) {
                if (/\d{2,}:\d{2}:\d{2}\.\d{3} --> \d{2,}:\d{2}:\d{2}\.\d{3}/.test(line)) {
                    captionDetected = true;
                    break;
                } else {
                    newBody.push(line);
                }
            }
            
            newBody.push('');
            if (captionDetected) {
                originalBody = newBody.join('\n');
            }
        } else {
            return originalRequest;
        }
        
        const langMatch = request.uri.match(/index_(\w{2})_\d{1,}\.vtt/);
        if (!langMatch) {
            return originalRequest;
        }
        
        const langId = langMatch[1];
        const latestCaptionText = await getLatestCaption(PIPE_ID, langId);
        
        if (latestCaptionText === false) {
            return originalRequest;
        }

        const vttLines = originalBody.split('\n');
        vttLines.push('00:00:00.000 --> 1000000:00:00.000 line:13 position:5% align:left size:90%');
        vttLines.push(latestCaptionText);
        vttLines.push('');
        
        const vttFile = vttLines.join('\n');
        
        request.body.action = 'replace';
        request.body.encoding = 'text';
        request.body.data = vttFile;
        
        return request;
    } catch (error) {
        console.error('Lambda error:', error);
        return originalRequest;
    }
};