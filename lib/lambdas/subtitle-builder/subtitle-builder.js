const AWS = require('aws-sdk');
const dynamoClient = new AWS.DynamoDB.DocumentClient();
const https = require("https");

exports.handler = async (event, context) => {
    
    console.log('Received event:', JSON.stringify(event, null, 2));

    const MEDIAPACKAGE_URL = process.env.MEDIAPACKAGE_URL || "https://15595674c0604ed6.mediapackage.eu-central-1.amazonaws.com/out/v1/";
    

    let empty_webvtt_chunk = await httpRequest('GET', MEDIAPACKAGE_URL + event.pathParameters.id + "/" + event.pathParameters.manifest)
    
    console.log(empty_webvtt_chunk);

    empty_webvtt_chunk = empty_webvtt_chunk.split('\n')
    const webvtt_creation_time = parseInt(empty_webvtt_chunk.splice(4))
    console.log(webvtt_creation_time);

    //TODO get lang_id from request
    /*
    r = re.search(r'channel_(\w{2})_\d{1,}\.vtt', request['uri'])
    if not r: 
        print("ERROR REGEX for lang_id failed, skipping autocaptions")
        put_count_metrics('error_lambda', 1, PIPE_ID, 'unknown')
        return untouched_request
    lang_id = r.group(1)
    */
    const lang_id = 'de'

    const params = {
        TableName: "transcripts",
        IndexName: 'id_lang-sort_starttime-index',
        ScanIndexForward: false,
        Limit: 1,
        KeyConditionExpression: "id_lang = :lang and sort_starttime < :time",
        ExpressionAttributeValues: {
            ":lang": lang_id,
            ":time": webvtt_creation_time
        }     
    };
    
    const dynamoResponse = await dynamoClient.query(params).promise();
    
    let transcription = dynamoResponse.Items[0].transcript_transcript;
    console.log(transcription)
    
    //append transcription as subtitle in empty webvtt chunk
    empty_webvtt_chunk.push(transcription)
    empty_webvtt_chunk.push('')
    empty_webvtt_chunk = empty_webvtt_chunk.join('\n')
    return empty_webvtt_chunk                
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