const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const https = require('https');

const client = new DynamoDBClient({});
const dynamoClient = DynamoDBDocumentClient.from(client);

exports.handler = async (event, context) => {
    
    if (!event.pathParameters || !event.pathParameters.proxy) {
        throw new Error('Missing required path parameter: proxy');
    }

    const MEDIAPACKAGE_DOMAIN = process.env.MEDIAPACKAGE_DOMAIN;
    if (!MEDIAPACKAGE_DOMAIN) {
        throw new Error('MEDIAPACKAGE_DOMAIN environment variable is required');
    }
    
    // Configurable WebVTT positioning parameters
    const SUBTITLE_LINE = process.env.SUBTITLE_LINE || '63';
    const SUBTITLE_POSITION = process.env.SUBTITLE_POSITION || '50%';
    const SUBTITLE_ALIGN = process.env.SUBTITLE_ALIGN || 'center';
    const SUBTITLE_SIZE = process.env.SUBTITLE_SIZE || '80%';
    
    const mediapackageUrl = `https://${MEDIAPACKAGE_DOMAIN}/${event.pathParameters.proxy}`;
    console.log('MediaPackage URL:', mediapackageUrl);
    
    let empty_webvtt_chunk = await httpRequest('GET', mediapackageUrl);
   // let empty_webvtt_chunk = `WEBVTT  #Elemental Media Engine(TM) 2.1.3.0
//X-TIMESTAMP-MAP=LOCAL:238:36:33.459,MPEGTS:0

//258:32:05.206 --> 258:32:06.206 line:13 position:5% align:left size:90%
//1755238293775
//06:11:33:775`;
    
    console.log(empty_webvtt_chunk);

    empty_webvtt_chunk = empty_webvtt_chunk.split('\n');
    
    // Update the positioning line with configurable parameters
    const positioningLine = empty_webvtt_chunk.find(line => line.includes('line:') && line.includes('position:'));
    if (positioningLine) {
        const lineIndex = empty_webvtt_chunk.indexOf(positioningLine);
        const timePart = positioningLine.split(' ')[0] + ' --> ' + positioningLine.split(' --> ')[1].split(' ')[0];
        empty_webvtt_chunk[lineIndex] = `${timePart} line:${SUBTITLE_LINE} position:${SUBTITLE_POSITION} align:${SUBTITLE_ALIGN} size:${SUBTITLE_SIZE}`;
    }
    
    const webvtt_creation_time = parseInt(empty_webvtt_chunk[4]) - 30000;
    console.log('Parsed time:', webvtt_creation_time, 'from line:', empty_webvtt_chunk[4]);
    
    if (isNaN(webvtt_creation_time)) {
        throw new Error(`Invalid timestamp in WebVTT: ${empty_webvtt_chunk[4]}`);
    }

    // Extract segment number from filename to determine language
    const segmentMatch = event.pathParameters.proxy.match(/index_(\d+)_/);
    const segmentId = segmentMatch ? segmentMatch[1] : '2';
    
    // Get language mapping from environment (format: "2-hi,3-de,4-guj")
    const languageMapping = process.env.LANGUAGE_MAPPING || '2-en,3-hi,4-guj';
    const langMap = {};
    languageMapping.split(',').forEach(pair => {
        const [id, lang] = pair.split('-');
        langMap[id] = lang;
    });
    
    const lang_id = langMap[segmentId] || 'hi';

    const params = {
        TableName: process.env.DYNAMODB_TABLE_NAME || "SubtitleTable",
        IndexName: 'id_lang-created_time-index',
        ScanIndexForward: false,
        Limit: 1,
        KeyConditionExpression: "id_lang = :lang and created_time < :time",
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
    
    const createdTime = dynamoResponse.Items[0].created_time;
    const date = new Date(createdTime);
    const humanTime = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}:${date.getMilliseconds().toString().padStart(3, '0')}`;
    //let transcription = dynamoResponse.Items[0].content + ` [${createdTime}] [${humanTime}]`;// For time appending
    let transcription = dynamoResponse.Items[0].content;
    //transcription = "temp transcription"
    console.log(transcription);
    
    // Append transcription text to the 5th line (timestamp)
    //empty_webvtt_chunk[4] = empty_webvtt_chunk[4] + " " + transcription;
    empty_webvtt_chunk[4] = transcription;
    empty_webvtt_chunk[5] = '';
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