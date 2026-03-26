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
                },
                controls: true,
                muted: i !== 1,
                controlBar: {
                    playToggle: false,
                    progressControl: false,
                    currentTimeDisplay: false,
                    durationDisplay: false,
                    remainingTimeDisplay: false,
                    playbackRateMenuButton: false,
                    chaptersButton: false,
                    descriptionsButton: false,
                    subsCapsButton: true,
                    audioTrackButton: false,
                    volumePanel: {
                        inline: false,
                        volumeControl: true,
                        muteToggle: true
                    },
                    fullscreenToggle: true
                }
            });
            
            videoPlayers[i].ready(() => {
                videoPlayers[i].on('click', function(event) {
                    if (event.target && event.target.classList.contains('vjs-live-control')) {
                        videoPlayers[i].liveTracker.seekToLiveEdge();
                    }
                });

                videoPlayers[i].on('texttrackchange', function() {
                    updateLanguageDisplay(i);
                });

                // HLS text tracks are added after manifest parsing,
                // so listen for 'addtrack' to set defaults once tracks are available
                videoPlayers[i]._defaultSet = false;
                videoPlayers[i].textTracks().on('addtrack', function() {
                    if (!videoPlayers[i]._defaultSet) {
                        videoPlayers[i]._defaultSet = true;
                        setTimeout(() => setDefaultSubtitleLanguage(i), 500);
                    }
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
        if (window.location.hostname === 'localhost') {
            LOGIN_URL = LOGIN_URL?.replace(/redirect_uri=[^&]+/, `redirect_uri=${window.location.origin}/`);
        }
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
    const videoStopBtn = document.getElementById('video-stop-btn');
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

    // Video stop button
    videoStopBtn.addEventListener('click', function() {
        location.reload();
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

// Active languages cache (updated from API)
let cachedActiveLanguages = null;

// Default language per screen (fixed mapping)
const SCREEN_DEFAULT_LANGUAGE = { 1: 'en', 2: 'de', 3: 'es', 4: 'it' };

// Language setting for each player
async function setDefaultSubtitleLanguage(playerId) {
    const player = videoPlayers[playerId];
    if (!player) return;

    const activeCodes = await getActiveCodes();

    // First disable ALL subtitle/caption tracks to prevent overlap
    const textTracks = player.textTracks();
    for (let i = 0; i < textTracks.length; i++) {
        const track = textTracks[i];
        if (track.kind === 'subtitles' || track.kind === 'captions') {
            track.mode = 'disabled';
        }
    }

    // Hide inactive languages from CC menu
    filterTracksByActive(player, activeCodes);

    // Then enable only the target language
    const targetLanguage = SCREEN_DEFAULT_LANGUAGE[playerId];
    if (!targetLanguage || !activeCodes.includes(targetLanguage)) return;

    for (let i = 0; i < textTracks.length; i++) {
        const track = textTracks[i];
        if (track.language === targetLanguage) {
            track.mode = 'showing';
            updateLanguageDisplay(playerId);
            break;
        }
    }
}

// Get active language codes from API (with cache)
async function getActiveCodes() {
    if (!cachedActiveLanguages) {
        try {
            const data = await fetchActiveLanguages();
            cachedActiveLanguages = data.active.map(l => l.language_code);
        } catch (e) {
            cachedActiveLanguages = ['en', 'de', 'es', 'it'];
        }
    }
    return cachedActiveLanguages;
}

// Remove inactive language tracks entirely from the player
function filterTracksByActive(player, activeCodes) {
    const remoteTracks = player.remoteTextTracks();
    const tracksToRemove = [];
    for (let i = 0; i < remoteTracks.length; i++) {
        const track = remoteTracks[i];
        if (track.kind === 'subtitles' || track.kind === 'captions') {
            if (!activeCodes.includes(track.language)) {
                tracksToRemove.push(track);
            }
        }
    }
    tracksToRemove.forEach(track => player.removeRemoteTextTrack(track));
}

// Refresh all player subtitle tracks after add/remove
async function refreshSubtitleTracks() {
    cachedActiveLanguages = null;

    if (!CLOUDFRONT_HLS_URL) return;

    for (let i = 1; i <= 4; i++) {
        const player = videoPlayers[i];
        if (!player) continue;

        // Reset flag so addtrack handler re-applies filtering
        player._defaultSet = false;
        player.src({
            src: `${CLOUDFRONT_HLS_URL}?t=${Date.now()}`,
            type: 'application/x-mpegURL'
        });
        player.ready(() => {
            player.play();
        });
    }
}

// === Language Management API ===
async function fetchActiveLanguages() {
    const idToken = localStorage.getItem('id_token');
    const resp = await fetch(`${API_GATEWAY_URL}languages`, {
        headers: idToken ? { 'Authorization': idToken } : {}
    });
    return resp.json();
}

async function addLanguage(code) {
    const idToken = localStorage.getItem('id_token');
    const resp = await fetch(`${API_GATEWAY_URL}languages`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(idToken ? { 'Authorization': idToken } : {})
        },
        body: JSON.stringify({ code })
    });
    return resp.json();
}

async function removeLanguage(code) {
    const idToken = localStorage.getItem('id_token');
    const resp = await fetch(`${API_GATEWAY_URL}languages/${code}`, {
        method: 'DELETE',
        headers: idToken ? { 'Authorization': idToken } : {}
    });
    return resp.json();
}

// === Chatbot Engine (Strands Agent) ===
let chatSessionId = crypto.randomUUID();

let chatbotOpen = false;

// === Chatbot Drag (both panel and toggle icon) ===
function initDraggable(element) {
    let isDragging = false, hasMoved = false, startX, startY, startLeft, startTop;

    const onStart = (clientX, clientY) => {
        isDragging = true;
        hasMoved = false;
        const rect = element.getBoundingClientRect();
        startX = clientX;
        startY = clientY;
        startLeft = rect.left;
        startTop = rect.top;
        element.style.transition = 'none';
        document.body.style.userSelect = 'none';
    };

    const onMove = (clientX, clientY) => {
        if (!isDragging) return;
        const dx = clientX - startX;
        const dy = clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
        let newLeft = Math.max(0, Math.min(startLeft + dx, window.innerWidth - element.offsetWidth));
        let newTop = Math.max(0, Math.min(startTop + dy, window.innerHeight - element.offsetHeight));
        element.style.left = newLeft + 'px';
        element.style.top = newTop + 'px';
        element.style.right = 'auto';
        element.style.bottom = 'auto';
    };

    const onEnd = () => {
        if (!isDragging) return;
        isDragging = false;
        element.style.transition = '';
        document.body.style.userSelect = '';
    };

    element.addEventListener('mousedown', (e) => {
        if (e.target.closest('.chatbot-close')) return;
        onStart(e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
    document.addEventListener('mouseup', onEnd);

    element.addEventListener('touchstart', (e) => {
        if (e.target.closest('.chatbot-close')) return;
        onStart(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
        if (isDragging) onMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    document.addEventListener('touchend', onEnd);

    // Expose hasMoved so click handlers can check if it was a drag
    element._dragState = { get hasMoved() { return hasMoved; } };
}

document.addEventListener('DOMContentLoaded', () => {
    initDraggable(document.getElementById('chatbot-panel'));
    initDraggable(document.getElementById('chatbot-toggle'));
});

function toggleChatbot() {
    const panel = document.getElementById('chatbot-panel');
    const iconChat = document.getElementById('chatbot-icon-chat');
    const iconClose = document.getElementById('chatbot-icon-close');
    chatbotOpen = !chatbotOpen;

    if (chatbotOpen) {
        panel.style.display = 'flex';
        panel.classList.add('open');
        iconChat.style.display = 'none';
        iconClose.style.display = 'block';
        if (!document.getElementById('chatbot-messages').hasChildNodes()) {
            addBotMessage('Hello! I am your subtitle management assistant. How can I help you?');
            showQuickReplies(['Check languages', 'Add subtitle', 'Remove subtitle']);
        }
    } else {
        panel.style.display = 'none';
        panel.classList.remove('open');
        iconChat.style.display = 'block';
        iconClose.style.display = 'none';
    }
}

function addBotMessage(text) {
    const container = document.getElementById('chatbot-messages');
    const div = document.createElement('div');
    div.className = 'msg-bot';
    // Escape HTML entities for security, then convert newlines to <br>
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Bold text between ** **
    const formatted = escaped
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br>');
    div.innerHTML = formatted;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function addBotHTML(html) {
    const container = document.getElementById('chatbot-messages');
    const div = document.createElement('div');
    div.className = 'msg-bot';
    div.innerHTML = html;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function addUserMessage(text) {
    const container = document.getElementById('chatbot-messages');
    const div = document.createElement('div');
    div.className = 'msg-user';
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function showTyping() {
    const container = document.getElementById('chatbot-messages');
    const div = document.createElement('div');
    div.className = 'msg-typing';
    div.id = 'typing-indicator';
    div.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function hideTyping() {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
}

function showQuickReplies(replies) {
    const container = document.getElementById('chatbot-quick-replies');
    container.innerHTML = '';
    replies.forEach(text => {
        const btn = document.createElement('button');
        btn.className = 'quick-reply';
        btn.textContent = text;
        btn.onclick = () => {
            container.innerHTML = '';
            document.getElementById('chatbot-input-field').value = text;
            sendChatMessage();
        };
        container.appendChild(btn);
    });
}

async function sendChatMessage() {
    const input = document.getElementById('chatbot-input-field');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    document.getElementById('chatbot-quick-replies').innerHTML = '';
    addUserMessage(text);
    showTyping();

    try {
        const resp = await fetch(`${API_GATEWAY_URL}chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text, session_id: chatSessionId })
        });
        const data = await resp.json();
        hideTyping();

        if (data.error) {
            addBotMessage('Sorry, something went wrong. Please try again.');
        } else {
            addBotMessage(data.response);
            // Refresh subtitle tracks if a language was added or removed
            if (/added|activated|removed|deactivated|추가|활성|제거|비활성/i.test(data.response)) {
                await refreshSubtitleTracks();
            }
        }
        showQuickReplies(['Check languages', 'Add subtitle', 'Remove subtitle']);
    } catch (e) {
        hideTyping();
        addBotMessage('Connection error. Please try again.');
    }
}