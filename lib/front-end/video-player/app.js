// Video player application for live streaming with multiple screens
let LOGIN_URL, API_GATEWAY_URL, CLOUDFRONT_HLS_URL;

// Multiple video players
let videoPlayers = {};

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

                // 언어 변경 감지
                videoPlayers[i].on('texttrackchange', function() {
                    updateLanguageDisplay(i);
                });
            });

        } catch (error) {
            console.error(`Error initializing video player ${i}:`, error);
        }
    }
}

// Handle authentication tokens from URL hash
const hashParams = new URLSearchParams(window.location.hash.substring(1));
const idTokenFromHash = hashParams.get('id_token');
if (idTokenFromHash) {
    localStorage.setItem('id_token', idTokenFromHash);
    // Clean up URL
    history.replaceState(null, null, window.location.pathname);
    console.log('Authentication token stored from URL hash');
}

// Handle authentication and redirect to Cognito if needed
function handleAuthenticationError() {
    if (LOGIN_URL) {
        console.log('Redirecting to Cognito login:', LOGIN_URL);
        window.location.href = LOGIN_URL;
    } else {
        console.error('LOGIN_URL not configured');
    }
}

// Initialize application with configuration
async function initializeApp() {
    try {
        const response = await fetch('./config.json');
        const json = await response.json();
        
        LOGIN_URL = json.CognitoStack?.loginurl;
        API_GATEWAY_URL = json.UDPAudioReceiverStack?.ApiGatewayUrl;
        const cloudFrontDomain = json.BaseLiveStreamingStack?.CFDomainName;
        const webvttApiUrl = json.BaseLiveStreamingStack?.WebVTTApiUrl;

        if (API_GATEWAY_URL && !API_GATEWAY_URL.endsWith('/')) {
            API_GATEWAY_URL += '/';
        }

        if (cloudFrontDomain && webvttApiUrl) {
            CLOUDFRONT_HLS_URL = webvttApiUrl.replace(/^https?:\/\/[^\/]+/, `https://${cloudFrontDomain}`);
        } else {
            CLOUDFRONT_HLS_URL = webvttApiUrl;
        }
        
        initializeVideoPlayers();
        initializeUI();
        
        // Check if user is authenticated
        const idToken = localStorage.getItem('id_token');
        if (!idToken) {
            console.log('No authentication token found, redirecting to Cognito');
            handleAuthenticationError();
            return;
        }
        
        console.log('User is authenticated');
        
    } catch (error) {
        initializeVideoPlayers();
        initializeUI();
    }
}

// Initialize UI components and event handlers
function initializeUI() {
    const videoStartBtn = document.getElementById('video-start-btn');
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


    
    videoStartBtn.textContent = 'Start All Streams';
    videoStartBtn.disabled = false;

    // Handle video start button click
    videoStartBtn.addEventListener('click', async function() {
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
                    player.play();
                });
            }
        }
    });
}

document.addEventListener('DOMContentLoaded', initializeApp);

// 언어 표시 업데이트
function updateLanguageDisplay(playerId) {
    const player = videoPlayers[playerId];
    if (!player) return;

    const textTracks = player.textTracks();
    let activeTrackLabel = 'English';

    for (let i = 0; i < textTracks.length; i++) {
        if (textTracks[i].mode === 'showing') {
            activeTrackLabel = textTracks[i].label || 'English';
            break;
        }
    }

    const displayElement = document.getElementById(`language-display-${playerId}`);
    if (displayElement) {
        displayElement.textContent = activeTrackLabel;
    }
}