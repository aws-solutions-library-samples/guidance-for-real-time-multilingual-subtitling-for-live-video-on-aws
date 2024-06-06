const stream = require('stream');
const { exit } = require('process');

// Amazon Transcribe SDK Setup
const { 
    TranscribeStreamingClient, 
    StartStreamTranscriptionCommand,
} = require("@aws-sdk/client-transcribe-streaming");
const transcribeClient = new TranscribeStreamingClient()
// DynamoDB Setup
let AWS = require('aws-sdk');
const dynamoClient = new AWS.DynamoDB.DocumentClient();

// Setup Environment Variables
const TABLE_NAME = process.env.TABLE_NAME;
const VOCABULARYNAME = process.env.VOCABULARY_NAME;
const LANGUAGECODE = process.env.LANGUAGE_CODE;
const MEDIA_ENCODING = 'pcm';
const SAMPLE_RATE = 16000;
//const VOCABULARYFILTERNAME = process.env.VOCABULARY_FILTER_NAME;
//const VOCABULARYFILTERMETHOD = process.env.VOCABULARY_FILTER_METHOD;

///////////////////////////// STARTING ////////////////////////////// 

startStreamingWrapper();

async function startStreamingWrapper(){
	try {
		// ...then we convert the ffmpeg audio stream to binary event stream messages when the promise resolves 
		await streamAudioToTranscribe();
		console.log("Done");
	} catch (error) {
		console.log(error);
	} finally {
		// Exit the program gracefully
		console.log("Exiting Program");
		exit();
	}
}

async function streamAudioToTranscribe() {

	const passthroughStream = new stream.PassThrough({ highWaterMark: 128 }); //4096 maybe better chunk size for audio 16kHz linear PCM

	// stdin reading
	process.stdin
    .on('data', (data) => {
	  //console.log('### stdin data:', data);
      // this is audio data from ffmpeg
      passthroughStream.write(data);
    })
	.on('error', (error) => {
		console.log('stdin error:', error);
	})
    .on('end', () => {
      // do something when the stream stops
	  console.log('stdin end');
    });	

    const transcribeInput = async function* transcribeInput() {
		try{
			for await(const chunk of passthroughStream) {
				//console.log('### passthroughStream chunk:', chunk);
				yield {AudioEvent: {AudioChunk: chunk}}
			}
		} catch (error) {
			console.log('Error reading passthrough stream or yielding audio chunk.', error);
		}
    };

	// start Amazon Transcribe streaming session
    const res = await transcribeClient.send(new StartStreamTranscriptionCommand({
        LanguageCode: LANGUAGECODE,
        MediaSampleRateHertz: SAMPLE_RATE,
        MediaEncoding: MEDIA_ENCODING,
        VocabularyName: VOCABULARYNAME,
        //VocabularyFilterName: VOCABULARYFILTERNAME,
        //VocabularyFilterMethod: VOCABULARYFILTERMETHOD,
        AudioStream: transcribeInput()
    }));
	const transcribeStream = stream.Readable.from(res.TranscriptResultStream);
       
	try {
	   // eslint-disable-next-line no-restricted-syntax
	   for await (const chunk of transcribeStream) {
		 // console.log(JSON.stringify(chunk));
		 	if (chunk.TranscriptEvent.Transcript.Results.length > 0) {
				var results = chunk.TranscriptEvent.Transcript.Results[0];
		   		console.log(results.StartTime.toFixed(2), results.EndTime.toFixed(2), results.Alternatives[0].Transcript);

				// Write to DynamoDB
				const requestStartTime = timestamp_millis();
				var milliseconds = timestamp_millis();
				var timestamp = parseInt(Math.floor(milliseconds / 1000));
				var timestamp_ttl = timestamp + 600;
				var resultsStartTime = String(results.StartTime.toFixed(2));
				var resultsEndTime = String(results.EndTime.toFixed(2));
				var sortStartTime = (timestamp_millis() * 1000); 
				var params = {
					TableName : TABLE_NAME,
					Item: {
							// Ware 
							id_name: results.ResultId,
							id_status: "ready",
							sort_starttime: sortStartTime,
							id_session: String(requestStartTime),
							id_pipe: "pipe0", // live streaming channel ID - hard coded for now
							id_lang: LANGUAGECODE,
							timestamp_created: timestamp,
							timestamp_ttl: timestamp_ttl,

							//  ITEM 
							item_list: results.Alternatives[0].Items,

							// TRANSCRIPT 
							transcript_transcript: results.Alternatives[0].Transcript,
							transcript_starttime: resultsStartTime,
							transcript_endtime: resultsEndTime,
							transcript_resultid: String(results.ResultId),
							transcript_ispartial: results.IsPartial
						}
					};

				dynamoClient.put(params, function(error, data) {
					if (error){
						console.log('ERROR on DynamoDB:', error);
					}
				});
		 	}
	    }
	} catch (error) {
		console.log('ERROR:', error);
		exit();
	} 		   
}

function convertToMilliseconds(time){
	return parseInt(time % 1 * 1000 + Math.floor(time)*1000);
}

function roundToTenthMillisecond(number){
	return (Math.round(number * 10) / 10).toFixed(1);
}

function timestamp_millis(){
	return parseInt(Date.now(), 10);
}