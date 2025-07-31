// Video player application for live streaming with multiple screens
let METADATA_API_URL, MEDIATAILOR_URL, DISTRIBUTION_ORIGIN_URL, LOGIN_URL, API_GATEWAY_URL, CLOUDFRONT_HLS_URL;

// Multiple video players and language settings
let videoPlayers = {};
let currentLanguages = {
    1: 'ko',  // Screen 1: Korean
    2: 'en',  // Screen 2: English  
    3: 'es',  // Screen 3: Spanish
    4: 'ja'   // Screen 4: Japanese
};
let currentLanguage = 'En'; 
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


// Initialize multiple video players
function initializeVideoPlayers() {
    for (let i = 1; i <= 4; i++) {
        const elementId = `video-player-${i}`;
        const element = document.getElementById(elementId);
        
        if (!element) {
            continue;
        }
        
        if (videoPlayers[i]) {
            continue;
        }
        
        try {
            videoPlayers[i] = videojs(elementId, {
                html5: {
                    hls: {
                        enableLowInitialPlaylist: false,
                        smoothQualityChange: false,
                        overrideNative: true,
                        liveRangeSafeTimeDelta: 30,  
                        targetDuration: 6            
                    }
                },
                liveui: true,
                liveTracker: {
                    trackingThreshold: 20,
                    liveTolerance: 15
                }
            });
            
            videoPlayers[i].ready(() => {
                videoPlayers[i].on('click', function(event) {
                    if (event.target && event.target.classList.contains('vjs-live-control')) {
                        videoPlayers[i].liveTracker.seekToLiveEdge();
                    }
                });
            });

        } catch (error) {

        }
    }
}

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
        
        initializeVideoPlayers();
        initializeUI();
        
    } catch (error) {
        initializeVideoPlayers();
        initializeUI();
    }
}

// Initialize UI components and event handlers
function initializeUI() {
    const videoStartBtn = document.getElementById('video-start-btn');
    const resetBtn = document.getElementById('reset-btn');
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

    for (let i = 1; i <= 4; i++) {
        const languageSelector = document.getElementById(`language-selector-${i}`);
        if (languageSelector) {
            languageSelector.addEventListener('change', function() {
                currentLanguages[i] = this.value;
            });
        }
    }
    
    videoStartBtn.textContent = 'Start All Streams';
    videoStartBtn.disabled = false;

    // Handle video start button click
    videoStartBtn.addEventListener('click', async function() {
        try {
            videoStartBtn.disabled = true;
            
            if (CLOUDFRONT_HLS_URL) {
                for (let i = 1; i <= 4; i++) {
                    const player = videoPlayers[i];

                    
                    const streamUrl = `${CLOUDFRONT_HLS_URL}?t=${Date.now()}`;
                    
                    player.src({
                        src: streamUrl,
                        type: 'application/x-mpegURL'
                    });
                    
                    player.ready(() => {
                        if (player.tech().hls) {
                            player.tech().hls.xhr.beforeRequest = function(options) {
                                options.uri += (options.uri.indexOf('?') === -1 ? '?' : '&') + '_t=' + Date.now();
                                return options;
                            };
                        }
                        player.play().then(() => {
                            player.addClass('vjs-live');
                        }).catch(error => {
                            console.error(`Player ${i} play error:`, error);
                        });
                         
                    });
    
                    player.on('timeupdate', function() {
                        const seekable = player.seekable();
                        if (seekable.length > 0) {
                            const currentTime = player.currentTime();
                            const liveEdge = seekable.end(0);
                            if (liveEdge - currentTime > 10) {
                                player.currentTime(liveEdge - 3);
                            }
                        }
                    });
    
                    player.on('loadedmetadata', function() {
                        if (player.duration() === Infinity) {
                            player.currentTime(0);
                        }       
                    });
                    
                }

            }
            
        } catch (error) {
            videoStartBtn.disabled = false;
        }
    });
    
        
    // Handle reset button click
    resetBtn.addEventListener('click', async function() {
        try {
            showLog('Resetting all streams...', false);
            
            for (let i = 1; i <= 4; i++) {
                const player = videoPlayers[i];
                player.pause();
                player.reset();
                
                if (CLOUDFRONT_HLS_URL) {
                    const resetUrl = `${CLOUDFRONT_HLS_URL}?reset=${Date.now()}`;
                    player.src({
                        src: resetUrl,
                        type: 'application/x-mpegURL'
                    });
                }
            }
    
            if (API_GATEWAY_URL) {
                const resetResponse = await fetch(`${API_GATEWAY_URL}video/reset`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ timestamp: Date.now(), action: 'reset' })
                });
                
                if (resetResponse.ok) {
                    showLog('Reset completed - Ready for new streams');
                } else {
                    showLog('Reset failed', true);
                }
            }
            
            videoStartBtn.disabled = false;
            
        } catch (error) {
            showLog(`Error: ${error.message}`, true);
        }
    });
}

document.addEventListener('DOMContentLoaded', initializeApp);