const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const https = require('https');

const client = new DynamoDBClient({});
const dynamoClient = DynamoDBDocumentClient.from(client);

exports.handler = async (event, context) => {
    
    //console.log('Received event:', JSON.stringify(event, null, 2));

    if (!event.pathParameters || !event.pathParameters.proxy) {
        throw new Error('Missing required path parameter: proxy');
    }

    const MEDIAPACKAGE_DOMAIN = process.env.MEDIAPACKAGE_DOMAIN;
    if (!MEDIAPACKAGE_DOMAIN) {
        throw new Error('MEDIAPACKAGE_DOMAIN environment variable is required');
    }
    
    const mediapackageUrl = `https://${MEDIAPACKAGE_DOMAIN}/${event.pathParameters.proxy}`;
    console.log('MediaPackage URL:', mediapackageUrl);
    
    let empty_webvtt_chunk = await httpRequest('GET', mediapackageUrl);
    
    console.log(empty_webvtt_chunk);

    empty_webvtt_chunk = empty_webvtt_chunk.split('\n');
    //const webvtt_creation_time = parseInt(empty_webvtt_chunk[4]) * 1000;
    const webvtt_creation_time = (parseInt(empty_webvtt_chunk[4]) * 1000) - 15000;
    //const webvtt_creation_time = 1754136432000 * 1000;
    console.log('Parsed time:', webvtt_creation_time, 'from line:', empty_webvtt_chunk[4]);
    
    if (isNaN(webvtt_creation_time)) {
        throw new Error(`Invalid timestamp in WebVTT: ${empty_webvtt_chunk[4]}`);
    }

    // Extract segment number from filename to determine language
    const segmentMatch = event.pathParameters.proxy.match(/index_(\d+)_/);
    const segmentId = segmentMatch ? segmentMatch[1] : '2';
    
    // Get language mapping from environment (format: "2-hi,3-de,4-guj")
    const languageMapping = process.env.LANGUAGE_MAPPING || '2-en,3-hi,4-es,8-ko,6-de';
    const langMap = {};
    languageMapping.split(',').forEach(pair => {
        const [id, lang] = pair.split('-');
        langMap[id] = lang;
    });
    
    const lang_id = langMap[segmentId];

    const params = {
        TableName: process.env.DYNAMODB_TABLE_NAME || "transcripts",
        IndexName: 'id_lang-sort_starttime-index',
        ScanIndexForward: false,
        Limit: 1,
        KeyConditionExpression: "id_lang = :lang and sort_starttime < :time",
        //KeyConditionExpression: "id_lang = :lang",
        ExpressionAttributeValues: {
            ":lang": lang_id,
            ":time": webvtt_creation_time
        }     
    };

    console.log('DynamoDB query params:', params);
    
    const dynamoResponse = await dynamoClient.send(new QueryCommand(params));
    
    if (!dynamoResponse.Items || dynamoResponse.Items.length === 0) {
        console.log('No transcription found, returning empty WebVTT');
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/vtt; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
            },
            body: empty_webvtt_chunk.join('\n')
        };
    }
    
    let transcription = dynamoResponse.Items[0].transcript_transcript;
    console.log(transcription);
    
    // Append transcription text to the 5th line (timestamp)
    //empty_webvtt_chunk[4] = empty_webvtt_chunk[4] + transcription;
    empty_webvtt_chunk[4] = transcription;
    //empty_webvtt_chunk[5] = '';
    const finalWebVTT = empty_webvtt_chunk.join('\n');
    console.log("==empty_webvtt_chunk: ", finalWebVTT);
    
    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'text/vtt; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
        },
        body: finalWebVTT
    };
}

function httpRequest(method, url, data) {

  const options = {
    method: method,
    timeout: 15000, // in ms
    headers: {
        'Content-Type': 'text/vtt; charset=UTF-8'
    }
  }
  let dataString='';
  if (data) {
    dataString = JSON.stringify(data)
    options.headers = {
      'Content-Type': 'text/vtt; charset=UTF-8',
      'Content-Length': dataString.length,
    }
  }
  
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      if (res.statusCode < 200 || res.statusCode > 299) {
        return reject(new Error(`HTTP status code ${res.statusCode}`))
      }

      var body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk)
      res.on('end', () => {
        //const resString = JSON.parse(body);
        resolve(body)
      })
    })

    req.on('error', (err) => {
      reject(err)
    })

    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request time out'))
    })

    req.write(dataString)
    req.end()
  })
}