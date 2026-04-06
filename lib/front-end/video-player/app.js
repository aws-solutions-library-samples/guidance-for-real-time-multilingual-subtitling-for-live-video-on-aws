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
                // so listen for 'addtrack' to filter/set defaults as tracks arrive
                videoPlayers[i]._subtitleTimer = null;
                videoPlayers[i].textTracks().on('addtrack', function() {
                    // Debounce: reset timer on each new track, run once after all tracks settle
                    clearTimeout(videoPlayers[i]._subtitleTimer);
                    videoPlayers[i]._subtitleTimer = setTimeout(() => setDefaultSubtitleLanguage(i), 500);
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
        await syncScreenMappingFromDB();

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

// Default language per screen (dynamically updated via chatbot)
let SCREEN_DEFAULT_LANGUAGE = { 1: 'en', 2: 'de', 3: 'es', 4: 'it' };

// Sync screen mapping from DB on page load so chatbot responses don't cause unnecessary refreshes
async function syncScreenMappingFromDB() {
    if (!API_GATEWAY_URL) return;
    try {
        const resp = await fetch(`${API_GATEWAY_URL}language-config?key=SCREEN_MAPPING`);
        const data = await resp.json();
        if (data && data.mapping) {
            for (const [screenId, langCode] of Object.entries(data.mapping)) {
                const id = parseInt(screenId);
                if (id >= 1 && id <= 4) {
                    SCREEN_DEFAULT_LANGUAGE[id] = langCode;
                }
            }
        }
    } catch (e) {
        // Keep defaults if fetch fails
    }
}

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

        // Clear debounce timer so addtrack handler re-applies filtering
        clearTimeout(player._subtitleTimer);
        player.src({
            src: `${CLOUDFRONT_HLS_URL}?t=${Date.now()}`,
            type: 'application/x-mpegURL'
        });
        player.ready(() => {
            player.play();
        });
    }
}

// Apply screen-to-language mapping received from chatbot.
// Only refreshes the specific players whose mapping actually changed.
async function applyScreenMapping(mapping) {
    const changedPlayerIds = [];
    for (const [screenId, langCode] of Object.entries(mapping)) {
        const id = parseInt(screenId);
        if (id >= 1 && id <= 4 && SCREEN_DEFAULT_LANGUAGE[id] !== langCode) {
            SCREEN_DEFAULT_LANGUAGE[id] = langCode;
            changedPlayerIds.push(id);
        }
    }

    if (changedPlayerIds.length === 0) return;

    // Invalidate language cache so fresh data is fetched
    cachedActiveLanguages = null;

    for (const playerId of changedPlayerIds) {
        const player = videoPlayers[playerId];
        if (!player) continue;

        // Check if the desired track already exists in this player
        const langCode = SCREEN_DEFAULT_LANGUAGE[playerId];
        if (hasTrack(player, langCode)) {
            // Track exists — just switch, no reload needed
            applyScreenLanguage(playerId, langCode);
        } else {
            // Track missing — reload only this player to pick up new HLS tracks
            refreshSinglePlayer(playerId);
        }
    }
}

// Check if a player already has a text track for the given language
function hasTrack(player, langCode) {
    const textTracks = player.textTracks();
    for (let i = 0; i < textTracks.length; i++) {
        if (textTracks[i].language === langCode) return true;
    }
    return false;
}

// Refresh only a single player's stream (leaves other players untouched)
function refreshSinglePlayer(playerId) {
    const player = videoPlayers[playerId];
    if (!player || !CLOUDFRONT_HLS_URL) return;

    clearTimeout(player._subtitleTimer);
    player.src({
        src: `${CLOUDFRONT_HLS_URL}?t=${Date.now()}`,
        type: 'application/x-mpegURL'
    });
    player.ready(() => {
        player.play();
        // After reload, wait for tracks to arrive then apply correct language
        player._subtitleTimer = setTimeout(() => setDefaultSubtitleLanguage(playerId), 1500);
    });
}

// Switch a specific screen's subtitle track to the given language.
// Keeps old subtitles visible while pre-loading the new track to avoid gaps.
function applyScreenLanguage(playerId, langCode) {
    const player = videoPlayers[playerId];
    if (!player) return;

    const textTracks = player.textTracks();
    let newTrack = null;

    // Step 1: Set new track to 'hidden' to start loading VTT data
    for (let i = 0; i < textTracks.length; i++) {
        const track = textTracks[i];
        if ((track.kind === 'subtitles' || track.kind === 'captions') && track.language === langCode) {
            track.mode = 'hidden';
            newTrack = track;
            break;
        }
    }

    if (!newTrack) {
        // Track not found — fallback to direct switch
        for (let i = 0; i < textTracks.length; i++) {
            const track = textTracks[i];
            if (track.kind === 'subtitles' || track.kind === 'captions') {
                track.mode = (track.language === langCode) ? 'showing' : 'disabled';
            }
        }
        updateLanguageDisplay(playerId);
        return;
    }

    // Step 2: Wait for VTT data to load, then do the final switch.
    // Check every 500ms for up to 4 seconds, or switch after timeout.
    let attempts = 0;
    const switcher = setInterval(() => {
        attempts++;
        const hasCues = newTrack.cues && newTrack.cues.length > 0;
        if (hasCues || attempts >= 8) {
            clearInterval(switcher);
            // Now swap: new track → showing, all others → disabled
            for (let i = 0; i < textTracks.length; i++) {
                const track = textTracks[i];
                if (track.kind === 'subtitles' || track.kind === 'captions') {
                    track.mode = (track.language === langCode) ? 'showing' : 'disabled';
                }
            }
            updateLanguageDisplay(playerId);
        }
    }, 500);
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
    initChatbotResize();
    initTranslationStyleSync();
});

function updatePanelScale(panel) {
    const baseW = 700, baseH = 600;
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const scale = Math.min(w / baseW, h / baseH);
    const clamped = Math.max(0.65, Math.min(1.2, scale));
    panel.style.setProperty('--panel-scale', clamped.toFixed(3));
}

function initChatbotResize() {
    const handle = document.getElementById('chatbot-resize-handle');
    const panel = document.getElementById('chatbot-panel');
    if (!handle || !panel) return;

    let isResizing = false;
    let startX, startY, startW, startH;

    handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        isResizing = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = panel.getBoundingClientRect();
        startW = rect.width;
        startH = rect.height;
        document.body.style.cursor = 'nw-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const dx = startX - e.clientX;
        const dy = startY - e.clientY;
        const newW = Math.max(350, Math.min(startW + dx, window.innerWidth * 0.9));
        const newH = Math.max(300, Math.min(startH + dy, window.innerHeight * 0.85));
        panel.style.width = newW + 'px';
        panel.style.height = newH + 'px';
        updatePanelScale(panel);
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });

    // Set initial scale
    const observer = new MutationObserver(() => {
        if (panel.style.display !== 'none') updatePanelScale(panel);
    });
    observer.observe(panel, { attributes: true, attributeFilter: ['style'] });
}

// Sync translation style from DynamoDB to body attribute for subtitle coloring
function initTranslationStyleSync() {
    function fetchAndApplyStyle() {
        if (!API_GATEWAY_URL) return;
        fetch(API_GATEWAY_URL + 'language-config?key=SETTINGS')
            .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(data => {
                const style = (data.value || 'energetic').toLowerCase();
                applyTranslationStyle(style);
            })
            .catch(() => {});
    }
    fetchAndApplyStyle();
    setInterval(fetchAndApplyStyle, 30000);
}

// Called when style is changed via chatbot
function applyTranslationStyle(style) {
    document.body.setAttribute('data-translation-style', style);
    // Update indicator bar
    const label = document.querySelector('.style-indicator-label');
    if (label) label.textContent = style.toUpperCase();
    document.querySelectorAll('.legend-item').forEach(item => {
        item.classList.toggle('active', item.getAttribute('data-style') === style);
    });
}

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
            showQuickReplySections();
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

// Show categorized quick reply sections
function showQuickReplySections() {
    const container = document.getElementById('chatbot-quick-replies');
    container.innerHTML = '';

    const sections = [
        {
            title: '🎭 Language Management',
            className: 'quick-reply-language',
            buttons: ['Check languages', 'Add subtitle', 'Remove subtitle']
        },
        {
            title: '🎨 Translation Quality',
            className: 'quick-reply-quality',
            buttons: ['Adjust style', 'Manage dictionary']
        }
    ];

    sections.forEach(section => {
        // Section title
        const titleDiv = document.createElement('div');
        titleDiv.className = 'quick-reply-section-title';
        titleDiv.textContent = section.title;
        container.appendChild(titleDiv);

        // Section buttons container
        const buttonsDiv = document.createElement('div');
        buttonsDiv.className = 'quick-reply-section';

        section.buttons.forEach(text => {
            const btn = document.createElement('button');
            btn.className = `quick-reply ${section.className}`;
            btn.textContent = text;
            btn.onclick = () => handleQuickReply(text);
            buttonsDiv.appendChild(btn);
        });

        container.appendChild(buttonsDiv);
    });
}

// Handle quick reply button clicks
function handleQuickReply(text) {
    document.getElementById('chatbot-quick-replies').innerHTML = '';

    // Handle special features locally and switch to appropriate tab
    if (text === 'Adjust style') {
        switchChatbotMenu('translation');
    } else if (text === 'Manage dictionary') {
        switchChatbotMenu('vocabulary');
    } else if (text === 'Check languages' || text === 'Add subtitle' || text === 'Remove subtitle') {
        // Language management - switch to languages tab but send message
        updateSidebarActive('languages');
        document.getElementById('chatbot-input-field').value = text;
        sendChatMessage();
    } else {
        // Default behavior - send to backend
        document.getElementById('chatbot-input-field').value = text;
        sendChatMessage();
    }
}

// Helper function to update sidebar active state without switching content
function updateSidebarActive(menu) {
    document.querySelectorAll('.chatbot-sidebar-item').forEach(item => {
        item.classList.remove('active');
    });
    const menuItem = document.querySelector(`[data-menu="${menu}"]`);
    if (menuItem) {
        menuItem.classList.add('active');
    }
}

// Show translation style adjustment options
function showTranslationStyleOptions() {
    addBotMessage('Please select your preferred translation style:');

    const container = document.getElementById('chatbot-quick-replies');
    const styles = [
        { name: 'Formal', desc: 'Professional, broadcast-standard language', icon: '🎩' },
        { name: 'Casual', desc: 'Relaxed, conversational tone', icon: '😊' },
        { name: 'Technical', desc: 'Precise, technical terminology', icon: '🔧' },
        { name: 'Energetic', desc: 'Exciting sports commentary style', icon: '⚡' }
    ];

    styles.forEach(style => {
        const btn = document.createElement('button');
        btn.className = 'quick-reply quick-reply-quality';
        btn.innerHTML = `${style.icon} <strong>${style.name}</strong><br><small>${style.desc}</small>`;
        btn.onclick = async () => {
            container.innerHTML = '';
            const message = `Set translation style to ${style.name.toLowerCase()}`;
            document.getElementById('chatbot-input-field').value = message;
            sendChatMessage();
        };
        container.appendChild(btn);
    });

    // Model selector
    const modelSection = document.createElement('div');
    modelSection.className = 'model-selector-section';
    modelSection.innerHTML = `
        <div class="model-selector-label">Translation Model</div>
        <div class="model-selector-row">
            <select id="model-select" class="model-select">
                <option value="us.amazon.nova-lite-v1:0">Amazon Nova Lite (Fast & Efficient)</option>
                <option value="us.amazon.nova-micro-v1:0">Amazon Nova Micro (Fastest)</option>
                <option value="us.amazon.nova-pro-v1:0">Amazon Nova Pro (Balanced)</option>
                <option value="us.anthropic.claude-haiku-4-5-20251001-v1:0">Claude Haiku 4.5 (Highest Quality)</option>
            </select>
            <button id="model-apply-btn" class="model-apply-btn">Apply</button>
        </div>
        <div id="model-status" class="model-status"></div>
    `;
    container.appendChild(modelSection);

    // Load current model and set dropdown
    fetchCurrentModel().then(currentModel => {
        const select = document.getElementById('model-select');
        if (select && currentModel) {
            select.value = currentModel;
        }
    });

    // Apply button handler
    modelSection.querySelector('#model-apply-btn').onclick = async () => {
        const select = document.getElementById('model-select');
        const status = document.getElementById('model-status');
        const selectedModel = select.value;
        const modelName = select.options[select.selectedIndex].text;

        status.textContent = 'Changing model...';
        status.className = 'model-status loading';

        try {
            const resp = await fetch(`${API_GATEWAY_URL}chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: `Change translation model to ${selectedModel}`,
                    session_id: chatSessionId
                })
            });
            const data = await resp.json();

            status.textContent = `Model: ${modelName}`;
            status.className = 'model-status success';
            addBotMessage(`Translation model changed to ${modelName}.`);
        } catch (e) {
            status.textContent = 'Failed to change model';
            status.className = 'model-status error';
        }
    };

    // Only show "Back to Chat" button if not in translation tab
    const activeSidebarItem = document.querySelector('.chatbot-sidebar-item.active');
    const activeMenu = activeSidebarItem ? activeSidebarItem.getAttribute('data-menu') : 'chat';

    if (activeMenu === 'chat') {
        const backBtn = document.createElement('button');
        backBtn.className = 'quick-reply';
        backBtn.textContent = '← Back to menu';
        backBtn.onclick = () => showQuickReplySections();
        container.appendChild(backBtn);
    }
}

async function fetchCurrentModel() {
    try {
        const resp = await fetch(`${API_GATEWAY_URL}chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'What model is currently being used for translation?', session_id: chatSessionId })
        });
        const data = await resp.json();
        const models = [
            'us.amazon.nova-lite-v1:0',
            'us.amazon.nova-micro-v1:0',
            'us.amazon.nova-pro-v1:0',
            'us.anthropic.claude-haiku-4-5-20251001-v1:0'
        ];
        for (const m of models) {
            if (data.response && data.response.includes(m)) return m;
        }
        if (data.response && data.response.toLowerCase().includes('nova lite')) return 'us.amazon.nova-lite-v1:0';
        if (data.response && data.response.toLowerCase().includes('nova micro')) return 'us.amazon.nova-micro-v1:0';
        if (data.response && data.response.toLowerCase().includes('nova pro')) return 'us.amazon.nova-pro-v1:0';
        if (data.response && data.response.toLowerCase().includes('haiku')) return 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
        return 'us.amazon.nova-micro-v1:0'; // Default to Nova Micro if can't determine
    } catch (e) {
        return 'us.amazon.nova-micro-v1:0'; // Default to Nova Micro on error
    }
}

// Show translation dictionary management interface
function showVocabularyManagement() {
    addBotMessage('Add translation mappings to control how specific terms are translated:');

    const container = document.getElementById('chatbot-quick-replies');

    // Translation mapping input section
    const inputSection = document.createElement('div');
    inputSection.className = 'vocabulary-input-section';
    inputSection.innerHTML = `
        <div style="margin-bottom: 12px;">
            <label style="display: block; font-size: 0.8rem; color: #999; margin-bottom: 4px;">Target Language:</label>
            <select id="target-language" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 6px; background: #2a2a3e; color: #fff;">
                <option value="ko">🇰🇷 Korean (ko)</option>
                <option value="ja">🇯🇵 Japanese (ja)</option>
                <option value="de">🇩🇪 German (de)</option>
                <option value="es">🇪🇸 Spanish (es)</option>
                <option value="it">🇮🇹 Italian (it)</option>
                <option value="fr">🇫🇷 French (fr)</option>
                <option value="pt">🇧🇷 Portuguese (pt)</option>
                <option value="zh">🇨🇳 Chinese (zh)</option>
            </select>
        </div>
        <div style="margin-bottom: 12px;">
            <label style="display: block; font-size: 0.8rem; color: #999; margin-bottom: 4px;">Original Term (English):</label>
            <input type="text" id="original-term" placeholder="e.g., Messi, goal, Champions League"
                   style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 6px; background: #2a2a3e; color: #fff;">
        </div>
        <div style="margin-bottom: 12px;">
            <label style="display: block; font-size: 0.8rem; color: #999; margin-bottom: 4px;">Translated Term:</label>
            <input type="text" id="translated-term" placeholder="e.g., 리오넬 메시, 득점, 챔피언스리그"
                   style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 6px; background: #2a2a3e; color: #fff;">
        </div>
        <button id="add-mapping-btn" class="quick-reply quick-reply-quality" style="width: 100%; margin-bottom: 12px;">
            Add Translation Mapping
        </button>
        <div style="text-align: center; margin-bottom: 12px;">
            <button id="show-mappings-btn" class="quick-reply quick-reply-quality" style="font-size: 0.75rem;">
                Show Current Mappings
            </button>
        </div>
    `;
    container.appendChild(inputSection);

    // Add mapping button handler
    document.getElementById('add-mapping-btn').onclick = async () => {
        const targetLang = document.getElementById('target-language').value;
        const originalTerm = document.getElementById('original-term').value.trim();
        const translatedTerm = document.getElementById('translated-term').value.trim();

        if (!originalTerm || !translatedTerm) {
            addBotMessage('⚠️ Please fill in both original and translated terms.');
            return;
        }

        const message = `Add translation mapping: original term "${originalTerm}" should be translated to "${translatedTerm}" in ${targetLang}`;

        document.getElementById('original-term').value = '';
        document.getElementById('translated-term').value = '';
        document.getElementById('chatbot-input-field').value = message;
        sendChatMessage();
    };

    // Show mappings button handler
    document.getElementById('show-mappings-btn').onclick = () => {
        const targetLang = document.getElementById('target-language').value;
        document.getElementById('chatbot-input-field').value = `Show translation mappings for ${targetLang}`;
        sendChatMessage();
    };

    // Only show "Back to menu" button if in chat tab
    const activeSidebarItem = document.querySelector('.chatbot-sidebar-item.active');
    const activeMenu = activeSidebarItem ? activeSidebarItem.getAttribute('data-menu') : 'chat';

    if (activeMenu === 'chat') {
        const backBtn = document.createElement('button');
        backBtn.className = 'quick-reply';
        backBtn.textContent = '← Back to menu';
        backBtn.onclick = () => showQuickReplySections();
        container.appendChild(backBtn);
    }
}


// Helper: Jump to timestamp in video players
function jumpToTimestamp(seconds) {
    ['video-player-1', 'video-player-2', 'video-player-3', 'video-player-4'].forEach(playerId => {
        const player = videojs(playerId);
        if (player) {
            player.currentTime(seconds);
            player.play();
        }
    });
    addBotMessage(`⏱️ Jumped to ${formatTimestamp(seconds)}`);
}

// Helper: Format seconds to HH:MM:SS
function formatTimestamp(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Helper: Highlight search match in text
function highlightMatch(text, query) {
    const regex = new RegExp(`(${query})`, 'gi');
    return text.replace(regex, '<mark style="background: #ffd700; padding: 2px 4px; border-radius: 2px;">$1</mark>');
}

// Switch chatbot menu from sidebar
function switchChatbotMenu(menu) {
    // Update sidebar active state
    document.querySelectorAll('.chatbot-sidebar-item').forEach(item => {
        item.classList.remove('active');
    });
    document.querySelector(`[data-menu="${menu}"]`).classList.add('active');

    // Clear messages and quick replies
    document.getElementById('chatbot-messages').innerHTML = '';
    document.getElementById('chatbot-quick-replies').innerHTML = '';

    // Show appropriate content based on menu
    switch(menu) {
        case 'chat':
            addBotMessage('Hello! I am your subtitle management assistant. How can I help you?');
            showQuickReplySections();
            break;
        case 'languages':
            addBotMessage('Manage subtitle languages:');
            const langContainer = document.getElementById('chatbot-quick-replies');
            langContainer.innerHTML = '';
            ['Check languages', 'Add subtitle', 'Remove subtitle'].forEach(text => {
                const btn = document.createElement('button');
                btn.className = 'quick-reply quick-reply-language';
                btn.textContent = text;
                btn.onclick = () => {
                    langContainer.innerHTML = '';
                    document.getElementById('chatbot-input-field').value = text;
                    sendChatMessage();
                };
                langContainer.appendChild(btn);
            });
            break;
        case 'translation':
            showTranslationStyleOptions();
            break;
        case 'vocabulary':
            showVocabularyManagement();
            break;
    }
}

// Poll for subtitle data readiness and notify chatbot when ready
let pendingScreenPoller = null;
function startSubtitleReadyPolling(pendingScreen) {
    const { screen_id, language_code } = pendingScreen;
    // Clear any existing poller
    if (pendingScreenPoller) clearInterval(pendingScreenPoller);

    // Pre-load the new language track in 'hidden' mode so VTT data is fetched
    // in the background. When the switch happens, data is already cached.
    const playerId = parseInt(screen_id);
    const player = videoPlayers[playerId];
    if (player) {
        const textTracks = player.textTracks();
        for (let i = 0; i < textTracks.length; i++) {
            if (textTracks[i].language === language_code) {
                textTracks[i].mode = 'hidden';
                break;
            }
        }
    }

    pendingScreenPoller = setInterval(async () => {
        try {
            const resp = await fetch(`${API_GATEWAY_URL}languages/check-subtitle/${language_code}`);
            const data = await resp.json();
            if (data.exists) {
                clearInterval(pendingScreenPoller);
                pendingScreenPoller = null;
                // Send system message to chatbot to trigger final screen switch
                await sendSystemChatMessage(
                    `[SYSTEM] ${language_code} subtitle data ready for screen ${screen_id}`
                );
            }
        } catch (e) {
            console.error('Subtitle polling error:', e);
        }
    }, 3000);

    // Stop polling after 5 minutes to avoid infinite polling
    setTimeout(() => {
        if (pendingScreenPoller) {
            clearInterval(pendingScreenPoller);
            pendingScreenPoller = null;
        }
    }, 300000);
}

// Send a system message to chatbot (automated, not user-initiated)
async function sendSystemChatMessage(systemMessage) {
    showTyping();
    try {
        const resp = await fetch(`${API_GATEWAY_URL}chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: systemMessage, session_id: chatSessionId })
        });
        const data = await resp.json();
        hideTyping();

        if (!data.error && data.response) {
            addBotMessage(data.response);
            if (data.screen_mapping) {
                await applyScreenMapping(data.screen_mapping);
            }
        }
    } catch (e) {
        hideTyping();
        console.error('System chat message error:', e);
    }
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
            // Apply screen language mapping from chatbot response
            // Refresh streams only when screen mapping actually changes (new language track needed)
            if (data.screen_mapping) {
                await applyScreenMapping(data.screen_mapping);
            }

            // Handle pending screen — poll for subtitle data then notify chatbot
            if (data.pending_screen) {
                startSubtitleReadyPolling(data.pending_screen);
            }

            // Apply translation style change to subtitle colors
            const styleMatch = data.response.match(/set to[:\s]*['"]?(energetic|formal|casual|technical)/i)
                || data.response.match(/updated to[:\s]*['"]?(energetic|formal|casual|technical)/i);
            if (styleMatch) {
                applyTranslationStyle(styleMatch[1].toLowerCase());
            }
        }

        // Only show quick reply sections if we're in the chat tab
        const activeSidebarItem = document.querySelector('.chatbot-sidebar-item.active');
        const activeMenu = activeSidebarItem ? activeSidebarItem.getAttribute('data-menu') : 'chat';

        if (activeMenu === 'chat') {
            showQuickReplySections();
        } else if (activeMenu === 'languages') {
            // For languages tab, show only language management buttons
            const container = document.getElementById('chatbot-quick-replies');
            container.innerHTML = '';
            ['Check languages', 'Add subtitle', 'Remove subtitle'].forEach(text => {
                const btn = document.createElement('button');
                btn.className = 'quick-reply quick-reply-language';
                btn.textContent = text;
                btn.onclick = () => {
                    container.innerHTML = '';
                    document.getElementById('chatbot-input-field').value = text;
                    sendChatMessage();
                };
                container.appendChild(btn);
            });
        }
    } catch (e) {
        hideTyping();
        addBotMessage('Connection error. Please try again.');
    }
}