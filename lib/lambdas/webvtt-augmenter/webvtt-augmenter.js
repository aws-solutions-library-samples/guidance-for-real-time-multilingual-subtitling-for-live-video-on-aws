exports.handler = async (event, context) => {
    
    var request = event['Records'][0]['cf']['request'];

    var empty_webvtt_chunk = Buffer.from(request['body']['data'], 'base64').toString('utf-8');
    console.log(empty_webvtt_chunk);
  
    empty_webvtt_chunk = empty_webvtt_chunk.split('\n')
    empty_webvtt_chunk.push("00:00:00.000 --> 1000000:00:00.000 line:13 position:5% align:left size:90%")
    empty_webvtt_chunk.push(parseInt(Math.floor(parseInt(Date.now(), 10) * 1000)))
    empty_webvtt_chunk.push('')
    empty_webvtt_chunk = empty_webvtt_chunk.join('\n')
    
    console.log(empty_webvtt_chunk)
    request['body']['action'] = 'replace'
    //request['body']['encoding'] = 'text' //only if you do not encode the vtt to base64 again
    request['body']['data'] = Buffer.from(empty_webvtt_chunk, 'utf-8').toString('base64');
    
    console.log(request);
    
    return request;
};