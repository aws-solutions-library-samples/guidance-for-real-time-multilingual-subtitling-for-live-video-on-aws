const stream = require('stream');
const { exit } = require('process');
const dgram = require('dgram');
const express = require('express');

// Amazon Transcribe SDK Setup
const {
	TranscribeStreamingClient,
	StartStreamTranscriptionCommand,
} = require("@aws-sdk/client-transcribe-streaming");
const transcribeClient = new TranscribeStreamingClient({ region: process.env.AWS_REGION || 'us-east-1' });

// DynamoDB Setup
let AWS = require('aws-sdk');
const dynamoClient = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'us-east-1' });

// Setup Environment Variables (참조 코드 스타일)
const TABLE_NAME = process.env.TABLE_NAME || 'SubtitleTable';
//const VOCABULARYNAME = process.env.VOCABULARY_NAME;
const LANGUAGECODE = process.env.LANGUAGE_CODE || 'en-US';
const MEDIA_ENCODING = 'pcm';
const SAMPLE_RATE = 16000;
const UDP_PORT = process.env.UDP_PORT || 7950;
const HTTP_PORT = process.env.HTTP_PORT || 8080;

console.log('UDP 오디오 수신기 시작 (참조 코드 스타일)...');
console.log('언어 코드:', LANGUAGECODE);
console.log('DynamoDB 테이블:', TABLE_NAME);
console.log('UDP 포트:', UDP_PORT);
console.log('HTTP 포트:', HTTP_PORT);

// HTTP 서버 설정 (헬스 체크 및 제어용)
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

// 영상 처리 시작
app.post('/process-video', async (req, res) => {
	try {
		console.log('Video Processing for live subtitle');
		console.log('Request body:', req.body);

		// Lambda에서 전달받은 동적 영상 URL 및 언어 코드 사용
		const videoUrl = req.body.videoUrl;
		const sessionId = req.body.sessionId || Date.now().toString();
		const languageCode = req.body.languageCode || LANGUAGECODE; // Lambda에서 전달받은 언어 코드 또는 기본값

		if (!videoUrl) {
			return res.status(400).json({
				success: false,
				error: 'videoUrl is required'
			});
		}

		console.log(`Processing video URL: ${videoUrl}`);
		console.log(`Session ID: ${sessionId}`);
		console.log(`Language Code: ${languageCode}`);

		// 현재 처리 중인 영상 정보 저장
		global.currentVideoUrl = videoUrl;
		global.currentSessionId = sessionId;
		global.currentLanguageCode = languageCode; // 언어 코드도 전역 변수로 저장

		// 이미 실행 중인 ffmpeg 프로세스 종료
		if (global.ffmpegProcess) {
			console.log('기존 ffmpeg 프로세스 종료');
			global.ffmpegProcess.kill();
		}

		// 새로운 ffmpeg 프로세스 시작 - UDP 출력 형식 수정
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

		console.log(`ffmpeg started with video URL: ${videoUrl}`);

		// ffmpeg 프로세스 출력 로깅 (디버깅용)
		global.ffmpegProcess.stdout.on('data', (data) => {
			console.log('ffmpeg stdout:', data.toString());
		});

		global.ffmpegProcess.stderr.on('data', (data) => {
			console.log('ffmpeg stderr:', data.toString());
		});

		// ffmpeg 프로세스 오류 처리
		global.ffmpegProcess.on('error', (err) => {
			console.error('ffmpeg 프로세스 오류:', err);
		});

		global.ffmpegProcess.on('exit', (code) => {
			console.log(`ffmpeg 프로세스 종료, 코드: ${code}`);
		});

		// UDP 스트리밍 시작
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
		console.error('영상 처리 시작 오류:', error);
		res.status(500).json({ error: '영상 처리 시작 실패', details: error.message });
	}
});

// 영상 처리 중지
app.post('/reset', async (req, res) => {
	try {
		console.log('영상 처리 중지 요청 받음 - 모든 프로세스 정리 시작');

		// 1. 전역 상태 초기화
		isTranscribing = false;

		// 2. ffmpeg 프로세스 강제 종료
		if (global.ffmpegProcess) {
			console.log('ffmpeg 프로세스 강제 종료');
			global.ffmpegProcess.kill('SIGKILL'); // 강제 종료
			global.ffmpegProcess = null;
		}

		// 3. UDP 서버 정리
		if (udpServer) {
			console.log('UDP 서버 정리 중...');
			try {
				udpServer.close(() => {
					console.log('UDP 서버 정상 종료됨');
				});
			} catch (err) {
				console.log('UDP 서버 종료 중 오류 (무시):', err.message);
			}
			udpServer = null;
		}

		// 4. 포트 7950 강제 해제 (fuser 명령어 사용)
		const { spawn } = require('child_process');
		try {
			console.log('포트 7950 강제 해제 시도...');
			const fuserProcess = spawn('fuser', ['-k', '7950/udp'], { stdio: 'ignore' });
			fuserProcess.on('exit', (code) => {
				console.log(`포트 7950 정리 완료 (exit code: ${code})`);
			});
		} catch (err) {
			console.log('포트 정리 중 오류 (무시):', err.message);
		}

		// 5. 전역 변수 정리
		global.currentVideoUrl = null;
		global.currentSessionId = null;
		global.currentLanguageCode = null;
		
		// 6. DynamoDB 자막 데이터 삭제 (새로운 키 구조에 맞게 수정)
        const scanParams = { TableName: TABLE_NAME };
        const scanResult = await dynamoClient.scan(scanParams).promise();

        if (scanResult.Items.length > 0) {
                const deletePromises = scanResult.Items.map(item => {
                        const deleteParams = {
                                TableName: TABLE_NAME,
                                Key: {
                                        resultId: item.resultId,  // 파티션 키
                                        startTime: item.startTime // 정렬 키
                                }
                        };
                        return dynamoClient.delete(deleteParams).promise();
                });
                await Promise.all(deletePromises);
                console.log(`DynamoDB에서 ${scanResult.Items.length}개 자막 데이터 삭제 완료`);
        }


		// 6. 메모리 정리를 위한 가비지 컬렉션 힌트
		if (global.gc) {
			global.gc();
		}

		console.log('모든 프로세스 정리 완료');

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
		console.error('영상 처리 중지 오류:', error);
		res.status(500).json({ 
			success: false,
			error: '영상 처리 중지 실패', 
			details: error.message 
		});
	}
});

// 자막 데이터 가져오기
app.post('/get-subtitles', async (req, res) => {
	try {
		console.log('자막 데이터 요청 받음:', req.body);

		const sessionId = req.body.sessionId;
		const currentTime = req.body.currentTime || 0;

		if (!sessionId) {
			return res.status(400).json({
				error: '세션 ID가 필요합니다.'
			});
		}

		// 현재 시간 기준으로 DynamoDB에서 자막 데이터 조회
		// 새로운 키 구조에 맞게 수정 - GSI 사용
		const params = {
			TableName: TABLE_NAME,
			IndexName: 'sessionId-startTime-index', // GSI 사용
			KeyConditionExpression: 'sessionId = :sessionId',
			FilterExpression: 'isPartial = :isPartial',
			ExpressionAttributeValues: {
				':sessionId': sessionId,
				':isPartial': false  // 최종 확정된 자막만 가져오기
			},
			Limit: 50 // 최근 50개 자막 가져오기
		};

		const result = await dynamoClient.query(params).promise();

		// 자막 데이터 가공 - 프론트엔드 호환성 유지
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

		// 시간 순으로 정렬
		subtitles.sort((a, b) => a.startTime - b.startTime);

		// ✅ 올바른 시간 동기화 로직: 현재 재생 시간이 자막의 시작~종료 시간 사이에 있는지 확인
		const activeSubtitles = subtitles.filter(subtitle => {
			// 현재 재생 시간이 자막의 시작 시간과 종료 시간 사이에 있는지 확인
			return currentTime >= subtitle.startTime && currentTime <= subtitle.endTime;
		});

		// 현재 시간에 활성화된 자막이 여러 개인 경우 가장 최근 것 선택
		const currentSubtitle = activeSubtitles.length > 0 ? 
			activeSubtitles[activeSubtitles.length - 1] : null;

		// 디버깅을 위한 로그
		console.log(`현재 시간 ${currentTime}초에 대한 자막 검색 결과:`);
		console.log(`- 전체 자막 수: ${subtitles.length}`);
		console.log(`- 활성 자막 수: ${activeSubtitles.length}`);
		if (currentSubtitle) {
			console.log(`- 선택된 자막: "${currentSubtitle.text}" (${currentSubtitle.startTime}s - ${currentSubtitle.endTime}s)`);
		}

		res.json({
			success: true,
			currentSubtitle: currentSubtitle,
			activeSubtitles: activeSubtitles,
			totalSubtitles: subtitles.length,
			currentTime: currentTime
		});
	} catch (error) {
		console.error('자막 데이터 조회 오류:', error);
		res.status(500).json({ error: '자막 데이터 조회 실패', details: error.message });
	}
});

const server = app.listen(HTTP_PORT, () => {
	console.log(`HTTP 서버가 포트 ${HTTP_PORT}에서 실행 중입니다.`);
});

// UDP 서버 설정
let isTranscribing = false;
let udpServer = null;

///////////////////////////// STARTING (참조 코드 스타일) ////////////////////////////// 

async function startStreamingWrapper() {
	if (isTranscribing) {
		console.log('이미 전사 중입니다.');
		return;
	}

	isTranscribing = true;
	console.log('UDP 스트리밍 시작...');
	
	// 무한 루프로 지속적인 음성 인식 처리
	while (isTranscribing) {
		try {
			await streamAudioToTranscribe();
			console.log("전사 스트림 종료, 재시작 중...");
		} catch (error) {
			console.log('전사 오류, 재시도 중:', error);
		}
		
		// 1초 대기 후 재시도 (너무 빠른 재시작 방지)
		if (isTranscribing) {
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
	}
	
	console.log("전사 프로세스 종료");
}

async function streamAudioToTranscribe() {
	const passthroughStream = new stream.PassThrough({ highWaterMark: 128 }); // 참조 코드와 동일

	// 기존 UDP 서버가 있으면 정리
	if (udpServer) {
		console.log('기존 UDP 서버 정리 중...');
		udpServer.close();
		udpServer = null;
	}

	// UDP 서버 생성
	udpServer = dgram.createSocket('udp4');

	udpServer.on('message', (msg, rinfo) => {
		// UDP로 받은 오디오 데이터를 스트림에 전달
		passthroughStream.write(msg);
	});

	udpServer.on('error', (err) => {
		console.error('UDP 서버 오류:', err);
		// 포트 충돌 시 재시도 방지
		if (err.code === 'EADDRINUSE') {
			console.log('포트가 이미 사용 중입니다. 기존 프로세스를 확인하세요.');
			return;
		}
	});

	udpServer.bind(UDP_PORT, () => {
		console.log(`UDP 서버가 포트 ${UDP_PORT}에서 대기 중입니다.`);
	});

	const transcribeInput = async function* transcribeInput() {
		try {
			for await (const chunk of passthroughStream) {
				yield { AudioEvent: { AudioChunk: chunk } }
			}
		} catch (error) {
			console.log('오디오 청크 처리 오류:', error);
		}
	};

	// Amazon Transcribe 스트리밍 세션 시작 (참조 코드와 동일)
	const currentLanguage = global.currentLanguageCode || LANGUAGECODE; // 동적 언어 코드 사용
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

				// 디버그 모드가 활성화된 경우 전체 응답 객체 로깅
				if (process.env.DEBUG_MODE === 'true') {
					console.log('Transcribe 응답 객체:', JSON.stringify(chunk.TranscriptEvent.Transcript, null, 2));
				}

				// 실제 발화 시작 시간과 종료 시간 추출
				let startTime = results.StartTime; // 기본값으로 기존 StartTime 사용
				let endTime = results.EndTime;     // 기본값으로 기존 EndTime 사용

				// Items 배열이 존재하고 비어있지 않은 경우 실제 발화 시간 사용
				if (results.Alternatives[0].Items && results.Alternatives[0].Items.length > 0) {
					// 첫 번째 항목의 StartTime을 실제 발화 시작 시간으로 사용
					startTime = results.Alternatives[0].Items[0].StartTime;
					
					// EndTime은 IsPartial 상태에 따라 다르게 처리
					if (results.IsPartial) {
						// 증분 저장 중: 마지막 단어의 EndTime 사용
						const lastItemIndex = results.Alternatives[0].Items.length - 1;
						endTime = results.Alternatives[0].Items[lastItemIndex].EndTime;
					} else {
						// 최종 저장: Results.EndTime 사용 (전체 발화 구간)
						endTime = results.EndTime;
					}
				}

				// ResultId 기반 증분 업데이트 (같은 발화에 대해 실시간 EndTime 업데이트)
				const params = {
					TableName: TABLE_NAME,
					Key: {
						resultId: results.ResultId,  // ResultId를 파티션 키로 사용
						startTime: startTime         // startTime을 정렬 키로 사용
					},
					UpdateExpression: "SET transcript = :transcript, endTime = :endTime, sessionId = :sessionId, updatedAt = :timestamp, isPartial = :partial, languageCode = :language, channelId = :channelId",
					ExpressionAttributeValues: {
						":transcript": results.Alternatives[0].Transcript,
						":endTime": endTime,         // 수정된 종료 시간 사용
						":sessionId": sessionId,     // sessionId는 이제 속성으로 저장
						":timestamp": Date.now(),
						":partial": results.IsPartial,
						":language": languageCode,
						":channelId": results.ChannelId || 'ch_0'
					}
				};

				try {
					await dynamoClient.update(params).promise();
					
					// IsPartial 상태에 따른 로그 구분
					if (results.IsPartial) {
						console.log(`[${sessionId}][${languageCode}] 실시간 업데이트: ${results.Alternatives[0].Transcript} (StartTime: ${startTime}s, EndTime: ${endTime}s)`);
					} else {
						console.log(`[${sessionId}][${languageCode}] 최종 저장 완료: ${results.Alternatives[0].Transcript} (${startTime}s - ${endTime}s)`);
					}
				} catch (error) {
					console.error('DynamoDB 저장 오류:', error);
					console.error('오류 발생 파라미터:', JSON.stringify(params, null, 2));
				}
			}
		}
	} catch (error) {
		console.log('전사 스트림 처리 오류:', error);
	}
}

// 참조 코드와 동일한 유틸리티 함수들
function convertToMilliseconds(time) {
	return parseInt(time % 1 * 1000 + Math.floor(time) * 1000);
}

function roundToTenthMillisecond(number) {
	return (Math.round(number * 10) / 10).toFixed(1);
}

function timestamp_millis() {
	return parseInt(Date.now(), 10);
}

// 프로세스 종료 시 정리
process.on('SIGTERM', () => {
	console.log('SIGTERM 신호 받음, 서버 종료 중...');
	if (udpServer) {
		udpServer.close();
	}
	server.close(() => {
		console.log('서버가 정상적으로 종료되었습니다.');
		process.exit(0);
	});
});

process.on('SIGINT', () => {
	console.log('SIGINT 신호 받음, 서버 종료 중...');
	if (udpServer) {
		udpServer.close();
	}
	server.close(() => {
		console.log('서버가 정상적으로 종료되었습니다.');
		process.exit(0);
	});
});
