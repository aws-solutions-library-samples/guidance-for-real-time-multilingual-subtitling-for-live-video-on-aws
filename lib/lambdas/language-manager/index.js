const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { LambdaClient, GetFunctionConfigurationCommand, UpdateFunctionConfigurationCommand } = require('@aws-sdk/client-lambda');

const ddbClient = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(ddbClient);
const lambdaClient = new LambdaClient({});

const LANGUAGE_CONFIG_TABLE = process.env.LANGUAGE_CONFIG_TABLE || 'LanguageConfigTable';
const WEBVTT_LAMBDA_NAME = process.env.WEBVTT_LAMBDA_NAME || '';

exports.handler = async (event) => {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
    };

    try {
        const method = event.httpMethod;
        const pathParams = event.pathParameters;

        if (method === 'GET') {
            return await handleGetLanguages(headers);
        } else if (method === 'POST') {
            const body = JSON.parse(event.body || '{}');
            return await handleAddLanguage(body, headers);
        } else if (method === 'DELETE' && pathParams?.code) {
            return await handleRemoveLanguage(pathParams.code, headers);
        }

        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
    } catch (error) {
        console.error('Error:', error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};

async function handleGetLanguages(headers) {
    const result = await dynamodb.send(new ScanCommand({ TableName: LANGUAGE_CONFIG_TABLE }));
    const items = result.Items || [];

    const active = items.filter(i => i.active).sort((a, b) => a.segment_id - b.segment_id);
    const available = items.filter(i => !i.active).sort((a, b) => a.segment_id - b.segment_id);

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            active: active.map(i => ({ language_code: i.language_code, name: i.name, segment_id: i.segment_id })),
            available: available.map(i => ({ language_code: i.language_code, name: i.name, segment_id: i.segment_id })),
            total_slots: items.length,
            used_slots: active.length
        })
    };
}

async function handleAddLanguage(body, headers) {
    const { code } = body;
    if (!code) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'language code is required' }) };
    }

    // Check if language exists in pre-defined table
    const existing = await dynamodb.send(new GetCommand({
        TableName: LANGUAGE_CONFIG_TABLE,
        Key: { language_code: code }
    }));

    if (!existing.Item) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Pre-defined language not found' }) };
    }

    if (existing.Item.active) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Language already active' }) };
    }

    // Activate language
    await dynamodb.send(new UpdateCommand({
        TableName: LANGUAGE_CONFIG_TABLE,
        Key: { language_code: code },
        UpdateExpression: 'SET active = :active',
        ExpressionAttributeValues: { ':active': true }
    }));

    // Rebuild LANGUAGE_MAPPING from DynamoDB (Single Source of Truth)
    const verified = await rebuildAndVerifyLanguageMapping(code, true);

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            language_code: code,
            name: existing.Item.name,
            segment_id: existing.Item.segment_id,
            status: 'active',
            verified
        })
    };
}

async function handleRemoveLanguage(code, headers) {
    // Prevent removing English (source language)
    if (code === 'en') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Cannot remove source language (en)' }) };
    }

    const existing = await dynamodb.send(new GetCommand({
        TableName: LANGUAGE_CONFIG_TABLE,
        Key: { language_code: code }
    }));

    if (!existing.Item) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Language not found' }) };
    }

    if (!existing.Item.active) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Language already inactive' }) };
    }

    // Deactivate language
    await dynamodb.send(new UpdateCommand({
        TableName: LANGUAGE_CONFIG_TABLE,
        Key: { language_code: code },
        UpdateExpression: 'SET active = :active',
        ExpressionAttributeValues: { ':active': false }
    }));

    // Rebuild LANGUAGE_MAPPING from DynamoDB
    const verified = await rebuildAndVerifyLanguageMapping(code, false);

    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            language_code: code,
            status: 'inactive',
            verified
        })
    };
}

async function rebuildAndVerifyLanguageMapping(changedCode, shouldBeActive) {
    if (!WEBVTT_LAMBDA_NAME) {
        console.warn('WEBVTT_LAMBDA_NAME not set, skipping env var update');
        return false;
    }

    // Scan all active languages from DynamoDB (Single Source of Truth)
    const result = await dynamodb.send(new ScanCommand({
        TableName: LANGUAGE_CONFIG_TABLE,
        FilterExpression: 'active = :active',
        ExpressionAttributeValues: { ':active': true }
    }));

    const activeLanguages = (result.Items || []).sort((a, b) => a.segment_id - b.segment_id);
    const newMapping = activeLanguages.map(l => `${l.segment_id}-${l.language_code}`).join(',');

    console.log('New LANGUAGE_MAPPING:', newMapping);

    // Get current function configuration
    const currentConfig = await lambdaClient.send(new GetFunctionConfigurationCommand({
        FunctionName: WEBVTT_LAMBDA_NAME
    }));

    const currentEnv = currentConfig.Environment?.Variables || {};
    currentEnv.LANGUAGE_MAPPING = newMapping;

    // Update Lambda environment variables
    await lambdaClient.send(new UpdateFunctionConfigurationCommand({
        FunctionName: WEBVTT_LAMBDA_NAME,
        Environment: { Variables: currentEnv }
    }));

    // Verify the update (retry up to 3 times)
    for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));

        const updatedConfig = await lambdaClient.send(new GetFunctionConfigurationCommand({
            FunctionName: WEBVTT_LAMBDA_NAME
        }));

        const updatedMapping = updatedConfig.Environment?.Variables?.LANGUAGE_MAPPING || '';
        const lastUpdateStatus = updatedConfig.LastUpdateStatus;

        if (shouldBeActive) {
            if (updatedMapping.includes(`-${changedCode}`) && lastUpdateStatus === 'Successful') {
                console.log(`Verified: ${changedCode} added to LANGUAGE_MAPPING`);
                return true;
            }
        } else {
            if (!updatedMapping.includes(`-${changedCode}`) && lastUpdateStatus === 'Successful') {
                console.log(`Verified: ${changedCode} removed from LANGUAGE_MAPPING`);
                return true;
            }
        }

        console.log(`Verification attempt ${attempt + 1} - Status: ${lastUpdateStatus}, Mapping: ${updatedMapping}`);
    }

    console.warn('Verification failed after 3 attempts');
    return false;
}
