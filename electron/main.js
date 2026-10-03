const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');

let mainWindow;
let viewerWindow = null;
let tray = null;

// ── Window Dimensions ───────────────────────────────────────────────────
const PILL_WIDTH = 520;
const PILL_HEIGHT = 48;
const PANEL_MIN_HEIGHT = 300;
const PANEL_MAX_HEIGHT = 700;

// ── Browser Agent Bridge State ──────────────────────────────────────────
const EXT_WS_PORT = 8766;
const BACKEND_WS_URL = 'ws://127.0.0.1:8765/ws/browser_agent';

let wss = null;               // WebSocket server for extension
let extSocket = null;          // Connected extension client
let backendSocket = null;      // Connection to Python backend
let backendReconnectTimer = null;
let browserAgentActive = false;
let browserAgentGoal = '';
let browserAgentStep = 0;
let currentChatId = null;
let currentChatHistory = [];
let isSidePanelOpen = false;
let lastSidepanelTriggerTime = 0;

// ── Unified Chats Persistence & Sync ─────────────────────────────────────
const CHATS_FILE = path.join(__dirname, '..', 'chats.json');
let sharedChats = [];
let sharedActiveChatId = null;
let lastSavedChatsJson = '';

// ── Unified Settings Persistence & Sync ──────────────────────────────────
const SETTINGS_FILE_PATH = path.join(__dirname, '..', 'backend', 'settings.json');

function readCurrentSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE_PATH)) {
            const raw = fs.readFileSync(SETTINGS_FILE_PATH, 'utf-8');
            return JSON.parse(raw);
        }
    } catch (e) {
        console.warn('⚠️ [Settings] Could not read settings.json:', e.message);
    }
    return {};
}

function saveCurrentSettings(partialSettings) {
    if (!partialSettings || typeof partialSettings !== 'object') return {};
    try {
        const current = readCurrentSettings();
        const updated = { ...current, ...partialSettings };
        fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(updated, null, 2), 'utf-8');
        return updated;
    } catch (e) {
        console.warn('⚠️ [Settings] Could not save settings.json:', e.message);
        return null;
    }
}

function loadSharedChats() {
    try {
        if (fs.existsSync(CHATS_FILE)) {
            const raw = fs.readFileSync(CHATS_FILE, 'utf-8');
            const data = JSON.parse(raw);
            if (data && Array.isArray(data.chats)) {
                sharedChats = data.chats;
                sharedActiveChatId = data.active_chat_id || (sharedChats[0] ? sharedChats[0].id : null);
                lastSavedChatsJson = JSON.stringify(sharedChats);
                console.log(`📁 [Chats] Loaded ${sharedChats.length} previous chats from disk`);
            }
        }
    } catch (e) {
        console.warn('⚠️ [Chats] Could not load chats.json:', e.message);
    }
}

function saveSharedChatsToFile(chats, activeChatId) {
    if (!Array.isArray(chats)) return;
    try {
        sharedChats = chats;
        if (activeChatId) sharedActiveChatId = activeChatId;
        lastSavedChatsJson = JSON.stringify(sharedChats);
        fs.writeFileSync(CHATS_FILE, JSON.stringify({
            chats: sharedChats,
            active_chat_id: sharedActiveChatId
        }, null, 2), 'utf-8');
    } catch (e) {
        console.warn('⚠️ [Chats] Could not save chats.json:', e.message);
    }
}

function createWindow() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    mainWindow = new BrowserWindow({
        width: PILL_WIDTH,
        height: PILL_HEIGHT,
        x: Math.floor((width - PILL_WIDTH) / 2),
        y: height - 460, // Higher up — panel expands downward from here

        // Transparent frameless floating UI
        transparent: true,
        frame: false,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        skipTaskbar: false,  // SHOW in taskbar like a real app
        hasShadow: false,

        // App icon
        icon: path.join(__dirname, 'icon.ico'),

        // Initial size constraints (will be updated dynamically)
        minWidth: PILL_WIDTH,
        minHeight: PILL_HEIGHT,

        backgroundColor: '#00000000',

        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadFile('controls.html');

    // Force always on top
    mainWindow.setAlwaysOnTop(true, 'screen-saver');

    // Initial mouse ignore so transparent areas pass clicks through
    mainWindow.setIgnoreMouseEvents(true, { forward: true });

    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    mainWindow.on('maximize', () => mainWindow.unmaximize());
    mainWindow.on('fullscreen', () => mainWindow.setFullScreen(false));
    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    console.log('✅ Click Window Created!');
}

function createTray() {
    const iconPath = path.join(__dirname, 'icon.png');
    const trayIcon = nativeImage.createFromPath(iconPath);
    tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));
    
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show Click', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
        { type: 'separator' },
        { label: 'Always on Top', type: 'checkbox', checked: true, click: (item) => {
            if (mainWindow) {
                if (item.checked) {
                    mainWindow.setAlwaysOnTop(true, 'screen-saver');
                } else {
                    mainWindow.setAlwaysOnTop(false);
                }
            }
        }},
        { type: 'separator' },
        { label: 'Quit', click: () => { shutdownAllServices(); setTimeout(() => app.exit(0), 150); } }
    ]);
    
    tray.setToolTip('Click');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// BROWSER AGENT BRIDGE — WebSocket Server (Extension) + Client (Backend)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Start WebSocket server on port 8766 for the browser extension to connect to.
 * Acts as a relay/proxy between extension and Python backend, while also
 * broadcasting all events to the Electron renderer for the UI.
 */
let pendingBrowserGoal = null;

function startExtensionWSServer() {
    wss = new WebSocketServer({ port: EXT_WS_PORT, path: '/ext' });
    console.log(`🌐 [Bridge] Extension WebSocket server started on ws://127.0.0.1:${EXT_WS_PORT}/ext`);

    wss.on('connection', (ws) => {
        console.log('🔗 [Bridge] Browser extension connected');
        extSocket = ws;
        sendToRenderer('browser-agent-ext-status', { connected: true });

        // If a task was started before extension connected, dispatch it immediately!
        if (pendingBrowserGoal) {
            const goalText = typeof pendingBrowserGoal === 'string' ? pendingBrowserGoal : pendingBrowserGoal.goal;
            console.log(`🚀 [Bridge] Extension connected! Dispatching queued task: "${goalText}"`);
            ws.send(JSON.stringify({
                type: 'start_task',
                goal: goalText,
                max_steps: pendingBrowserGoal.maxSteps || 40,
                chat_id: pendingBrowserGoal.chatId || currentChatId,
                chat_history: pendingBrowserGoal.chatHistory || currentChatHistory
            }));
            pendingBrowserGoal = null;
        }

        // Immediately sync unified previous chats to connected extension
        if (sharedChats && sharedChats.length > 0) {
            ws.send(JSON.stringify({
                type: 'sync_chats',
                chats: sharedChats,
                activeChatId: sharedActiveChatId
            }));
        }

        // Immediately sync current settings to connected extension
        const currentSettings = readCurrentSettings();
        if (currentSettings && Object.keys(currentSettings).length > 0) {
            ws.send(JSON.stringify({
                type: 'sync_settings',
                settings: currentSettings
            }));
        }

        ws.on('message', (raw) => {
            try {
                const data = JSON.parse(raw.toString());
                handleExtensionMessage(data);
            } catch (err) {
                console.error('⚠️ [Bridge] Extension message parse error:', err.message);
            }
        });

        ws.on('close', () => {
            console.log('🔌 [Bridge] Browser extension disconnected');
            extSocket = null;
            isSidePanelOpen = false;
            sendToRenderer('browser-agent-ext-status', { connected: false });
        });

        ws.on('error', (err) => {
            console.warn('⚠️ [Bridge] Extension socket error:', err.message);
        });
    });

    wss.on('error', (err) => {
        console.error('❌ [Bridge] WS Server error:', err.message);
    });
}

/**
 * Handle messages FROM the browser extension.
 * Forward to backend + broadcast to renderer UI.
 */
function handleExtensionMessage(data) {
    const msgType = data.type;

    if (msgType === 'step_context') {
        browserAgentStep = data.step || browserAgentStep + 1;
        if (data.chat_id) {
            currentChatId = data.chat_id;
        }

        // CRITICAL PATH FIRST: Forward to Python backend for VLM reasoning
        // Strip raw_image (backend never uses it) to reduce payload by ~40%
        const backendPayload = { ...data };
        delete backendPayload.raw_image;
        if (!backendPayload.chat_id && currentChatId) {
            backendPayload.chat_id = currentChatId;
        }
        if (!backendPayload.chat_history && currentChatHistory) {
            backendPayload.chat_history = currentChatHistory;
        }
        forwardToBackend(backendPayload);

        // THEN send step telemetry + sanitized image to renderer UI for display
        sendToRenderer('browser-agent-step', {
            step: data.step,
            sanitizedImage: data.sanitized_image || '',
            rawImage: data.raw_image || '',
            telemetry: data.telemetry || {},
            url: data.url || '',
            title: data.title || '',
            domElementCount: (data.dom_elements || []).length,
            chatId: data.chat_id || currentChatId
        });

    } else if (msgType === 'tool_result') {
        // Tool execution result from extension
        sendToRenderer('browser-agent-tool-result', {
            step: data.step,
            success: data.success,
            result: data.result,
            chatId: data.chat_id || currentChatId
        });

        // Forward to backend
        const backendResult = { ...data };
        if (!backendResult.chat_id && currentChatId) {
            backendResult.chat_id = currentChatId;
        }
        forwardToBackend(backendResult);

    } else if (msgType === 'ask_user' || msgType === 'ASK_USER') {
        console.log('❓ [Bridge] Extension requested user input:', data.question);
        sendToRenderer('browser-agent-ask-user', {
            question: data.question || '',
            options: data.options || [],
            timeoutMs: data.timeoutMs || 180000,
            chatId: data.chat_id || currentChatId
        });

    } else if (msgType === 'task_error') {
        console.warn('⚠️ [Bridge] Extension reported error:', data.message);
        browserAgentActive = false;
        sendToRenderer('browser-agent-error', {
            message: data.message || 'Browser task encountered an issue.',
            chatId: data.chat_id || currentChatId
        });

    } else if (msgType === 'start_task') {
        browserAgentActive = true;
        browserAgentGoal = data.goal;
        browserAgentStep = 0;
        if (data.chat_id) currentChatId = data.chat_id;
        console.log(`🚀 [Bridge] Task started from extension: "${data.goal}"`);
        sendToRenderer('browser-agent-task-started', {
            goal: data.goal,
            chatId: currentChatId
        });

    } else if (msgType === 'switch_chat') {
        const targetChatId = data.chatId || data.chat_id;
        if (targetChatId) {
            sharedActiveChatId = targetChatId;
            currentChatId = targetChatId;
            console.log(`💬 [Bridge] Extension switched chat: ${targetChatId}`);
            sendToRenderer('switch-chat-from-ext', { chatId: targetChatId });
        }
    } else if (msgType === 'task_stopped' || msgType === 'stop_task') {
        browserAgentActive = false;
        const targetChat = data.chat_id || currentChatId;
        console.log(`🛑 [Bridge] Task stopped from extension (chat: ${targetChat || 'all'})`);
        sendToRenderer('browser-agent-stopped', {
            chatId: targetChat
        });
        if (backendSocket && backendSocket.readyState === WebSocket.OPEN) {
            backendSocket.send(JSON.stringify({ type: 'stop_task', chat_id: targetChat }));
        }
    } else if (msgType === 'ping') {
        // Heartbeat — respond directly
        if (extSocket && extSocket.readyState === WebSocket.OPEN) {
            extSocket.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        }
    } else if (msgType === 'request_chats') {
        if (extSocket && extSocket.readyState === WebSocket.OPEN) {
            extSocket.send(JSON.stringify({
                type: 'sync_chats',
                chats: sharedChats,
                activeChatId: sharedActiveChatId
            }));
        }
    } else if (msgType === 'sync_chats') {
        const incomingJson = JSON.stringify(data.chats || []);
        if (incomingJson === lastSavedChatsJson && data.activeChatId === sharedActiveChatId) {
            return;
        }
        console.log(`💬 [Bridge] Syncing ${(data.chats || []).length} chats from extension`);
        saveSharedChatsToFile(data.chats, data.activeChatId);
        sendToRenderer('sync-chats-from-ext', {
            chats: data.chats,
            activeChatId: data.activeChatId
        });
    } else if (msgType === 'sidepanel_state') {
        isSidePanelOpen = !!data.isOpen;
        console.log(`📑 [Bridge] Chrome extension sidepanel state: ${isSidePanelOpen ? 'OPEN ✅' : 'CLOSED ❌'}`);
    } else if (msgType === 'update_setting') {
        const { key, value } = data;
        if (key) {
            console.log(`🔧 [Bridge] Setting updated from extension: ${key} = ${value}`);
            saveCurrentSettings({ [key]: value });
            // Forward to Python backend
            if (backendSocket && backendSocket.readyState === WebSocket.OPEN) {
                backendSocket.send(JSON.stringify({ action: 'update_setting', key, value }));
            }
            sendToRenderer('sync-settings-from-ext', { key, value });
        }
    } else if (msgType === 'request_settings') {
        const currentSettings = readCurrentSettings();
        if (extSocket && extSocket.readyState === WebSocket.OPEN) {
            extSocket.send(JSON.stringify({
                type: 'sync_settings',
                settings: currentSettings
            }));
        }
    }
}

/**
 * Connect to the Python backend WebSocket at /ws/browser_agent.
 * Reconnects automatically on disconnect.
 */
let backendConnectAttempts = 0;

function connectToBackend() {
    if (backendSocket && (backendSocket.readyState === WebSocket.OPEN || backendSocket.readyState === WebSocket.CONNECTING)) {
        return;
    }

    try {
        backendSocket = new WebSocket(BACKEND_WS_URL);

        backendSocket.on('open', () => {
            console.log('🟢 [Bridge] Connected to Python backend');
            backendConnectAttempts = 0;
            sendToRenderer('browser-agent-backend-status', { connected: true });
            if (backendReconnectTimer) {
                clearTimeout(backendReconnectTimer);
                backendReconnectTimer = null;
            }
        });

        backendSocket.on('message', (raw) => {
            try {
                const data = JSON.parse(raw.toString());
                handleBackendMessage(data);
            } catch (err) {
                console.error('⚠️ [Bridge] Backend message parse error:', err.message);
            }
        });

        backendSocket.on('close', () => {
            backendSocket = null;
            sendToRenderer('browser-agent-backend-status', { connected: false });
            backendConnectAttempts++;
            const delay = backendConnectAttempts <= 5 ? 400 : 3000;
            if (backendConnectAttempts > 5) {
                console.log('🔌 [Bridge] Backend disconnected. Reconnecting in 3s...');
            }
            backendReconnectTimer = setTimeout(connectToBackend, delay);
        });

        backendSocket.on('error', (err) => {
            if (backendConnectAttempts > 5) {
                console.warn('⚠️ [Bridge] Backend connection error:', err.message);
            }
        });
    } catch (e) {
        backendConnectAttempts++;
        const delay = backendConnectAttempts <= 5 ? 400 : 3000;
        backendReconnectTimer = setTimeout(connectToBackend, delay);
    }
}

/**
 * Handle messages FROM the Python backend (VLM decisions).
 * Forward tool_call to extension + broadcast to renderer UI.
 */
function handleBackendMessage(data) {
    const msgType = data.type;

    if (msgType === 'tool_call') {
        const decision = data.decision || {};

        const taskChatId = data.chat_id || currentChatId;

        // Ensure chat_id is retained when forwarding down to the extension
        data.chat_id = taskChatId;
        forwardToExtension(data);

        // Send VLM decision to renderer UI
        sendToRenderer('browser-agent-decision', {
            step: data.step,
            thought: decision.thought || '',
            privacyNote: decision.privacy_note || '',
            tool: decision.tool || 'wait',
            args: decision.args || {},
            chatId: taskChatId
        });

        // Check if task is finished
        if (decision.tool === 'finish_task') {
            browserAgentActive = false;
            sendToRenderer('browser-agent-finished', {
                summary: (decision.args || {}).summary || decision.thought || 'Task completed.',
                chatId: taskChatId
            });
        } else if (decision.tool === 'ask_user') {
            sendToRenderer('browser-agent-ask-user', {
                question: (decision.args || {}).question || 'Agent needs your input',
                options: (decision.args || {}).options || ['Yes', 'No', 'Continue'],
                timeoutMs: (decision.args || {}).timeout_ms || 180000,
                chatId: taskChatId
            });
        }

    } else if (msgType === 'tool_ack') {
        // Backend acknowledged tool result, extension can proceed
        // (Extension handles its own step timing, but we log it)
        console.log(`✅ [Bridge] Backend ACK for step ${data.step}`);

    } else if (msgType === 'session_cleared') {
        console.log('🔄 [Bridge] Backend session cleared');

    } else if (msgType === 'pong') {
        // Heartbeat response
    }
}

/**
 * Forward a message to the Python backend.
 */
function forwardToBackend(data) {
    if (backendSocket && backendSocket.readyState === WebSocket.OPEN) {
        backendSocket.send(JSON.stringify(data));
    } else {
        console.warn('⚠️ [Bridge] Cannot forward to backend — not connected');
        sendToRenderer('browser-agent-error', {
            message: 'Python backend not connected. Start the server with: python server.py'
        });
    }
}

/**
 * Forward a message to the browser extension.
 */
function forwardToExtension(data) {
    if (extSocket && extSocket.readyState === WebSocket.OPEN) {
        extSocket.send(JSON.stringify(data));
    } else {
        console.warn('⚠️ [Bridge] Cannot forward to extension — not connected');
    }
}

/**
 * Send a message to the Electron renderer (controls.html).
 */
function sendToRenderer(channel, data) {
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send(channel, data);
    }
}


// ── IPC: Browser Agent Controls from Renderer ───────────────────────────

/**
 * Focus Google Chrome window when tasks start.
 */
function focusChromeWindow() {
    const psScript = `$w = New-Object -ComObject WScript.Shell; if (-not $w.AppActivate('Google Chrome')) { $w.AppActivate('Chrome') }`;
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`, () => {});
}

/**
 * Auto-launch Google Chrome if the Click extension is not currently connected.
 * If already connected and running, does nothing.
 */
function launchBrowserIfClosed() {
    if (extSocket && extSocket.readyState === WebSocket.OPEN) {
        focusChromeWindow();
        return; // Already open and connected
    }

    console.log('🌐 [Bridge] Extension not connected. Auto-launching Chrome browser...');
    const candidates = [
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];

    let foundPath = candidates.find(p => {
        try { return fs.existsSync(p); } catch (e) { return false; }
    });

    const onLaunched = () => {
        setTimeout(() => {
            focusChromeWindow();
        }, 1200);
    };

    if (foundPath) {
        exec(`"${foundPath}"`, (err) => {
            if (err) {
                console.warn('⚠️ [Bridge] Direct launch failed, trying fallback "start chrome":', err.message);
                exec('start chrome', () => onLaunched());
            } else {
                onLaunched();
            }
        });
    } else {
        exec('start chrome', (err) => {
            if (err) console.warn('⚠️ [Bridge] Fallback launch failed:', err.message);
            else onLaunched();
        });
    }
}

ipcMain.on('start-browser-task', (event, { goal, maxSteps, chatId, chatHistory }) => {
    browserAgentActive = true;
    currentChatId = chatId || null;
    currentChatHistory = chatHistory || [];
    browserAgentGoal = goal;
    browserAgentStep = 0;
    const taskMaxSteps = maxSteps || 40;
    console.log(`🚀 [Bridge] Starting browser task: "${goal}" (chat: ${chatId}, maxSteps: ${taskMaxSteps})`);

    // Tell extension to start the task
    if (extSocket && extSocket.readyState === WebSocket.OPEN) {
        pendingBrowserGoal = null;
        extSocket.send(JSON.stringify({
            type: 'start_task',
            goal: goal,
            max_steps: taskMaxSteps,
            chat_id: chatId,
            chat_history: chatHistory
        }));
        focusChromeWindow();
    } else {
        pendingBrowserGoal = { goal, maxSteps: taskMaxSteps, chatId, chatHistory };
        console.log(`⏳ [Bridge] Extension not ready yet. Queued task "${goal}". Auto-opening browser...`);
        sendToRenderer('browser-agent-status', {
            message: 'Auto-opening browser and connecting extension...',
            chatId: chatId
        });
        // Auto-launch the exact browser where extension is loaded!
        launchBrowserIfClosed();
    }
});

ipcMain.on('stop-browser-task', (event, data = {}) => {
    const targetChat = data.chatId || currentChatId;
    if (!browserAgentActive) {
        // If task is not active, do not broadcast stop to extension to prevent false "Task stopped" messages
        return;
    }
    browserAgentActive = false;
    console.log(`🛑 [Bridge] Stopping browser task (chat: ${targetChat || 'all'})`);

    if (extSocket && extSocket.readyState === WebSocket.OPEN) {
        extSocket.send(JSON.stringify({ type: 'stop_task', chat_id: targetChat }));
    }

    // Stop backend session
    if (backendSocket && backendSocket.readyState === WebSocket.OPEN) {
        backendSocket.send(JSON.stringify({ type: 'stop_task', chat_id: targetChat }));
    }
});

ipcMain.on('switch-chat', (event, { chatId }) => {
    if (!chatId) return;
    sharedActiveChatId = chatId;
    currentChatId = chatId;
    console.log(`💬 [Bridge] Electron switched chat: ${chatId}`);
    if (extSocket && extSocket.readyState === WebSocket.OPEN) {
        extSocket.send(JSON.stringify({
            type: 'switch_chat',
            chatId: chatId
        }));
    }
});

ipcMain.on('reset-browser-session', (event, data = {}) => {
    const targetChat = data.chatId || currentChatId;
    console.log(`🔄 [Bridge] Resetting browser session (chat: ${targetChat || 'all'})`);
    browserAgentActive = false;
    if (!targetChat || targetChat === currentChatId) {
        currentChatId = null;
        currentChatHistory = [];
    }

    if (extSocket && extSocket.readyState === WebSocket.OPEN) {
        extSocket.send(JSON.stringify({ type: 'reset_session', chat_id: targetChat }));
    }

    if (backendSocket && backendSocket.readyState === WebSocket.OPEN) {
        backendSocket.send(JSON.stringify({ type: 'reset_session', chat_id: targetChat }));
    }
});

ipcMain.handle('get-browser-agent-state', () => {
    return {
        active: browserAgentActive,
        goal: browserAgentGoal,
        step: browserAgentStep,
        extensionConnected: extSocket !== null && extSocket.readyState === WebSocket.OPEN,
        backendConnected: backendSocket !== null && backendSocket.readyState === WebSocket.OPEN
    };
});

// Sanitization toggle — relay from Electron UI to Chrome extension via bridge
ipcMain.on('set-sanitization', (event, { enabled }) => {
    console.log(`🔧 [Bridge] Sanitization toggle: ${enabled ? 'ON ✅' : 'OFF ⚡'}`);
    if (extSocket && extSocket.readyState === WebSocket.OPEN) {
        extSocket.send(JSON.stringify({ type: 'set_sanitization', enabled: enabled }));
    } else {
        console.warn('⚠️ [Bridge] Extension not connected — cannot toggle sanitization');
    }
});

// User reply to ask_user tool — relay from Electron UI to Chrome extension & Python backend
ipcMain.on('browser-agent-user-reply', (event, { answer }) => {
    console.log(`💬 [Bridge] User answered ask_user prompt: "${answer}"`);
    forwardToExtension({
        type: 'USER_REPLY',
        answer: answer
    });
    forwardToBackend({
        type: 'user_reply',
        answer: answer
    });
});

// ── UNIFIED CHATS SYNC (Bridge Relay between Electron UI & Extension UI) ──
ipcMain.on('sync-chats', (event, { chats, activeChatId }) => {
    const incomingJson = JSON.stringify(chats || []);
    if (incomingJson === lastSavedChatsJson && activeChatId === sharedActiveChatId) {
        return;
    }
    saveSharedChatsToFile(chats, activeChatId);
    if (extSocket && extSocket.readyState === WebSocket.OPEN) {
        extSocket.send(JSON.stringify({
            type: 'sync_chats',
            chats: chats,
            activeChatId: activeChatId
        }));
    }
});

ipcMain.handle('get-shared-chats', () => {
    return {
        chats: sharedChats,
        activeChatId: sharedActiveChatId
    };
});

// ── UNIFIED SETTINGS SYNC (Bridge Relay between Electron UI & Extension UI) ──
ipcMain.on('update-setting', (event, { key, value }) => {
    saveCurrentSettings({ [key]: value });
    if (extSocket && extSocket.readyState === WebSocket.OPEN) {
        extSocket.send(JSON.stringify({
            type: 'sync_settings',
            settings: { [key]: value }
        }));
    }
});

// ── DYNAMIC WINDOW RESIZE (Panel expand/collapse) ─────────────────────

ipcMain.on('resize-window', (event, { width, height }) => {
    if (!mainWindow) return;
    
    const bounds = mainWindow.getBounds();
    
    // Panel opens BELOW pill — same X/Y position, just grow height downward
    mainWindow.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: width,
        height: height
    });
});

ipcMain.on('set-panel-resizable', (event, resizable) => {
    // Allow vertical resize only when panel is open
    if (mainWindow) {
        mainWindow.setResizable(resizable);
        if (resizable) {
            mainWindow.setMinimumSize(PILL_WIDTH, PILL_HEIGHT + PANEL_MIN_HEIGHT);
            mainWindow.setMaximumSize(PILL_WIDTH, PILL_HEIGHT + PANEL_MAX_HEIGHT);
        } else {
            mainWindow.setMinimumSize(PILL_WIDTH, PILL_HEIGHT);
            mainWindow.setMaximumSize(PILL_WIDTH, PILL_HEIGHT);
        }
    }
});

// ── DRAG LOGIC (Fixed DPI & Freeze Dimensions) ────────────────────────
let isDraggingWindow = false;
let startWinBounds = null;
let startCursorPos = null;

ipcMain.on('start-drag', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    isDraggingWindow = true;
    startWinBounds = mainWindow.getBounds(); // Capture exact width/height
    startCursorPos = screen.getCursorScreenPoint();
});

ipcMain.on('drag-move', () => {
    if (!mainWindow || mainWindow.isDestroyed() || !isDraggingWindow || !startWinBounds || !startCursorPos) return;
    const curCursor = screen.getCursorScreenPoint();
    const deltaX = curCursor.x - startCursorPos.x;
    const deltaY = curCursor.y - startCursorPos.y;

    // Explicitly lock width and height to prevent DPI scaling inflation
    mainWindow.setBounds({
        x: Math.round(startWinBounds.x + deltaX),
        y: Math.round(startWinBounds.y + deltaY),
        width: startWinBounds.width,
        height: startWinBounds.height
    });
});

ipcMain.on('stop-drag', () => {
    isDraggingWindow = false;
    startWinBounds = null;
    startCursorPos = null;
});

// ── HIT TEST & WINDOW CONTROLS ───────────────────────────────────────

ipcMain.on('set-ignore-mouse', (event, ignore) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (ignore) {
            mainWindow.setIgnoreMouseEvents(true, { forward: true });
        } else {
            mainWindow.setIgnoreMouseEvents(false);
        }
    }
});

ipcMain.on('set-always-on-top', (event, flag) => {
    if (mainWindow) {
        if (flag) {
            mainWindow.setAlwaysOnTop(true, 'screen-saver');
            mainWindow.moveTop();
            mainWindow.show();
        } else {
            mainWindow.setAlwaysOnTop(false);
        }
    }
});

let isShuttingDown = false;

/**
 * Cleanly shut down all services, close WebSocket servers and connections,
 * and stop the Python backend on port 8765.
 */
function shutdownAllServices() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('🛑 [Click] Shutting down all services and connections...');

    // 1. Notify extension and terminate client socket
    if (extSocket) {
        try {
            extSocket.send(JSON.stringify({ type: 'backend_shutdown', connected: false }));
            extSocket.terminate();
        } catch (e) {}
        extSocket = null;
    }

    // 2. Terminate all extension WS clients and close server
    if (wss) {
        try {
            if (wss.clients) {
                wss.clients.forEach(client => {
                    try { client.terminate(); } catch (e) {}
                });
            }
            wss.close();
        } catch (e) {}
        wss = null;
    }

    // 3. Terminate backend socket
    if (backendSocket) {
        try { backendSocket.terminate(); } catch (e) {}
        backendSocket = null;
    }

    // 4. Request Python backend shutdown via HTTP
    try {
        const req = http.get('http://127.0.0.1:8765/api/shutdown', () => {});
        req.on('error', () => {});
        req.setTimeout(400, () => req.destroy());
    } catch (e) {}

    // 5. Windows fallback: terminate any process listening on 8765
    if (process.platform === 'win32') {
        try {
            exec('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"', () => {});
        } catch (e) {}
    }

    // 6. Clean up system tray
    if (tray) {
        try { tray.destroy(); } catch (e) {}
        tray = null;
    }
}

ipcMain.on('close-window', () => {
    shutdownAllServices();
    if (mainWindow) {
        mainWindow.destroy();
        mainWindow = null;
    }
    if (viewerWindow && !viewerWindow.isDestroyed()) {
        viewerWindow.destroy();
        viewerWindow = null;
    }
    setTimeout(() => {
        app.exit(0);
    }, 150);
});

ipcMain.on('minimize-window', () => {
    if (mainWindow) mainWindow.minimize();
});

// ── SCREENSHOT VIEWER WINDOW ──────────────────────────────────────────

ipcMain.on('open-screenshot-window', (event, payload) => {
    if (viewerWindow && !viewerWindow.isDestroyed()) {
        viewerWindow.show();
        viewerWindow.focus();
        viewerWindow.webContents.send('load-screenshot', payload);
        return;
    }

    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

    const winWidth = Math.min(1200, Math.max(900, Math.floor(screenWidth * 0.82)));
    const winHeight = Math.min(840, Math.max(620, Math.floor(screenHeight * 0.82)));

    viewerWindow = new BrowserWindow({
        width: winWidth,
        height: winHeight,
        minWidth: 700,
        minHeight: 480,
        x: Math.floor((screenWidth - winWidth) / 2),
        y: Math.floor((screenHeight - winHeight) / 2),
        backgroundColor: '#0a0d14',
        frame: false,
        hasShadow: true,
        title: 'Click — Visual Context Inspector',
        icon: path.join(__dirname, 'icon.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload_viewer.js')
        }
    });

    viewerWindow.loadFile('screenshot_viewer.html');

    viewerWindow.webContents.once('did-finish-load', () => {
        viewerWindow.webContents.send('load-screenshot', payload);
    });

    viewerWindow.on('closed', () => {
        viewerWindow = null;
    });
});

ipcMain.on('close-viewer-window', () => {
    if (viewerWindow && !viewerWindow.isDestroyed()) {
        viewerWindow.close();
    }
});

ipcMain.on('minimize-viewer-window', () => {
    if (viewerWindow && !viewerWindow.isDestroyed()) {
        viewerWindow.minimize();
    }
});

ipcMain.on('maximize-viewer-window', () => {
    if (viewerWindow && !viewerWindow.isDestroyed()) {
        if (viewerWindow.isMaximized()) {
            viewerWindow.unmaximize();
        } else {
            viewerWindow.maximize();
        }
    }
});

ipcMain.on('copy-screenshot-image', (event, dataUrl) => {
    try {
        if (!dataUrl) return;
        const img = nativeImage.createFromDataURL(dataUrl);
        clipboard.writeImage(img);
    } catch (e) {
        console.error('Failed to copy image to clipboard:', e);
    }
});

ipcMain.on('save-screenshot-image', async (event, dataUrl) => {
    try {
        if (!dataUrl) return;
        const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        
        const { filePath, canceled } = await dialog.showSaveDialog(viewerWindow || mainWindow, {
            title: 'Save Context Screenshot',
            defaultPath: path.join(app.getPath('pictures'), `click_screenshot_${Date.now()}.jpg`),
            filters: [{ name: 'JPEG Image', extensions: ['jpg', 'jpeg'] }]
        });

        if (!canceled && filePath) {
            fs.writeFileSync(filePath, buffer);
        }
    } catch (e) {
        console.error('Failed to save screenshot image:', e);
    }
});

// ── APP LIFECYCLE ─────────────────────────────────────────────────────

app.whenReady().then(() => {
    loadSharedChats();
    createWindow();
    createTray();

    // Start the browser agent bridge
    startExtensionWSServer();
    connectToBackend();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    shutdownAllServices();
    if (process.platform !== 'darwin') {
        setTimeout(() => app.exit(0), 150);
    }
});

app.on('before-quit', () => {
    shutdownAllServices();
});
