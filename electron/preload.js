const { contextBridge, ipcRenderer } = require('electron');

const BACKEND_PORT = 8765;

contextBridge.exposeInMainWorld('electronAPI', {
    // Window controls
    resizeWindow: (width, height) => ipcRenderer.send('resize-window', { width, height }),
    setPanelResizable: (resizable) => ipcRenderer.send('set-panel-resizable', resizable),
    setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
    startDrag: () => ipcRenderer.send('start-drag'),
    dragMove: () => ipcRenderer.send('drag-move'),
    stopDrag: () => ipcRenderer.send('stop-drag'),
    closeWindow: () => ipcRenderer.send('close-window'),
    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    setAlwaysOnTop: (flag) => ipcRenderer.send('set-always-on-top', flag),
    openScreenshotWindow: (data) => ipcRenderer.send('open-screenshot-window', data),

    // Backend communication (REST — existing desktop agent)
    sendToBackend: async (endpoint, data) => {
        try {
            const response = await fetch(`http://127.0.0.1:${BACKEND_PORT}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            return await response.json();
        } catch (error) {
            console.error('Backend communication error:', error);
            return null;
        }
    },

    getFromBackend: async (endpoint) => {
        try {
            const response = await fetch(`http://127.0.0.1:${BACKEND_PORT}${endpoint}`);
            return await response.json();
        } catch (error) {
            console.error('Backend communication error:', error);
            return null;
        }
    },

    // ── Browser Agent Bridge Controls ─────────────────────────────────
    startBrowserTask: (goal, maxSteps, chatId, chatHistory) => ipcRenderer.send('start-browser-task', { goal, maxSteps, chatId, chatHistory }),
    stopBrowserTask: (data) => ipcRenderer.send('stop-browser-task', data || {}),
    resetBrowserSession: (chatId) => ipcRenderer.send('reset-browser-session', { chatId }),
    setSanitization: (enabled) => ipcRenderer.send('set-sanitization', { enabled }),
    getBrowserAgentState: () => ipcRenderer.invoke('get-browser-agent-state'),

    // ── Browser Agent Event Listeners ─────────────────────────────────
    onBrowserAgentTaskStarted: (callback) => {
        ipcRenderer.on('browser-agent-task-started', (event, data) => callback(data));
    },

    // Step telemetry with screenshots
    onBrowserAgentStep: (callback) => {
        ipcRenderer.on('browser-agent-step', (event, data) => callback(data));
    },

    // VLM decision (thought + tool call)
    onBrowserAgentDecision: (callback) => {
        ipcRenderer.on('browser-agent-decision', (event, data) => callback(data));
    },

    // Tool execution result
    onBrowserAgentToolResult: (callback) => {
        ipcRenderer.on('browser-agent-tool-result', (event, data) => callback(data));
    },

    // Task finished
    onBrowserAgentFinished: (callback) => {
        ipcRenderer.on('browser-agent-finished', (event, data) => callback(data));
    },

    // Task stopped
    onBrowserAgentStopped: (callback) => {
        ipcRenderer.on('browser-agent-stopped', (event, data) => callback(data));
    },

    // Extension connection status
    onBrowserAgentExtStatus: (callback) => {
        ipcRenderer.on('browser-agent-ext-status', (event, data) => callback(data));
    },

    // Backend connection status
    onBrowserAgentBackendStatus: (callback) => {
        ipcRenderer.on('browser-agent-backend-status', (event, data) => callback(data));
    },

    // Error messages
    onBrowserAgentError: (callback) => {
        ipcRenderer.on('browser-agent-error', (event, data) => callback(data));
    },

    // Status notifications
    onBrowserAgentStatus: (callback) => {
        ipcRenderer.on('browser-agent-status', (event, data) => callback(data));
    },

    // ── Ask User Interactive Bridge ──────────────────────────────────
    sendBrowserAgentUserReply: (answer) => ipcRenderer.send('browser-agent-user-reply', { answer }),
    onBrowserAgentAskUser: (callback) => {
        ipcRenderer.on('browser-agent-ask-user', (event, data) => callback(data));
    },

    // ── Unified Chats Sync Bridge ─────────────────────────────────────
    syncChats: (data) => ipcRenderer.send('sync-chats', data),
    switchChat: (chatId) => ipcRenderer.send('switch-chat', { chatId }),
    getSharedChats: () => ipcRenderer.invoke('get-shared-chats'),
    onSyncChatsFromExt: (callback) => {
        ipcRenderer.on('sync-chats-from-ext', (event, data) => callback(data));
    },
    onSwitchChatFromExt: (callback) => {
        ipcRenderer.on('switch-chat-from-ext', (event, data) => callback(data));
    },

    // ── Unified Settings Sync Bridge ──────────────────────────────────
    updateSetting: (key, value) => ipcRenderer.send('update-setting', { key, value }),
    onSyncSettingsFromExt: (callback) => {
        ipcRenderer.on('sync-settings-from-ext', (event, data) => callback(data));
    }
});
