// Video player application for live streaming with subtitles
let METADATA_API_URL, MEDIATAILOR_URL, DISTRIBUTION_ORIGIN_URL, LOGIN_URL, API_GATEWAY_URL, CLOUDFRONT_HLS_URL;

let subtitlesEnabled = false; 
let currentSessionId = null;
let currentLanguage = 'En'; 
let subtitlePollingActive = false; 
let subtitlePollingInterval = null;
let lastSubtitleText = ''; 
let availableLanguages = ['ko', 'en', 'es', 'fr', 'de', 'ja'];

// Parse video list for playlist creation
const parseVideoList = function(videoList){
    var playlist = []
    for (let i = 0; i < videoList.length; i++) {
        var videoListItem = videoList[i]; 
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
    return playlist;
}


// Initialize video player with HLS configuration
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


// Initialize application with configuration
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
        initializeUI();
    }
}

// Initialize UI components and event handlers
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

    // Handle authentication tokens from URL hash
    if (window.location.hash) {
        const hashParams = new URLSearchParams(window.location.hash.substring(1));
        const idToken = hashParams.get('id_token');
        const accessToken = hashParams.get('access_token');
        
        if (idToken) {
            localStorage.setItem('id_token', idToken);
            history.replaceState(null, null, window.location.pathname);
        }
    }

    // Initialize video player with HLS stream
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
                // Handle autoplay failure
            });
        });
        
        videoPlayer.on('loadedmetadata', function() {
            if (videoPlayer.duration() === Infinity) {
                videoPlayer.currentTime(0);
            }       
        });
    }
    
    videoStartBtn.textContent = 'Start Live Stream';
    videoStartBtn.disabled = false;

    // Handle video start button click
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
                            // Handle live edge synchronization
                        }
                    }
                });
                
                subtitleDisplay.textContent = "Live stream starting...";
            }
            
        } catch (error) {
            videoStartBtn.disabled = false;
        }
    });
        
    // Handle reset button click
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
    // Start subtitle polling for real-time updates
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
                // Handle subtitle polling error
            }
        }, 1000);
    }
    
    // Stop subtitle polling
    function stopSubtitlePolling() {
        if (subtitlePollingInterval) {
            clearInterval(subtitlePollingInterval);
            subtitlePollingInterval = null;
        }
    }
}

document.addEventListener('DOMContentLoaded', initializeApp);