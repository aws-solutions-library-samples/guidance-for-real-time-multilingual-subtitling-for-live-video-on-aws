/**
 * 영상 처리 람다 함수
 * 
 * 이 람다 함수는 API Gateway에서 요청을 받아 Fargate 컨테이너로 전달합니다.
 * 웹 UI에서 영상 처리 버튼을 클릭하면 이 함수가 호출됩니다.
 */

const https = require('https');
const http = require('http');

// environment variables
const NLB_ENDPOINT = process.env.NLB_ENDPOINT;
const NLB_PORT = process.env.NLB_PORT || '8080';
const USE_HTTPS = process.env.USE_HTTPS === 'true';

/**
 * API Gateway에서 호출되는 람다 핸들러
 */
exports.handler = async (event) => {
    console.log('영상 처리 람다 함수 시작');
    console.log('이벤트:', JSON.stringify(event));

    try {
        // API Gateway에서 전달된 요청 본문 파싱
        let requestBody;
        if (event.body) {
            requestBody = JSON.parse(event.body);
        } else {
            requestBody = event;
        }

        console.log('요청 본문:', JSON.stringify(requestBody));

        // 영상 URL이 없는 경우 기본값 설정
        if (!requestBody.videoUrl) {
            requestBody.videoUrl = 'https://dhgd8ucc6ahc0.cloudfront.net/uefa_barcelona_frankfurt_lowres.mp4';
            console.log('영상 URL이 제공되지 않아 기본값으로 설정:', requestBody.videoUrl);
        }

        // NLB 엔드포인트가 설정되지 않은 경우 오류 반환
        if (!NLB_ENDPOINT) {
            return formatResponse(500, {
                error: '서버 구성 오류',
                message: 'NLB_ENDPOINT 환경 변수가 설정되지 않았습니다.'
            });
        }

        // 세션 ID 생성
        const sessionId = Date.now().toString();
        requestBody.sessionId = sessionId;

        // Fargate 컨테이너로 요청 전달
        const response = await forwardRequestToNLB('/process-video', requestBody);

        // 응답에 세션 ID 추가
        response.sessionId = sessionId;

        return formatResponse(200, response);
    } catch (error) {
        console.error('오류 발생:', error);
        return formatResponse(500, {
            error: '서버 오류',
            message: error.message
        });
    }
};

/**
 * 리셋 요청을 처리하는 람다 핸들러
 */
exports.resetHandler = async (event) => {
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

        // Fargate 컨테이너로 리셋 요청 전달
        const response = await forwardRequestToNLB('/reset', {});

        return formatResponse(200, response);
    } catch (error) {
        console.error('오류 발생:', error);
        return formatResponse(500, {
            error: '서버 오류',
            message: error.message
        });
    }
};

/**
 * 자막 데이터를 가져오는 람다 핸들러
 */
exports.getSubtitlesHandler = async (event) => {
    console.log('자막 데이터 요청 람다 함수 시작');
    console.log('이벤트:', JSON.stringify(event));

    try {
        // API Gateway에서 전달된 요청 본문 파싱
        let requestBody;
        if (event.body) {
            requestBody = JSON.parse(event.body);
        } else {
            requestBody = event;
        }

        console.log('요청 본문:', JSON.stringify(requestBody));

        // NLB 엔드포인트가 설정되지 않은 경우 오류 반환
        if (!NLB_ENDPOINT) {
            return formatResponse(500, {
                error: '서버 구성 오류',
                message: 'NLB_ENDPOINT 환경 변수가 설정되지 않았습니다.'
            });
        }

        // Fargate 컨테이너로 자막 데이터 요청 전달
        const response = await forwardRequestToNLB('/get-subtitles', requestBody);

        return formatResponse(200, response);
    } catch (error) {
        console.error('오류 발생:', error);
        return formatResponse(500, {
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
        // 요청 옵션 설정
        const options = {
            hostname: NLB_ENDPOINT,
            port: NLB_PORT,
            path: path,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        };

        console.log(`${USE_HTTPS ? 'HTTPS' : 'HTTP'} 요청 전송:`, options);

        // HTTP 또는 HTTPS 요청 생성
        const protocol = USE_HTTPS ? https : http;
        const req = protocol.request(options, (res) => {
            let data = '';

            // 응답 데이터 수신
            res.on('data', (chunk) => {
                data += chunk;
            });

            // 응답 완료
            res.on('end', () => {
                console.log('NLB 응답 상태 코드:', res.statusCode);
                console.log('NLB 응답 데이터:', data);

                try {
                    const responseData = data ? JSON.parse(data) : {};
                    resolve(responseData);
                } catch (error) {
                    console.error('응답 데이터 파싱 오류:', error);
                    resolve({ message: '응답을 처리하는 중 오류가 발생했습니다.' });
                }
            });
        });

        // 요청 오류 처리
        req.on('error', (error) => {
            console.error('NLB 요청 오류:', error);
            reject(error);
        });

        // 요청 본문 전송
        if (requestBody) {
            req.write(JSON.stringify(requestBody));
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
            'Access-Control-Allow-Origin': '*', // CORS 설정
            'Access-Control-Allow-Methods': 'OPTIONS,POST,GET'
        },
        body: JSON.stringify(body)
    };
}