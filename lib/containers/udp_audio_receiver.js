// UDP audio receiver for live subtitle processing
const stream = require('stream');
const dgram = require('dgram');
const express = require('express');

const {
	TranscribeStreamingClient,
	StartStreamTranscriptionCommand,
} = require("@aws-sdk/client-transcribe-streaming");
const { TranslateClient, TranslateTextCommand } = require("@aws-sdk/client-translate");
const transcribeClient = new TranscribeStreamingClient({ region: process.env.AWS_REGION || 'us-east-1' });
const translateClient = new TranslateClient({ region: process.env.AWS_REGION || 'us-east-1' });

let AWS = require('aws-sdk');
const dynamoClient = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-east-1' });

const TABLE_NAME = process.env.TABLE_NAME || 'SubtitleTable';
const LANGUAGECODE = process.env.LANGUAGE_CODE || 'en-US';
const MEDIA_ENCODING = 'pcm';
const SAMPLE_RATE = 16000;
const UDP_PORT = process.env.UDP_PORT || 7950;
const HTTP_PORT = process.env.HTTP_PORT || 8080;

// Translation configuration
const ENABLE_TRANSLATION = process.env.ENABLE_TRANSLATION === 'true';
const SOURCE_LANGUAGE = process.env.SOURCE_LANGUAGE || 'en';
const CAPTION_LANGUAGES = process.env.CAPTION_LANGUAGES || 'en,ko';
const ID_PIPE = process.env.ID_PIPE || 'pipe0';

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
		},
		translation: {
			enabled: ENABLE_TRANSLATION,
			sourceLanguage: SOURCE_LANGUAGE,
			targetLanguages: CAPTION_LANGUAGES.split(',').map(lang => lang.trim())
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
                                        id_name: item.id_name,
                                        id_lang: item.id_lang
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

		const targetLanguage = req.body.language || 'en';
		
		const params = {
			TableName: TABLE_NAME,
			IndexName: 'id_lang-sort_starttime-index',
			KeyConditionExpression: 'id_lang = :language',
			FilterExpression: 'id_session = :sessionId AND transcript_ispartial = :isPartial',
			ExpressionAttributeValues: {
				':language': targetLanguage,
				':sessionId': sessionId,
				':isPartial': false
			},
			ScanIndexForward: false,
			Limit: 50
		};

		const result = await dynamoClient.query(params).promise();

		const subtitles = result.Items.map(item => {
			return {
				id: item.id_name,
				text: item.transcript_transcript,
				startTime: parseFloat(item.transcript_starttime),
				endTime: parseFloat(item.transcript_endtime),
				isPartial: item.transcript_ispartial,
				sessionId: item.id_session,
				languageCode: item.id_lang,
				pipeId: item.id_pipe
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

app.get('/languages', (req, res) => {
	const availableLanguages = ENABLE_TRANSLATION ? 
		CAPTION_LANGUAGES.split(',').map(lang => ({
			code: lang.trim(),
			name: getLanguageName(lang.trim())
		})) : [{ code: 'en', name: 'English' }];

	res.json({
		success: true,
		translationEnabled: ENABLE_TRANSLATION,
		sourceLanguage: SOURCE_LANGUAGE,
		availableLanguages: availableLanguages
	});
});

// 언어 이름 매핑 함수
function getLanguageName(code) {
	const languageNames = {
		'en': 'English',
		'ko': '한국어',
		'ja': '日本語',
		'es': 'Español',
		'fr': 'Français',
		'de': 'Deutsch',
		'hi': 'हिन्दी',
		'zh': '中文'
	};
	return languageNames[code] || code.toUpperCase();
}

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

				// Convert to Python schema format
				const timestamp = Math.floor(Date.now() / 1000);
				const sortStartTime = Date.now() * 1000;
				
				const params = {
					TableName: TABLE_NAME,
					Item: {
						id_name: results.ResultId,
						id_status: "ready",
						sort_starttime: sortStartTime,
						id_session: sessionId,
						id_pipe: ID_PIPE,
						id_lang: languageCode.split('-')[0], // 'en-US' -> 'en'
						timestamp_created: timestamp,
						timestamp_ttl: timestamp + 1800, // 30 minutes TTL
						transcript_transcript: results.Alternatives[0].Transcript,
						transcript_starttime: String(startTime.toFixed(2)),
						transcript_endtime: String(endTime.toFixed(2)),
						transcript_resultid: String(results.ResultId),
						transcript_ispartial: results.IsPartial
					}
				};

				try {
					await dynamoClient.put(params).promise();
					
					// 👇 번역 처리 추가
					if (ENABLE_TRANSLATION && !results.IsPartial) {
						await processTranslations(params.Item);
					}
				} catch (error) {
					console.error('DynamoDB save error:', error);
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

async function getTranslation(sourceLang, targetLang, text) {
    try {
        const command = new TranslateTextCommand({
            Text: text,
            SourceLanguageCode: sourceLang,
            TargetLanguageCode: targetLang
        });
        const response = await translateClient.send(command);
        return response.TranslatedText;
    } catch (error) {
        console.error("Translation error:", error);
        return text;
    }
}

async function makeAllTranscriptions(text, languages, sourceLang) {
    const transcripts = {};
    for (const lang of languages) {
        if (lang !== sourceLang) {
            const translation = await getTranslation(sourceLang, lang, text);
            console.log(`${lang}: ${translation}`);
            transcripts[lang] = translation;
        }
    }
    return transcripts;
}

async function processTranslations(originalItem) {
    if (!ENABLE_TRANSLATION) {
        return;
    }

    const languages = CAPTION_LANGUAGES.split(',').map(lang => lang.trim());
    const uniqueLanguages = [...new Set(languages)];
    
    const text = originalItem.transcript_transcript;
    const idNameNew = originalItem.id_name;
    
    try {
        const allTranscriptions = await makeAllTranscriptions(text, uniqueLanguages, SOURCE_LANGUAGE);
        
        for (const [lang, translatedText] of Object.entries(allTranscriptions)) {
            const translatedItem = {
                ...originalItem,
                id_name: `${idNameNew}-${lang}`,
                id_lang: lang,
                transcript_transcript: translatedText
            };
            
            const params = {
                TableName: TABLE_NAME,
                Item: translatedItem
            };
            
            try {
                await dynamoClient.put(params).promise();
            } catch (error) {
                console.error(`Failed to save translation for language ${lang}:`, error);
            }
        }
    } catch (error) {
        console.error("Error processing translations:", error);
    }
}


// Utility functions
function convertToMilliseconds(time) {
	return parseInt(time % 1 * 1000 + Math.floor(time) * 1000);
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