const AWS = require('aws-sdk');
const https = require("https");

exports.handler = async (event, context, callback) => {
    
    console.log('Received event:', JSON.stringify(event, null, 2));

    const MEDIAPACKAGE_URL = process.env.MEDIAPACKAGE_URL || "https://15595674c0604ed6.mediapackage.eu-central-1.amazonaws.com/out/v1/";

    const params = {
        TableName: "transcripts",//'las-CaptionsDynamoTable-2HA00AWRS4KT',
        IndexName: 'id_lang-sort_starttime-index',
        ScanIndexForward: false,
        Limit: 1,
        KeyConditionExpression: "id_lang = :lang",
        ExpressionAttributeValues: {
            ":lang": "en"
        }     
    };

    let empty_webvtt_chunk = await httpRequest('GET', MEDIAPACKAGE_URL + event.pathParameters.id + "/" + event.pathParameters.manifest)
    console.log(empty_webvtt_chunk);

    let dynamo = AWS.dynamo();

    setTimeout(function () {                
        dynamo.query(params, (err, data) => {
            if (err) {
                console.log(err);
            } else {
                let transcription = data.Items[0].transcript_transcript;
                console.log(transcription)
                empty_webvtt_chunk = empty_webvtt_chunk.split('\n')
                empty_webvtt_chunk.splice(4)
                empty_webvtt_chunk.push('#' + transcription)
                empty_webvtt_chunk.push('')
                empty_webvtt_chunk = empty_webvtt_chunk.join('\n')
                callback(null, empty_webvtt_chunk)                
            }
        });
    }, 1000);
    
    return {};
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