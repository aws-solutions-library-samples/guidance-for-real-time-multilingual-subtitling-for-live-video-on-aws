const AWS = require('aws-sdk');

const MEDIACONNECT_FLOW_ARN = process.env.MEDIACONNECT_FLOW_ARN;
const SUBTITLE_TABLE_NAME = process.env.SUBTITLE_TABLE_NAME || 'SubtitleTable';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const mediaconnect = new AWS.MediaConnect({ region: AWS_REGION });
const dynamoClient = new AWS.DynamoDB.DocumentClient({ region: AWS_REGION });

async function stopMediaConnectFlow() {
    try {
        if (!MEDIACONNECT_FLOW_ARN) return { success: false, message: 'No flow ARN' };
        await mediaconnect.stopFlow({ FlowArn: MEDIACONNECT_FLOW_ARN }).promise();
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function deleteAllDynamoDBItems() {
    try {
        let lastEvaluatedKey = undefined;
        let deletedCount = 0;

        do {
            const scanParams = { TableName: SUBTITLE_TABLE_NAME };
            if (lastEvaluatedKey) {
                scanParams.ExclusiveStartKey = lastEvaluatedKey;
            }

            const scanResult = await dynamoClient.scan(scanParams).promise();
            
            if (scanResult.Items && scanResult.Items.length > 0) {
                const deletePromises = scanResult.Items.map(item => {
                    return dynamoClient.delete({
                        TableName: SUBTITLE_TABLE_NAME,
                        Key: {
                            id_name: item.id_name,
                            id_lang: item.id_lang
                        }
                    }).promise();
                });
                
                await Promise.all(deletePromises);
                deletedCount += scanResult.Items.length;
            }

            lastEvaluatedKey = scanResult.LastEvaluatedKey;
        } while (lastEvaluatedKey);

        return { success: true, deletedCount };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

exports.handler = async (event) => {
    const [mediaConnectResult, dynamoResult] = await Promise.allSettled([
        stopMediaConnectFlow(),
        deleteAllDynamoDBItems()
    ]);

    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
        },
        body: JSON.stringify({
            success: true,
            mediaConnect: mediaConnectResult.status === 'fulfilled' ? mediaConnectResult.value : { success: false },
            dynamoDB: dynamoResult.status === 'fulfilled' ? dynamoResult.value : { success: false }
        })
    };
};
