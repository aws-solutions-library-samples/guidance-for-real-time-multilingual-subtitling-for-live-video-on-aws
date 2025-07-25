const http = require('http');
const { MediaLiveClient, StopChannelCommand } = require('@aws-sdk/client-medialive');

// environment variables
const NLB_ENDPOINT = process.env.NLB_ENDPOINT;
const NLB_PORT = process.env.NLB_PORT || '8080';
const MEDIALIVE_CHANNEL_ID = process.env.MEDIALIVE_CHANNEL_ID;
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

/**
 * MediaLive 채널을 중지하는 함수
 */
async function stopMediaLiveChannel(channelId) {
    try {
        console.log(`MediaLive 채널 중지 시도: ${channelId}`);
        const medialive = new MediaLiveClient({ region: AWS_REGION });
        const command = new StopChannelCommand({ ChannelId: channelId });
        const response = await medialive.send(command);
        console.log('MediaLive 채널 중지 성공:', response);
        return {
            success: true,
            channelId: channelId,
            state: response.State || 'STOPPING'
        };
    } catch (error) {
        console.error('MediaLive 채널 중지 오류:', error);
        throw new Error(`MediaLive 채널 중지 실패: ${error.message}`);
    }
}

exports.handler = async (event) => {
    console.log('영상 처리 리셋 람다 함수 시작');
    console.log('이벤트:', JSON.stringify(event));

    try {
        // NLB 엔드포인트가 설정되지 않은 경우 오류 반환
        if (!NLB_ENDPOINT) {
            return formatResponse(500, {
                error: '서버 구성 오류',
                message: 'NLB_ENDPOINT 환경 변수가 설정되지 않았습니다.'
            });
        }

        // 요청 본문 파싱
        let requestBody = {};
        if (event.body) {
            try {
                requestBody = JSON.parse(event.body);
                console.log('요청 본문:', requestBody);
            } catch (e) {
                console.log('요청 본문 파싱 오류 (빈 본문일 수 있음):', e);
            }
        }

        console.log('Fargate 컨테이너로 리셋 요청 전달 중...');
        // Fargate 컨테이너로 리셋 요청 전달
        const response = await forwardRequestToNLB('/reset', requestBody);
        console.log('리셋 응답:', response);
        
        // MediaLive 채널 중지 시도
        let mediaLiveResponse = null;
        if (MEDIALIVE_CHANNEL_ID) {
            try {
                console.log('MediaLive 채널 중지 시도 중...');
                mediaLiveResponse = await stopMediaLiveChannel(MEDIALIVE_CHANNEL_ID);
                console.log('MediaLive 채널 중지 성공:', mediaLiveResponse);
            } catch (mediaLiveError) {
                console.error('MediaLive 채널 중지 오류:', mediaLiveError);
                // MediaLive 채널 중지 실패해도 전체 함수는 실패하지 않도록 처리
                mediaLiveResponse = {
                    success: false,
                    error: mediaLiveError.message
                };
            }
        } else {
            console.warn('MEDIALIVE_CHANNEL_ID 환경 변수가 설정되지 않아 MediaLive 채널 중지를 건너뜁니다.');
            mediaLiveResponse = {
                success: false,
                message: 'MEDIALIVE_CHANNEL_ID 환경 변수가 설정되지 않았습니다.'
            };
        }

        return formatResponse(200, {
            success: true,
            message: 'Video processing reset successfully',
            details: response,
            mediaLive: mediaLiveResponse
        });
    } catch (error) {
        console.error('오류 발생:', error);
        return formatResponse(500, {
            success: false,
            error: '서버 오류',
            message: error.message
        });
    }
};

/**
 * Network Load Balancer로 요청을 전달하는 함수
 */
async function forwardRequestToNLB(path, requestBody) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: NLB_ENDPOINT,
            port: parseInt(NLB_PORT),
            path: path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 30000 // 30초 타임아웃 설정
        };

        console.log('HTTP 요청 전송:', options);
        console.log('요청 본문:', JSON.stringify(requestBody));

        const req = http.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                console.log('NLB 응답 상태 코드:', res.statusCode);
                console.log('NLB 응답 데이터:', data);

                try {
                    const responseData = data ? JSON.parse(data) : {};
                    
                    // 응답 상태 코드가 200이 아닌 경우에도 데이터 반환
                    if (res.statusCode >= 400) {
                        console.warn(`NLB 응답 오류 (${res.statusCode}):`, responseData);
                    }
                    
                    resolve({
                        statusCode: res.statusCode,
                        data: responseData
                    });
                } catch (error) {
                    console.error('응답 데이터 파싱 오류:', error);
                    resolve({ 
                        statusCode: res.statusCode,
                        message: '응답을 처리하는 중 오류가 발생했습니다.',
                        rawData: data
                    });
                }
            });
        });

        req.on('error', (error) => {
            console.error('NLB 요청 오류:', error);
            reject(error);
        });
        
        req.on('timeout', () => {
            console.error('NLB 요청 타임아웃');
            req.destroy();
            reject(new Error('NLB 요청 타임아웃'));
        });

        if (requestBody) {
            req.write(JSON.stringify(requestBody));
        } else {
            // 빈 객체라도 전송
            req.write(JSON.stringify({}));
        }

        req.end();
    });
}

/**
 * API Gateway 응답 형식으로 변환하는 함수
 */
function formatResponse(statusCode, body) {
    return {
        statusCode: statusCode,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
        },
        body: JSON.stringify(body)
    };
}