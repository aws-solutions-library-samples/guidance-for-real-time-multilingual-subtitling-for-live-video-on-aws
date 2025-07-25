let METADATA_API_URL, MEDIATAILOR_URL, DISTRIBUTION_ORIGIN_URL, LOGIN_URL, API_GATEWAY_URL, CLOUDFRONT_HLS_URL;

let subtitlesEnabled = false; 
let currentSessionId = null;
let currentLanguage = 'En'; 
let subtitlePollingActive = false; 
let subtitlePollingInterval = null;
let lastSubtitleText = ''; 
let availableLanguages = ['ko', 'en', 'es', 'fr', 'de', 'ja'];

const parseVideoList = function(videoList){
    var playlist = []
    for (let i = 0; i < videoList.length; i++) {
        var videoListItem = videoList[i]; 
        // only show videos that are fully transcoded and longer than 3 minutes
        if (videoListItem.duration && (videoListItem.duration >= (3*60*1000))) {
            var videoOriginPath = videoListItem.id + '/' + videoListItem.title + '.m3u8' + '?ads.aid=' + videoListItem.id;
            var thumbnailOriginPath = videoListItem.id + '/thumbnail.jpg';
            playlist.push({
                sources: [{
                    src: MEDIATAILOR_URL + videoOriginPath,
                    type: 'application/x-mpegURL'
                }],
                poster: DISTRIBUTION_ORIGIN_URL + thumbnailOriginPath,
                duration: videoListItem.duration / 1000,
                markers: JSON.parse(videoListItem.markers),
                name: videoListItem.title,
                description: "",
                aid: videoListItem.id,
                thumbnail: [
                        {
                        src: DISTRIBUTION_ORIGIN_URL + thumbnailOriginPath    
                        }
                    ]
            })
        }
    }
    console.log('playlist: ', playlist);
    return playlist;
}


/////////// START ENTRY POINT MAIN APPLICATION ////////////////////////////
///////////////////////////////////////////////////////////////////////////

var videoPlayer = videojs('my-video', {
    html5: {
        hls: {
            enableLowInitialPlaylist: false,
            smoothQualityChange: false,
            overrideNative: true,
            liveRangeSafeTimeDelta: 0,
            targetDuration: 1
        }
    },
    liveui: true,
});

localStorage.setItem('id_token', new URLSearchParams(window.location.hash).get('id_token'));


async function initializeApp() {
    try {
        const response = await fetch('./config.json');
        const json = await response.json();
        
        LOGIN_URL = json.CognitoStack?.loginurl;
        API_GATEWAY_URL = json.UDPAudioReceiverStack?.ApiGatewayUrl;
        const mediaPackageUrl = json.BaseLiveStreamingStack?.HLSEndpointURL;
        const cloudFrontDomain = json.BaseLiveStreamingStack?.CFDomainName;

        
        if (API_GATEWAY_URL && !API_GATEWAY_URL.endsWith('/')) {
            API_GATEWAY_URL += '/';
        }

        if (mediaPackageUrl && cloudFrontDomain) {
            const urlPath = mediaPackageUrl.replace(/^https?:\/\/[^\/]+/, '');
            CLOUDFRONT_HLS_URL = `https://${cloudFrontDomain}${urlPath}`;
        } else {
            CLOUDFRONT_HLS_URL = mediaPackageUrl;
        }
        
        initializeUI();
        
    } catch (error) {
        console.error('Config loading failed:', error);
        initializeUI();
    }
}

function initializeUI() {
    const videoStartBtn = document.getElementById('video-start-btn');
    const resetBtn = document.getElementById('reset-btn');
    const subtitleDisplay = document.getElementById('subtitle-display');
    const languageSelector = document.getElementById('language-selector');
    const resetLog = document.getElementById('reset-log');

    function showLog(message, isError = false) {
        const logText = resetLog.querySelector('small');
        logText.textContent = `${new Date().toLocaleTimeString()}: ${message}`;
        logText.className = isError ? 'text-danger' : 'text-primary fw-bold';
        resetLog.style.display = 'block';
        resetLog.style.opacity = '0';
        resetLog.style.transform = 'translateY(-10px)';
        resetLog.style.transition = 'all 0.3s ease-in-out';
        
        setTimeout(() => {
            resetLog.style.opacity = '1';
            resetLog.style.transform = 'translateY(0)';
        }, 10);
        
        setTimeout(() => {
            resetLog.style.opacity = '0';
            resetLog.style.transform = 'translateY(-10px)';
            setTimeout(() => resetLog.style.display = 'none', 300);
        }, 5000);
    }

    if (window.location.hash) {
        const hashParams = new URLSearchParams(window.location.hash.substring(1));
        const idToken = hashParams.get('id_token');
        const accessToken = hashParams.get('access_token');
        
        if (idToken) {
            localStorage.setItem('id_token', idToken);
            history.replaceState(null, null, window.location.pathname);
        }
    }

    if (CLOUDFRONT_HLS_URL) {
        videoPlayer.src({
            src: CLOUDFRONT_HLS_URL,
            type: 'application/x-mpegURL'
        });
        
        videoPlayer.ready(() => {
            if (videoPlayer.tech().hls) {
                videoPlayer.tech().hls.xhr.beforeRequest = function(options) {
                    options.uri += (options.uri.indexOf('?') === -1 ? '?' : '&') + '_t=' + Date.now();
                    return options;
                };
            }
            
            
            videoPlayer.play().catch(error => {
                console.log('자동 재생 실패 (사용자 상호작용 필요):', error);
            });
        });
        
        // 실시간 스트림 끝까지 따라가기
        videoPlayer.on('loadedmetadata', function() {
            if (videoPlayer.duration() === Infinity) {
                // 실시간 스트림의 경우 항상 최신 위치로 이동
                videoPlayer.currentTime(0);
            }       
        });
    }
    
   
    videoStartBtn.textContent = 'Start Live Stream';
    videoStartBtn.disabled = false;

    videoStartBtn.addEventListener('click', async function() {
        try {
            videoStartBtn.disabled = true;
            
            if (CLOUDFRONT_HLS_URL) {
                videoPlayer.src({
                    src: CLOUDFRONT_HLS_URL,
                    type: 'application/x-mpegURL'
                });
                
                videoPlayer.ready(() => {
                    
                    videoPlayer.play();
                });

                videoPlayer.on('timeupdate', function() {
                    const seekable = videoPlayer.seekable();
                    if (seekable.length > 0) {
                        const currentTime = videoPlayer.currentTime();
                        const liveEdge = seekable.end(0);
                        
                        if (liveEdge - currentTime > 10) {
                        }
                    }
                });
                
                subtitleDisplay.textContent = "Live stream starting...";
            }
            
        } catch (error) {
            console.error('Video Start 오류:', error);
            videoStartBtn.disabled = false;
        }
    });
        
                
    resetBtn.addEventListener('click', async function() {
        try {
            showLog('Resetting...', false);
            
            videoPlayer.pause();
            videoPlayer.reset();
            
            if (CLOUDFRONT_HLS_URL) {
                const resetUrl = `${CLOUDFRONT_HLS_URL}?reset=${Date.now()}`;
                videoPlayer.src({
                    src: resetUrl,
                    type: 'application/x-mpegURL'
                });
            }
            

            if (API_GATEWAY_URL) {
                const resetResponse = await fetch(`${API_GATEWAY_URL}video/reset`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ timestamp: Date.now(), action: 'reset' })
                });
                
                if (resetResponse.ok) {
                    showLog('Reset completed - Ready for new stream');
                } else {
                    showLog('Reset failed', true);
                }
            }
            
            videoStartBtn.disabled = false;
            
        } catch (error) {
            showLog(`Error: ${error.message}`, true);
        }
    });
    
    
    function startSubtitlePolling() {
        if (subtitlePollingInterval) {
            clearInterval(subtitlePollingInterval);
        }
        
        subtitlePollingInterval = setInterval(async () => {
            try {
                if (!currentSessionId || !API_GATEWAY_URL) return;
                
                const currentTime = videoPlayer.currentTime();
                
                const subtitlesUrl = API_GATEWAY_URL.endsWith('/') ? 
                    `${API_GATEWAY_URL}video/get-subtitles` : 
                    `${API_GATEWAY_URL}/get-subtitles`;
                
                const response = await fetch(subtitlesUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        sessionId: currentSessionId,
                        currentTime: currentTime
                    })
                });
                
                if (response.ok) {
                    const data = await response.json();
                    
                    if (data.success && data.currentSubtitle) {
                        subtitleDisplay.textContent = data.currentSubtitle.text;
                    } else if (data.success && data.activeSubtitles && data.activeSubtitles.length === 0) {
                        subtitleDisplay.textContent = "";
                    }
                }
            } catch (error) {
                console.error('자막 폴링 오류:', error);
            }
        }, 1000);
    }
    function stopSubtitlePolling() {
        if (subtitlePollingInterval) {
            clearInterval(subtitlePollingInterval);
            subtitlePollingInterval = null;
        }
    }
}

document.addEventListener('DOMContentLoaded', initializeApp);