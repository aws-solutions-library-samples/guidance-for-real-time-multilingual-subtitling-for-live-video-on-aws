const { MediaLiveClient, ListInputsCommand } = require('@aws-sdk/client-medialive');
const http = require('http');

const medialive = new MediaLiveClient({ region: process.env.AWS_REGION || 'us-east-1' });
const NLB_ENDPOINT = process.env.NLB_ENDPOINT;
const NLB_PORT = process.env.NLB_PORT || '8080';

exports.handler = async (event) => {
    console.log('Lambda 함수 시작');
    console.log('Environment Variables:');
    console.log('- NLB_ENDPOINT:', NLB_ENDPOINT);
    console.log('- NLB_PORT:', NLB_PORT);
    console.log('- AWS_REGION:', process.env.AWS_REGION);
    console.log('이벤트:', JSON.stringify(event, null, 2));

    try {
        if (!NLB_ENDPOINT) {
            throw new Error('NLB_ENDPOINT 환경 변수가 설정되지 않았습니다.');
        }
        
        // 요청 본문 파싱
        let requestBody = {};
        if (event.body) {
            try {
                requestBody = JSON.parse(event.body);
            } catch (e) {
                console.error('요청 본문 파싱 오류:', e);
            }
        }
        
        // action 파라미터 확인 (API Gateway 통합에서 설정)
        const action = event.action || 'process-video';
        console.log('Action:', action);
        
        // get-subtitles 액션 처리
        if (action === 'get-subtitles') {
            console.log('자막 데이터 요청 처리');
            const subtitlesResponse = await forwardRequestToNLB('/get-subtitles', requestBody);
            return formatResponse(200, subtitlesResponse);
        }
        
        // 기본 process-video 액션 처리
        const mediaLiveInputUrl = await getMediaLiveInputUrl();
        console.log('MediaLive Input URL:', mediaLiveInputUrl);

        const sessionId = requestBody.sessionId || Date.now().toString();
        const videoUrl = requestBody.videoUrl || mediaLiveInputUrl;

        // 이벤트 소스 감지 로직 개선 (실제 EventBridge + app.js 위장 호출 모두 처리)
        const isEventBridgeCall = event.source === 'aws.medialive' ||           // 실제 EventBridge 호출
                                 (requestBody.source === 'aws.medialive');      // app.js에서 위장한 호출

        const processRequestBody = {
            videoUrl: videoUrl,
            sessionId: sessionId,
            sourceType: 'medialive-input',
            triggerSource: isEventBridgeCall ? 'medialive-auto' : 'manual'
        };

        const response = await forwardRequestToNLB('/process-video', processRequestBody);

        return formatResponse(200, {
            success: true,
            message: 'MediaLive input processing started',
            videoUrl: videoUrl,
            sessionId: sessionId,
            fargateResponse: response
        });

    } catch (error) {
        console.error('오류 발생:', error);
        return formatResponse(500, {
            error: '서버 오류',
            message: error.message
        });
    }
};

async function getMediaLiveInputUrl() {
    try {
        console.log('MediaLive inputs 조회 시작...');
        
        const command = new ListInputsCommand({});
        const inputsResponse = await medialive.send(command);
        console.log('MediaLive Inputs 수:', inputsResponse.Inputs.length);

        const attachedInput = inputsResponse.Inputs.find(input => {
            console.log(`Input ${input.Name}: State=${input.State}, Sources=${input.Sources?.length || 0}`);
            return input.State === 'ATTACHED' && 
                   input.Sources && 
                   input.Sources.length > 0;
        });

        if (!attachedInput) {
            throw new Error('ATTACHED 상태의 MediaLive input을 찾을 수 없습니다.');
        }

        const inputUrl = attachedInput.Sources[0].Url;
        console.log(`MediaLive Input: ${attachedInput.Name} -> ${inputUrl}`);
        
        return inputUrl;
    } catch (error) {
        console.error('MediaLive Input 조회 오류:', error);
        throw new Error(`MediaLive Input 조회 실패: ${error.message}`);
    }
}

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
            timeout: 30000
        };

        console.log('NLB 요청 전송:', options);
        console.log('요청 본문:', JSON.stringify(requestBody, null, 2));

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                console.log('NLB 응답 상태:', res.statusCode);
                console.log('NLB 응답 데이터:', data);
                try {
                    const responseData = data ? JSON.parse(data) : {};
                    resolve(responseData);
                } catch (error) {
                    resolve({ message: '응답 처리 중 오류 발생', rawResponse: data });
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

        req.write(JSON.stringify(requestBody));
        req.end();
    });
}

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