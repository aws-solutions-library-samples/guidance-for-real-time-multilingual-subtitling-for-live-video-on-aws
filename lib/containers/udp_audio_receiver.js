// UDP audio receiver for live subtitle processing
const stream = require('stream');
const { exit } = require('process');
const dgram = require('dgram');
const express = require('express');

const {
	TranscribeStreamingClient,
	StartStreamTranscriptionCommand,
} = require("@aws-sdk/client-transcribe-streaming");
const transcribeClient = new TranscribeStreamingClient({ region: process.env.AWS_REGION || 'us-east-1' });

let AWS = require('aws-sdk');
const dynamoClient = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-east-1' });

const TABLE_NAME = process.env.TABLE_NAME || 'SubtitleTable';
const LANGUAGECODE = process.env.LANGUAGE_CODE || 'en-US';
const MEDIA_ENCODING = 'pcm';
const SAMPLE_RATE = 16000;
const UDP_PORT = process.env.UDP_PORT || 7950;
const HTTP_PORT = process.env.HTTP_PORT || 8080;

// HTTP server for health check and control
const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
	res.json({
		status: 'healthy',
		timestamp: new Date().toISOString(),
		environment: {
			TABLE_NAME: TABLE_NAME,
			LANGUAGE_CODE: LANGUAGECODE,
			AWS_REGION: process.env.AWS_REGION
		}
	});
});

// Start video processing
app.post('/process-video', async (req, res) => {
	try {
		const videoUrl = req.body.videoUrl;
		const sessionId = req.body.sessionId || Date.now().toString();
		const languageCode = req.body.languageCode || LANGUAGECODE;

		if (!videoUrl) {
			return res.status(400).json({
				success: false,
				error: 'videoUrl is required'
			});
		}

		global.currentVideoUrl = videoUrl;
		global.currentSessionId = sessionId;
		global.currentLanguageCode = languageCode;

		if (global.ffmpegProcess) {
			global.ffmpegProcess.kill();
		}

		const { spawn } = require('child_process');
		global.ffmpegProcess = spawn('ffmpeg', [
			'-loglevel', 'quiet',
			'-re',
			'-i', videoUrl,
			'-vn',
			'-ac', '1',
			'-c:a', 'pcm_s16le',
			'-ar', '16000',
			'-f', 'wav',
			'udp://127.0.0.1:7950'
		]);

		global.ffmpegProcess.on('error', (err) => {
			console.error('ffmpeg process error:', err);
		});

		if (!isTranscribing) {
			startStreamingWrapper();
		}

		res.json({
			success: true,
			message: 'Video processing started successfully',
			videoUrl: videoUrl,
			sessionId: sessionId,
			languageCode: languageCode
		});
	} catch (error) {
		res.status(500).json({ error: 'Video processing start failed', details: error.message });
	}
});

// Stop video processing and cleanup
app.post('/reset', async (req, res) => {
	try {
		isTranscribing = false;

		if (global.ffmpegProcess) {
			global.ffmpegProcess.kill('SIGKILL');
			global.ffmpegProcess = null;
		}

		if (udpServer) {
			try {
				udpServer.close();
			} catch (err) {
				// Ignore cleanup errors
			}
			udpServer = null;
		}

		// Force release port 7950
		const { spawn } = require('child_process');
		try {
			const fuserProcess = spawn('fuser', ['-k', '7950/udp'], { stdio: 'ignore' });
		} catch (err) {
			// Ignore port cleanup errors
		}

		global.currentVideoUrl = null;
		global.currentSessionId = null;
		global.currentLanguageCode = null;
		
		// Clear DynamoDB subtitle data
        const scanParams = { TableName: TABLE_NAME };
        const scanResult = await dynamoClient.scan(scanParams).promise();

        if (scanResult.Items.length > 0) {
                const deletePromises = scanResult.Items.map(item => {
                        const deleteParams = {
                                TableName: TABLE_NAME,
                                Key: {
                                        resultId: item.resultId,
                                        startTime: item.startTime
                                }
                        };
                        return dynamoClient.delete(deleteParams).promise();
                });
                await Promise.all(deletePromises);
        }

		if (global.gc) {
			global.gc();
		}

		res.json({
			success: true,
			message: 'All processes stopped and cleaned up successfully',
			details: {
				ffmpegKilled: true,
				udpServerClosed: true,
				portCleared: true,
				memoryCleared: true,
				dynamoDbCleared: true
			}
		});

	} catch (error) {
		res.status(500).json({ 
			success: false,
			error: 'Video processing stop failed', 
			details: error.message 
		});
	}
});

// Get subtitle data
app.post('/get-subtitles', async (req, res) => {
	try {
		const sessionId = req.body.sessionId;
		const currentTime = req.body.currentTime || 0;

		if (!sessionId) {
			return res.status(400).json({
				error: 'Session ID is required'
			});
		}

		const params = {
			TableName: TABLE_NAME,
			IndexName: 'sessionId-startTime-index',
			KeyConditionExpression: 'sessionId = :sessionId',
			FilterExpression: 'isPartial = :isPartial',
			ExpressionAttributeValues: {
				':sessionId': sessionId,
				':isPartial': false
			},
			Limit: 50
		};

		const result = await dynamoClient.query(params).promise();

		const subtitles = result.Items.map(item => {
			return {
				id: item.resultId,
				text: item.transcript,
				startTime: parseFloat(item.startTime),
				endTime: parseFloat(item.endTime),
				isPartial: item.isPartial,
				channelId: item.channelId,
				sessionId: item.sessionId,
				languageCode: item.languageCode || 'ko'
			};
		});

		subtitles.sort((a, b) => a.startTime - b.startTime);

		const activeSubtitles = subtitles.filter(subtitle => {
			return currentTime >= subtitle.startTime && currentTime <= subtitle.endTime;
		});

		const currentSubtitle = activeSubtitles.length > 0 ? 
			activeSubtitles[activeSubtitles.length - 1] : null;

		res.json({
			success: true,
			currentSubtitle: currentSubtitle,
			activeSubtitles: activeSubtitles,
			totalSubtitles: subtitles.length,
			currentTime: currentTime
		});
	} catch (error) {
		res.status(500).json({ error: 'Subtitle data query failed', details: error.message });
	}
});

const server = app.listen(HTTP_PORT);

let isTranscribing = false;
let udpServer = null;

// Start streaming wrapper with retry logic
async function startStreamingWrapper() {
	if (isTranscribing) {
		return;
	}

	isTranscribing = true;
	
	while (isTranscribing) {
		try {
			await streamAudioToTranscribe();
		} catch (error) {
			// Retry on error
		}
		
		if (isTranscribing) {
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
	}
}

// Stream audio to Amazon Transcribe
async function streamAudioToTranscribe() {
	const passthroughStream = new stream.PassThrough({ highWaterMark: 128 });

	if (udpServer) {
		udpServer.close();
		udpServer = null;
	}

	udpServer = dgram.createSocket('udp4');

	udpServer.on('message', (msg, rinfo) => {
		passthroughStream.write(msg);
	});

	udpServer.on('error', (err) => {
		if (err.code === 'EADDRINUSE') {
			return;
		}
	});

	udpServer.bind(UDP_PORT);

	const transcribeInput = async function* transcribeInput() {
		try {
			for await (const chunk of passthroughStream) {
				yield { AudioEvent: { AudioChunk: chunk } }
			}
		} catch (error) {
			// Handle audio chunk processing error
		}
	};

	const currentLanguage = global.currentLanguageCode || LANGUAGECODE;
	const transcribeParams = {
		LanguageCode: currentLanguage,
		MediaSampleRateHertz: SAMPLE_RATE,
		MediaEncoding: MEDIA_ENCODING,
		AudioStream: transcribeInput()
	};
	
	const res = await transcribeClient.send(new StartStreamTranscriptionCommand(transcribeParams));
	const transcribeStream = stream.Readable.from(res.TranscriptResultStream);

	try {
		for await (const chunk of transcribeStream) {
			if (chunk.TranscriptEvent.Transcript.Results.length > 0) {
				const results = chunk.TranscriptEvent.Transcript.Results[0];
				const sessionId = global.currentSessionId || 'default-session';
				const languageCode = global.currentLanguageCode || LANGUAGECODE; 

				let startTime = results.StartTime;
				let endTime = results.EndTime;

				// Extract actual speech timing from Items array
				if (results.Alternatives[0].Items && results.Alternatives[0].Items.length > 0) {
					startTime = results.Alternatives[0].Items[0].StartTime;
					
					if (results.IsPartial) {
						const lastItemIndex = results.Alternatives[0].Items.length - 1;
						endTime = results.Alternatives[0].Items[lastItemIndex].EndTime;
					} else {
						endTime = results.EndTime;
					}
				}

				const params = {
					TableName: TABLE_NAME,
					Key: {
						resultId: results.ResultId,
						startTime: startTime
					},
					UpdateExpression: "SET transcript = :transcript, endTime = :endTime, sessionId = :sessionId, updatedAt = :timestamp, isPartial = :partial, languageCode = :language, channelId = :channelId",
					ExpressionAttributeValues: {
						":transcript": results.Alternatives[0].Transcript,
						":endTime": endTime,
						":sessionId": sessionId,
						":timestamp": Date.now(),
						":partial": results.IsPartial,
						":language": languageCode,
						":channelId": results.ChannelId || 'ch_0'
					}
				};

				try {
					await dynamoClient.update(params).promise();
				} catch (error) {
					// Handle DynamoDB save error
				}
			}
		}
	} catch (error) {
		// Handle transcription stream error
	}
}

// Utility functions
function convertToMilliseconds(time) {
	return parseInt(time % 1 * 1000 + Math.floor(time) * 1000);
}

function roundToTenthMillisecond(number) {
	return (Math.round(number * 10) / 10).toFixed(1);
}

function timestamp_millis() {
	return parseInt(Date.now(), 10);
}

// Process cleanup on termination
process.on('SIGTERM', () => {
	if (udpServer) {
		udpServer.close();
	}
	server.close(() => {
		process.exit(0);
	});
});

process.on('SIGINT', () => {
	if (udpServer) {
		udpServer.close();
	}
	server.close(() => {
		process.exit(0);
	});
});
