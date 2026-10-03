/**
 * PrivaPilot — Extension Background Service Worker (SIH26171) v3.0
 *
 * Fully resilient Manifest V3 background service worker:
 * - Maintains active connection to Electron Bridge (ws://127.0.0.1:8766/ext)
 * - Uses direct chrome.scripting.executeScript for in-tab DOM extraction & tool execution
 * - Routes ML inference (face detection, OCR) to chrome.offscreen document
 * - Client-side PII detection via 3-layer parallel pipeline:
 *     Layer 1: DOM regex scan (content script)
 *     Layer 2: ONNX face detection (offscreen doc)
 *     Layer 3: Tesseract.js OCR + NER (offscreen doc)
 * - Canvas redaction with StackBlur happens in offscreen doc
 */

const BRIDGE_WS_URL = 'ws://127.0.0.1:8766/ext';
let socket = null;
let isBackendConnected = false;
let currentTaskGoal = null;
let isTaskActive = false;
let currentStep = 0;
let activeTargetTabId = null;
let maxSteps = 40;
let currentChatId = null;
let currentChatHistory = [];

// ML Engine state
let mlEngineReady = false;
let mlEngineStatus = {};

// Sanitization bypass toggle — when false, raw screenshots go directly to the agent (no ML processing)
let sanitizationEnabled = true;

// Ensure clicking extension action button opens the side panel by default
try {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
  if (chrome.sidePanel && chrome.sidePanel.setOptions) {
    chrome.sidePanel.setOptions({ path: 'sidepanel/index.html', enabled: true }).catch(() => {});
  }
} catch (e) {}

let lastOutgoingSyncSignature = '';
let lastIncomingSyncSignature = '';

// Listen for config messages from sidepanel / popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TOGGLE_SANITIZATION') {
    sanitizationEnabled = !!msg.enabled;
    console.log(`🔧 [PrivaPilot] Sanitization ${sanitizationEnabled ? 'ENABLED ✅' : 'DISABLED ⚡ (raw screenshots → agent)'}`);
    broadcastToUI({ type: 'SANITIZATION_STATUS', enabled: sanitizationEnabled });
    sendResponse({ enabled: sanitizationEnabled });
    return true;
  }
  if (msg.type === 'GET_SANITIZATION_STATUS') {
    sendResponse({ enabled: sanitizationEnabled });
    return true;
  }
  if (msg.type === 'GET_CONNECTION_STATUS') {
    const isConnected = socket && socket.readyState === WebSocket.OPEN;
    sendResponse({ connected: !!isConnected });
    return true;
  }
  if (msg.type === 'RECONNECT_BRIDGE') {
    console.log('🔄 [PrivaPilot] Bridge reconnect requested from UI');
    if (socket && socket.readyState !== WebSocket.OPEN) {
      try { socket.close(); } catch (e) {}
      socket = null;
    }
    initWebSocket();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'UPDATE_SETTING_TO_BRIDGE') {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'update_setting',
        key: msg.key,
        value: msg.value
      }));
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'SWITCH_CHAT_TO_BRIDGE') {
    const targetChatId = msg.chatId || msg.chat_id;
    if (targetChatId) {
      currentChatId = targetChatId;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'switch_chat',
          chatId: targetChatId
        }));
      }
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'SYNC_CHATS_TO_BRIDGE') {
    const payloadStr = JSON.stringify(msg.chats || []);
    const signature = `${msg.activeChatId || ''}::${payloadStr}`;
    if (signature !== lastOutgoingSyncSignature) {
      lastOutgoingSyncSignature = signature;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'sync_chats',
          chats: msg.chats,
          activeChatId: msg.activeChatId
        }));
      }
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'REQUEST_CHATS_FROM_BRIDGE') {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'request_chats' }));
    }
    sendResponse({ ok: true });
    return true;
  }
});

// ── STEP WATCHDOG & RECONNECTION RESILIENCE ─────────────────────────────────
let stepWatchdogTimer = null;

function clearStepWatchdog() {
  if (stepWatchdogTimer) {
    clearTimeout(stepWatchdogTimer);
    stepWatchdogTimer = null;
  }
}

function startStepWatchdog() {
  clearStepWatchdog();
  stepWatchdogTimer = setTimeout(() => {
    if (isTaskActive) {
      console.warn(`⚠️ [PrivaPilot] Step ${currentStep} timed out waiting for backend (75s). Re-triggering step...`);
      runTaskStep();
    }
  }, 75000);
}

// ── WEBSOCKET MANAGEMENT (Dedicated Electron Bridge Relay) ──────────────────

function initWebSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    socket = new WebSocket(BRIDGE_WS_URL);

    socket.onopen = () => {
      isBackendConnected = true;
      console.log('🌐 [PrivaPilot] Connected to Electron Bridge (8766)');
      broadcastToUI({ type: 'BACKEND_STATUS', connected: true });

      if (socket._pingInterval) clearInterval(socket._pingInterval);
      socket._pingInterval = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping', t: Date.now() }));
        }
      }, 15000);

      // Request latest chats & settings from bridge immediately upon connection
      try {
        socket.send(JSON.stringify({ type: 'request_chats' }));
        socket.send(JSON.stringify({ type: 'request_settings' }));
      } catch (e) {}

      // If reconnected while task was active, resume step automatically after 1.5s
      if (isTaskActive && currentTaskGoal) {
        console.log(`🔄 [PrivaPilot] Reconnected while task was active. Resuming step ${currentStep} in 1.5s...`);
        clearStepWatchdog();
        setTimeout(() => {
          if (isTaskActive) runTaskStep();
        }, 1500);
      }
    };

    socket.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'pong') return;
        handleServerMessage(data);
      } catch (err) {
        console.error('⚠️ [PrivaPilot] Message parse error:', err);
      }
    };

    socket.onclose = () => {
      isBackendConnected = false;
      console.log('🔌 [PrivaPilot] Electron Bridge disconnected. Retrying in 2s...');
      broadcastToUI({ type: 'BACKEND_STATUS', connected: false });
      if (socket && socket._pingInterval) clearInterval(socket._pingInterval);
      clearStepWatchdog();
      socket = null;
      setTimeout(initWebSocket, 2000);
    };

    socket.onerror = (err) => {
      // Handled in onclose fallback
    };
  } catch (e) {
    setTimeout(initWebSocket, 2000);
  }
}

initWebSocket();

// ── SERVICE WORKER KEEPALIVE ─────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'privapilot-keepalive') {
    port.onMessage.addListener(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        initWebSocket();
      }
    });
    port.onDisconnect.addListener(() => {
      const _ = chrome.runtime.lastError;
    });
  }
});

try {
  chrome.alarms.create('keepalive', { periodInMinutes: 1.0 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'keepalive') {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        initWebSocket();
      }
    }
  });
} catch (e) {}

try {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
  if (chrome.sidePanel && chrome.sidePanel.setOptions) {
    chrome.sidePanel.setOptions({ path: 'sidepanel/index.html', enabled: true }).catch(() => {});
  }
} catch (e) {}

// ── SIDEPANEL TRACKING & AUTO-OPEN RESILIENCE ────────────────────────────────
let activeSidePanelPorts = new Set();

function sendBridgeMessage(msg) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'click-sidepanel') {
    activeSidePanelPorts.add(port);
    console.log(`📑 [PrivaPilot] Sidepanel port connected (active count: ${activeSidePanelPorts.size})`);

    // Immediately inform sidepanel of current backend status
    const isConn = socket && socket.readyState === WebSocket.OPEN;
    try {
      port.postMessage({ type: 'BACKEND_STATUS', connected: !!isConn });
    } catch (e) {}

    // Inform bridge (Electron) that sidepanel is open
    sendBridgeMessage({ type: 'sidepanel_state', isOpen: true });

    port.onDisconnect.addListener(() => {
      activeSidePanelPorts.delete(port);
      console.log(`📑 [PrivaPilot] Sidepanel port disconnected (remaining: ${activeSidePanelPorts.size})`);
      sendBridgeMessage({ type: 'sidepanel_state', isOpen: activeSidePanelPorts.size > 0 });
    });
  }
});

// Command shortcut listener (Alt+Shift+C / Ctrl+Shift+U)
try {
  if (chrome.commands && chrome.commands.onCommand) {
    chrome.commands.onCommand.addListener(async (command) => {
      if (command === 'open_side_panel' || command === '_execute_action') {
        try {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (tab && tab.id && chrome.sidePanel && chrome.sidePanel.open) {
            await chrome.sidePanel.open({ tabId: tab.id });
          }
        } catch (e) {}
      }
    });
  }
} catch (e) {}

async function isSidePanelOpen() {
  if (activeSidePanelPorts.size > 0) return true;
  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['SIDE_PANEL']
      });
      if (contexts && contexts.length > 0) return true;
    }
  } catch (e) {}
  return false;
}

async function ensureSidePanelVisible() {
  const alreadyOpen = await isSidePanelOpen();
  if (alreadyOpen) {
    console.log('📌 [PrivaPilot] Native sidepanel is already open — doing nothing.');
    return true;
  }

  console.log('⚡ [PrivaPilot] Sidepanel is closed — auto-opening native extension sidepanel...');

  let opened = false;
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    const targetWin = (wins && wins.find(w => w.focused)) || (wins && wins[0]);
    if (targetWin && targetWin.id) {
      chrome.windows.update(targetWin.id, { focused: true }).catch(() => {});
      const activeTab = targetWin.tabs ? targetWin.tabs.find(t => t.active) : null;

      // 1. Try to open with active tab ID
      if (activeTab && activeTab.id && chrome.sidePanel && chrome.sidePanel.open) {
        try {
          await chrome.sidePanel.open({ tabId: activeTab.id });
          opened = true;
          console.log('✅ [PrivaPilot] Native sidePanel.open({ tabId }) succeeded');
        } catch (err) {
          console.log('ℹ️ [PrivaPilot] sidePanel.open({ tabId }) note:', err.message);
        }
      }

      // 2. Try to open with window ID
      if (!opened && chrome.sidePanel && chrome.sidePanel.open) {
        try {
          await chrome.sidePanel.open({ windowId: targetWin.id });
          opened = true;
          console.log('✅ [PrivaPilot] Native sidePanel.open({ windowId }) succeeded');
        } catch (err) {
          console.log('ℹ️ [PrivaPilot] sidePanel.open({ windowId }) note:', err.message);
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ [PrivaPilot] Error ensuring sidepanel visibility:', e.message);
  }

  return opened;
}

// ── OFFSCREEN DOCUMENT MANAGEMENT ────────────────────────────────────────────

let offscreenHeartbeatInterval = null;

function startOffscreenHeartbeat() {
  if (offscreenHeartbeatInterval) return;
  offscreenHeartbeatInterval = setInterval(async () => {
    try {
      if (chrome.offscreen && chrome.offscreen.hasDocument) {
        const hasDoc = await chrome.offscreen.hasDocument();
        if (hasDoc) {
          chrome.runtime.sendMessage({ target: 'ml-engine', action: 'PING' }).catch(() => {});
        }
      }
    } catch (e) {}
  }, 20000); // 20s heartbeat keeps offscreen document warm in memory and prevents idle eviction
}

/**
 * Ensure the offscreen document (ML engine) is created.
 * Uses hasDocument() guard — createDocument() throws if one already exists.
 * Uses reasons: ['WORKERS'] — both ONNX RT and Tesseract.js use Web Workers.
 */
async function ensureOffscreenDocument() {
  try {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) {
      startOffscreenHeartbeat();
      return true;
    }
  } catch (e) {
    // hasDocument() not available in older Chrome — try/catch createDocument
  }

  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'ML inference for privacy-preserving face detection (ONNX) and OCR (Tesseract.js) — runs in isolation from target page JS thread',
    });
    console.log('🧠 [PrivaPilot] Offscreen ML engine document created');
    startOffscreenHeartbeat();
    return true;
  } catch (e) {
    if (e.message && e.message.includes('Only a single offscreen')) {
      // Already exists, that's fine
      startOffscreenHeartbeat();
      return true;
    }
    console.error('❌ [PrivaPilot] Failed to create offscreen document:', e);
    return false;
  }
}

/**
 * Send a message to the offscreen ML engine and await response with strict 2500ms timeout guard.
 */
function sendToMLEngine(message, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.warn(`⏱️ [PrivaPilot] sendToMLEngine timed out after ${timeoutMs}ms — continuing immediately`);
        resolve(null);
      }
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(
        { target: 'ml-engine', ...message },
        (response) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              console.log('ℹ️ [PrivaPilot] ML engine response note:', chrome.runtime.lastError.message);
              resolve(null);
            } else {
              resolve(response);
            }
          }
        }
      );
    } catch (e) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(null);
      }
    }
  });
}

// Listen for ML engine ready notification
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'ML_ENGINE_READY') {
    mlEngineReady = true;
    mlEngineStatus = msg.status || {};
    console.log('🧠 [PrivaPilot] ML Engine ready:', mlEngineStatus);
    broadcastToUI({ type: 'ML_ENGINE_STATUS', status: mlEngineStatus });
  }
});

// ── HELPER: ALLOWED WEB URL CHECK ───────────────────────────────────────────

function isAllowedUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  if (lower.startsWith('chrome://') || 
      lower.startsWith('chrome-extension://') || 
      lower.startsWith('edge://') || 
      lower.startsWith('about:') ||
      lower.startsWith('view-source:')) {
    return false;
  }
  return lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('file://');
}

function getTabUrl(tab) {
  if (!tab) return '';
  return tab.url || tab.pendingUrl || '';
}

// ── SMART TARGET TAB RESOLUTION ─────────────────────────────────────────────

async function getTargetWebTab(goal) {
  // 1. If we have an active target tab that is open and valid, prioritize it!
  if (activeTargetTabId) {
    try {
      const tab = await chrome.tabs.get(activeTargetTabId);
      const url = getTabUrl(tab);
      if (tab && (isAllowedUrl(url) || tab.status === 'loading')) {
        await chrome.tabs.update(tab.id, { active: true });
        try { await chrome.windows.update(tab.windowId, { focused: true }); } catch(e){}
        return tab;
      }
    } catch (e) {
      activeTargetTabId = null;
    }
  }

  // 2. Check the user's currently active tab in the current Chrome window
  try {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (currentTab && (isAllowedUrl(getTabUrl(currentTab)) || currentTab.status === 'loading')) {
      activeTargetTabId = currentTab.id;
      return currentTab;
    }
  } catch (e) {}

  // 3. Check active tab in the last focused Chrome window (user's frontmost tab)
  try {
    const focusedTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (focusedTabs.length > 0 && (isAllowedUrl(getTabUrl(focusedTabs[0])) || focusedTabs[0].status === 'loading')) {
      activeTargetTabId = focusedTabs[0].id;
      return focusedTabs[0];
    }
  } catch (e) {}

  // 4. Check active tab in ANY Chrome window
  try {
    const activeTabs = await chrome.tabs.query({ active: true });
    for (const t of activeTabs) {
      if (isAllowedUrl(getTabUrl(t)) || t.status === 'loading') {
        activeTargetTabId = t.id;
        try { await chrome.windows.update(t.windowId, { focused: true }); } catch(e){}
        return t;
      }
    }
  } catch (e) {}

  // 5. Check ANY open tab that has a normal web page
  try {
    const allTabs = await chrome.tabs.query({});
    for (const t of allTabs) {
      if (isAllowedUrl(getTabUrl(t))) {
        activeTargetTabId = t.id;
        await chrome.tabs.update(t.id, { active: true });
        try { await chrome.windows.update(t.windowId, { focused: true }); } catch(e){}
        return t;
      }
    }
  } catch (e) {}

  // 6. Open a new tab based on the goal if no accessible tab is open
  let destinationUrl = 'https://www.google.com';
  if (goal) {
    const goalLower = goal.toLowerCase();
    const urlMatch = goal.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) {
      destinationUrl = urlMatch[0];
    } else {
      // Patch G: Generalized domain extraction — handles any "go to X.com" pattern
      const domainMatch = goal.match(/\b([a-z0-9-]+\.(?:com|in|org|net|edu|gov|io|co\.in|co\.uk))\b/i);
      if (domainMatch) {
        destinationUrl = 'https://' + domainMatch[1].toLowerCase();
      } else if (goalLower.includes('amazon.in')) {
        destinationUrl = 'https://www.amazon.in';
      } else if (goalLower.includes('amazon')) {
        destinationUrl = 'https://www.amazon.com';
      } else if (goalLower.includes('flipkart')) {
        destinationUrl = 'https://www.flipkart.com';
      } else if (goalLower.includes('youtube')) {
        destinationUrl = 'https://www.youtube.com';
      } else if (goalLower.includes('google')) {
        destinationUrl = 'https://www.google.com';
      } else if (goalLower.includes('demo') || goalLower.includes('cybercart')) {
        destinationUrl = 'http://127.0.0.1:8765/demo/checkout';
      }
    }
  }

  console.log(`🌐 [PrivaPilot] Opening web tab: ${destinationUrl}`);
  const newTab = await chrome.tabs.create({ url: destinationUrl, active: true });
  activeTargetTabId = newTab.id;
  await new Promise(r => setTimeout(r, 2000));
  return newTab;
}

// ── AUTOMATIC MULTI-TAB & POPUP TRACKING ────────────────────────────────────
chrome.tabs.onCreated.addListener(async (tab) => {
  if (!isTaskActive) return;
  const targetUrl = getTabUrl(tab);
  console.log(`📑 [PrivaPilot] Detected new tab created during task (id=${tab.id}, opener=${tab.openerTabId}, url='${targetUrl}')`);

  // P1-4 + N4: Only follow tabs opened by the current target page.
  // Tabs with undefined openerTabId (noopener popups, ad popups) are ignored.
  // Only follow when openerTabId matches our active target.
  if (!tab.openerTabId || tab.openerTabId !== activeTargetTabId) {
    console.log(`📑 [PrivaPilot] Ignoring tab (opener=${tab.openerTabId}, expected=${activeTargetTabId}, noopener=${tab.openerTabId === undefined})`);
    return;
  }

  activeTargetTabId = tab.id;
  try {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch (e) {}
});

// N3: Disable blind tab retargeting — agent should NOT follow user's active tab.
// This prevents the agent from accidentally clicking in the user's Gmail, banking, etc.
// The agent only operates on tabs it created or that were opened from its target page.
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // Intentionally disabled — agent stays on its own target tab.
  // User can explicitly steer via the sidepanel UI if needed.
});

// ── BROADCAST TO EXTENSION POPUP / SIDEPANEL ────────────────────────────────

function broadcastToUI(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
  if (typeof activeSidePanelPorts !== 'undefined') {
    for (const port of activeSidePanelPorts) {
      try { port.postMessage(message); } catch (e) {}
    }
  }
}

function sendBridgeMessage(msg) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

// ── Patch D: Extension-Level Tool Router ────────────────────────────────────

let pendingUserQuestion = null;

function askUserAndWait(question, options) {
  return new Promise((resolve) => {
    let opts = (Array.isArray(options) && options.length > 0) ? options : [];
    if (opts.length === 0) {
      const qLower = (question || '').toLowerCase();
      if (qLower.includes('captcha') || qLower.includes('verify') || qLower.includes('verification') || qLower.includes('cloudflare') || qLower.includes('turnstile')) {
        opts = ['I completed the verification', 'Skip this website', 'Cancel task'];
      } else if (qLower.includes('download') || qLower.includes('format')) {
        opts = ['Download SVG', 'Download PNG', 'Cancel'];
      } else {
        opts = ['Yes, proceed', 'No / Skip', 'Cancel'];
      }
    }

    let timeoutTimer = null;
    const finish = (answer) => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      pendingUserQuestion = null;
      resolve(answer || null);
    };

    // 3-minute timer
    timeoutTimer = setTimeout(() => {
      console.warn('⚠️ [PrivaPilot] 3-minute timeout elapsed for ask_user');
      finish(null);
    }, 180000);

    pendingUserQuestion = { resolve: finish, timeoutTimer, question, options: opts };

    // Auto-open sidepanel if available
    try {
      if (chrome.sidePanel && chrome.sidePanel.open) {
        chrome.windows.getCurrent().then(win => {
          chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
        }).catch(() => {});
      }
    } catch (e) {}

    // Broadcast to extension sidepanel
    broadcastToUI({ type: 'ASK_USER', question, options: opts, timeoutMs: 180000 });

    // Send to Electron Bridge so controls.html displays the interactive box in chat!
    sendBridgeMessage({ type: 'ask_user', question, options: opts, timeoutMs: 180000 });
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if ((msg.type === 'USER_REPLY' || msg.type === 'user_reply') && pendingUserQuestion) {
    console.log(`💬 [PrivaPilot] User reply received via extension UI: "${msg.answer}"`);
    pendingUserQuestion.resolve(msg.answer || null);
  }
});

let lastUserClarification = null;

async function dispatchToolToBrowser(tool, args) {
  // ── Extension-level tools (chrome.* APIs) ──
  if (tool === 'finish_task') {
    isTaskActive = false;
    broadcastToUI({ type: 'TASK_FINISHED', status: args.status || 'success',
                    summary: args.summary || '', data: args.data || null,
                    chatId: currentChatId });
    return { success: true, finished: true,
             message: `finish_task (${args.status || 'success'}): ${(args.summary || '').slice(0, 100)}` };
  }

  if (tool === 'ask_user') {
    const answer = await askUserAndWait(args.question, args.options);
    if (answer) {
      lastUserClarification = { question: args.question, answer: String(answer) };
      return { success: true, message: `User answered: ${String(answer).slice(0, 200)}` };
    }
    return { success: false, error: 'User did not respond within 3 minutes. Proceed with the safest default action, or call finish_task with status "partial" if the task cannot continue without user input.' };
  }

  if (tool === 'switch_tab') {
    const tabs = (await chrome.tabs.query({})).filter(t => isAllowedUrl(getTabUrl(t)));
    const idx = Math.max(1, parseInt(args.tab_index, 10) || 1) - 1;
    if (tabs[idx]) {
      activeTargetTabId = tabs[idx].id;
      await chrome.tabs.update(tabs[idx].id, { active: true });
      try { await chrome.windows.update(tabs[idx].windowId, { focused: true }); } catch (e) {}
      await new Promise(r => setTimeout(r, 1200));
      return { success: true, message: `Switched to tab ${idx + 1}: ${getTabUrl(tabs[idx]).slice(0, 60)}` };
    }
    return { success: false, error: `Tab index ${args.tab_index} not found (${tabs.length} tabs open)` };
  }

  if (tool === 'open_tab') {
    let targetUrl = (args.url || 'https://www.google.com').trim();
    const urlLower = targetUrl.toLowerCase();
    if (urlLower.startsWith('javascript:') || urlLower.startsWith('data:') || urlLower.startsWith('file:')) {
      return { success: false, error: `BLOCKED: Dangerous URL scheme in open_tab: ${targetUrl.slice(0, 30)}` };
    }
    if (!urlLower.startsWith('http://') && !urlLower.startsWith('https://') && !urlLower.startsWith('about:')) {
      targetUrl = 'https://' + targetUrl;
    }
    try {
      const newTab = await chrome.tabs.create({ url: targetUrl, active: true });
      activeTargetTabId = newTab.id;
      // Reuse onUpdated pattern from navigate (instead of fixed 2s sleep)
      const tabEffect = await new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
          if (!done) { done = true; chrome.tabs.onUpdated.removeListener(tabListener); resolve('unverifiable'); }
        }, 5000);
        const tabListener = (tid, changeInfo) => {
          if (tid === newTab.id && changeInfo.status === 'complete') {
            if (!done) { done = true; clearTimeout(timer); chrome.tabs.onUpdated.removeListener(tabListener); resolve('confirmed'); }
          }
        };
        chrome.tabs.onUpdated.addListener(tabListener);
      });
      return { success: true, effect: tabEffect, message: `Opened new tab with URL ${targetUrl}` };
    } catch (err) {
      return { success: false, error: `open_tab failed: ${err.message}` };
    }
  }

  if (tool === 'close_tab') {
    try {
      const tabs = (await chrome.tabs.query({})).filter(t => isAllowedUrl(getTabUrl(t)));
      let targetTabToClose = null;
      if (args.tab_index) {
        const idx = Math.max(1, parseInt(args.tab_index, 10) || 1) - 1;
        if (tabs[idx]) targetTabToClose = tabs[idx];
      } else if (activeTargetTabId) {
        targetTabToClose = tabs.find(t => t.id === activeTargetTabId);
      }
      if (!targetTabToClose && tabs.length > 0) {
        targetTabToClose = tabs[tabs.length - 1];
      }
      if (targetTabToClose && tabs.length > 1) {
        await chrome.tabs.remove(targetTabToClose.id);
        const remaining = (await chrome.tabs.query({})).filter(t => isAllowedUrl(getTabUrl(t)));
        if (remaining.length > 0) {
          activeTargetTabId = remaining[0].id;
          await chrome.tabs.update(activeTargetTabId, { active: true });
        }
        await new Promise(r => setTimeout(r, 1000));
        return { success: true, effect: 'confirmed', message: `Closed tab (${targetTabToClose.title || targetTabToClose.url || ''})` };
      }
      return { success: false, error: 'Cannot close tab (only 1 tab open or tab not found)' };
    } catch (err) {
      return { success: false, error: `close_tab failed: ${err.message}` };
    }
  }

  if (tool === 'navigate' && args.url) {
    const urlLower = String(args.url).trim().toLowerCase();
    if (urlLower.startsWith('javascript:') || urlLower.startsWith('data:') || urlLower.startsWith('file:')) {
      return { success: false, error: `BLOCKED: Dangerous URL scheme in navigate: ${args.url.slice(0, 30)}` };
    }
    try {
      const targetTab = await getTargetWebTab('');
      if (targetTab && targetTab.id) {
        await chrome.tabs.update(targetTab.id, { url: args.url });
        // P2-4: Wait for actual page load via onUpdated instead of fixed 2s sleep
        const navEffect = await new Promise((resolve) => {
          let done = false;
          const timer = setTimeout(() => {
            if (!done) { done = true; chrome.tabs.onUpdated.removeListener(navListener); resolve('unverifiable'); }
          }, 5000);
          const navListener = (tid, changeInfo) => {
            if (tid === targetTab.id && changeInfo.status === 'complete') {
              if (!done) { done = true; clearTimeout(timer); chrome.tabs.onUpdated.removeListener(navListener); resolve('confirmed'); }
            }
          };
          chrome.tabs.onUpdated.addListener(navListener);
        });
        return { success: true, effect: navEffect, message: `Navigated to ${args.url}` };
      }
    } catch (err) {
      return { success: false, error: `Navigation error: ${err.message}` };
    }
  }

  // ── Page-level tools: inject into the active tab ──
  const targetTab = await getTargetWebTab('');
  if (!targetTab || !targetTab.id) {
    return { success: false, error: 'No accessible web tab found' };
  }
  activeTargetTabId = targetTab.id;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTargetTabId },
      func: inTabExecuteAction,
      args: [tool, args]
    });
    const res = results && results[0] && results[0].result;
    if (!res) return { success: false, error: 'Executor returned no result (page may have navigated mid-action)' };
    return res;
  } catch (e) {
    return { success: false, error: `Injection failed: ${e.message}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'ml-engine') return false; // Let offscreen handle these


  if (msg.type === 'GET_STATE') {
    sendResponse({
      connected: socket && socket.readyState === WebSocket.OPEN,
      isTaskActive: isTaskActive,
      currentStep: currentStep,
      goal: currentTaskGoal,
      mlEngineReady: mlEngineReady,
      mlEngineStatus: mlEngineStatus,
    });
    return true;
  }
  if (msg.type === 'START_TASK') {
    currentTaskGoal = msg.goal;
    currentStep = 0;
    isTaskActive = true;
    if (msg.chatId) currentChatId = msg.chatId;
    if (msg.chatHistory) currentChatHistory = msg.chatHistory;
    if (msg.tabId) activeTargetTabId = msg.tabId;
    if (msg.resetSession) {
      sendBridgeMessage({ type: 'reset_session', chat_id: currentChatId });
    }
    broadcastToUI({ type: 'TASK_STARTED', goal: currentTaskGoal, chatId: currentChatId });
    sendBridgeMessage({
      type: 'start_task',
      goal: currentTaskGoal,
      chat_id: currentChatId,
      chat_history: currentChatHistory
    });
    runTaskStep();
    sendResponse({ status: 'started' });
    return true;
  }
  if (msg.type === 'STOP_TASK') {
    if (!isTaskActive) {
      sendResponse({ status: 'not_running' });
      return true;
    }
    isTaskActive = false;
    broadcastToUI({ type: 'TASK_STOPPED', chatId: currentChatId });
    sendBridgeMessage({ type: 'task_stopped', chat_id: currentChatId });
    sendBridgeMessage({ type: 'stop_task', chat_id: currentChatId });
    sendResponse({ status: 'stopped' });
    return true;
  }
  if (msg.type === 'OPEN_SIDEPANEL') {
    (async () => {
      try {
        const tabId = (sender && sender.tab && sender.tab.id) ? sender.tab.id : null;
        if (chrome.sidePanel && chrome.sidePanel.open) {
          if (tabId) {
            await chrome.sidePanel.open({ tabId: tabId });
          } else {
            const win = await chrome.windows.getCurrent();
            await chrome.sidePanel.open({ windowId: win.id });
          }
        }
      } catch (err) {
        console.warn('⚠️ Could not open side panel:', err);
      }
    })();
    sendResponse({ status: 'opening' });
    return true;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// IN-TAB FUNCTIONS (DOM-only, no ML — runs in target page context)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Layer 1: DOM Semantic Scan — runs inside target webpage via executeScript.
 * Returns DOM-detected PII regions + interactive element tree.
 * No canvas redaction here — that's handled by the offscreen ML engine.
 */
function inTabDOMScan() {
  const startTime = performance.now();
  const dpr = window.devicePixelRatio || 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const PATTERNS = {
    creditCard: /\b(?:\d{4}[ -]?){3}\d{4}\b/g,
    aadhaar: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
    panCard: /\b[A-Z]{5}[0-9]{4}[A-Z]{1}\b/g,
    email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    phone: /\b(?:\+91[\-\s]?)?[6-9]\d{9}\b/g,
    token: /(?:eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}(?:\.[a-zA-Z0-9_-]*)?|(?:sk|nvapi|ghp|pk)[-_](?:live|test)?[a-zA-Z0-9_-]{12,})/g,
    passport: /\b[A-Z]{1}\d{7}\b/g,
    ifsc: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    bankAccount: /\b\d{9,18}\b/g,
  };

  // Address/name heuristic patterns
  const ADDRESS_KEYWORDS = /\b(road|street|nagar|colony|sector|block|lane|gali|mohalla|marg|avenue|plot|flat|floor|apartment|apartments|house|tower|chowk|circle|village|district|tehsil|mandal|city|town|prestige|koramangala|lajpat|delhi|mumbai|bangalore|bengaluru|jaipur|kanpur|up|karnataka|नगर|मार्ग|सड़क)\b/i;
  const ADDRESS_CONTEXT = /(?:delivery|residential|shipping|permanent|office|mailing|correspondence)?\s*address|पता|निवास/i;
  const NAME_CONTEXT = /\b(name|applicant|father'?s?\s*name|mother'?s?\s*name|spouse|guardian|nominee|beneficiary|account\s*holder|customer|patient|student|employee|passenger|candidate|आवेदक|नाम|पिता)\s*[:\-]?\s*/i;

  function isValidCreditCard(str) {
    const cleaned = str.replace(/[\s-]/g, '');
    if (!/^\d{13,19}$/.test(cleaned)) return false;
    let sum = 0, alt = false;
    for (let i = cleaned.length - 1; i >= 0; i--) {
      let n = parseInt(cleaned.charAt(i), 10);
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  const detectedRegions = [];
  function addRegion(rect, type) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    detectedRegions.push({
      type: type,
      x: Math.round(rect.left * dpr),
      y: Math.round(rect.top * dpr),
      width: Math.round(rect.width * dpr),
      height: Math.round(rect.height * dpr),
    });
  }

  // Precise sub-range bounding rect for text nodes (masks ONLY the matching characters)
  function getMatchRangeRect(textNode, startIdx, endIdx) {
    try {
      const range = document.createRange();
      range.setStart(textNode, Math.max(0, startIdx));
      range.setEnd(textNode, Math.min(textNode.length, endIdx));
      const rects = range.getClientRects();
      if (rects.length === 0) {
        const b = range.getBoundingClientRect();
        return (b && b.width > 0 && b.height > 0) ? b : (textNode.parentElement?.getBoundingClientRect() || null);
      }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const r of rects) {
        if (r.width <= 0 || r.height <= 0) continue;
        minX = Math.min(minX, r.left);
        minY = Math.min(minY, r.top);
        maxX = Math.max(maxX, r.right);
        maxY = Math.max(maxY, r.bottom);
      }
      if (minX === Infinity) return textNode.parentElement?.getBoundingClientRect() || null;
      return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
    } catch {
      return textNode.parentElement?.getBoundingClientRect() || null;
    }
  }

  function getNodeRect(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return getMatchRangeRect(node, 0, node.length);
    }
    return node.getBoundingClientRect?.() || null;
  }

  // 1. Password & CVV inputs
  document.querySelectorAll('input[type="password"], input[name*="password" i], input[id*="password" i], input[id*="cvv" i], input[name*="cvv" i], input[autocomplete*="password" i]').forEach(el => addRegion(el.getBoundingClientRect(), 'password'));

  // 2. Credit Card inputs
  document.querySelectorAll('input[autocomplete="cc-number"], input[name*="card" i], input[id*="card" i]').forEach(el => addRegion(el.getBoundingClientRect(), 'creditCard'));

  // 3. Email inputs
  document.querySelectorAll('input[type="email"], input[name*="email" i], input[id*="email" i]').forEach(el => addRegion(el.getBoundingClientRect(), 'email'));

  // 4. Phone inputs
  document.querySelectorAll('input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[name*="mobile" i]').forEach(el => addRegion(el.getBoundingClientRect(), 'phone'));

  // 5. Aadhaar / PAN
  document.querySelectorAll('input[name*="aadhaar" i], input[id*="aadhaar" i]').forEach(el => addRegion(el.getBoundingClientRect(), 'aadhaar'));
  document.querySelectorAll('input[name*="pan" i], input[id*="pan" i]').forEach(el => addRegion(el.getBoundingClientRect(), 'panCard'));

  // 5b. Name inputs (catches "Rohit Sharma" in name fields)
  document.querySelectorAll('input[name*="name" i], input[id*="name" i], input[placeholder*="name" i], input[autocomplete*="name" i], input[aria-label*="name" i]').forEach(el => {
    if (el.type === 'password' || el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return;
    if (el.value && el.value.trim().length > 1) {
      addRegion(el.getBoundingClientRect(), 'name');
    }
  });

  // 5c. Scan ALL visible input values for PII patterns
  document.querySelectorAll('input:not([type="password"]):not([type="hidden"]), textarea').forEach(el => {
    const val = el.value || '';
    if (val.trim().length < 4) return;
    for (const [type, pattern] of Object.entries(PATTERNS)) {
      pattern.lastIndex = 0;
      if (pattern.test(val)) {
        if (type === 'bankAccount' && !/bank|account|a\/c/i.test(val)) continue;
        if (type === 'creditCard' && !isValidCreditCard(val)) continue;
        addRegion(el.getBoundingClientRect(), type);
        break;
      }
    }
  });

  // 5d. Name elements in DOM (e.g. <div class="name">Arjun Mehta</div>, .profile-name, .id-value)
  document.querySelectorAll('[class*="name" i]:not(input):not(form):not(html):not(body), .author, .user-name, .username, .profile-name, .account-holder, .profile-info .name, .scanned-id .id-value').forEach(el => {
    if (el.closest && el.closest('.ground-truth, .metrics-strip')) return;
    
    // Filter out common non-person-name classes (using delimiter boundaries to avoid false matches like 'file' in 'profile')
    const classStr = (el.className || '').toString().toLowerCase();
    if (/(?:^|[\s_-])(product|item|file|filename|tag|brand|app|domain|service|code|class|icon|method|var|field|tool|menu|step|key|rule|status|title)(?:[\s_-]|$)/.test(classStr)) {
      return;
    }

    const txt = (el.innerText || el.textContent || '').trim();
    if (txt.length >= 2 && txt.length <= 40) {
      // Must be a plausible human name (2-4 words, mixed case or unicode, NOT all-caps UI words)
      const isName = (!/^[A-Z\s]+$/.test(txt) && /^[A-Z][a-zA-Z'\-]+(\s+[A-Za-z][a-zA-Z'\-]+){1,3}$/.test(txt)) ||
                     /^[\u0900-\u097F\s]{3,}$/.test(txt);
      
      // Exclude common navigation or UI phrases
      const isUIPhrase = /^(new chat|search chats|privacy shield|recent|notebooks|students|images|videos|library|settings|pro|free|help|faq|home|menu|profile|account|sign out|log in)$/i.test(txt);
      const isHeader = /^(full\s*)?name|first\s*name|last\s*name$/i.test(txt);

      if (isName && !isHeader && !isUIPhrase) {
        const prev = el.previousElementSibling;
        const prevTxt = prev ? prev.textContent.toLowerCase() : '';
        if (prevTxt.includes('pan') || prevTxt.includes('aadhaar') || prevTxt.includes('address') || prevTxt.includes('dob')) return;
        addRegion(el.getBoundingClientRect(), 'name');
      }
    }
  });

  // 5e. Scanned ID card field key-value pairs (e.g. Card 4 Aadhaar / PAN card fields)
  document.querySelectorAll('.id-field, .field, [class*="id-field"]').forEach(field => {
    if (field.closest && field.closest('.ground-truth, .metrics-strip')) return;
    const label = field.querySelector('.id-label, .label, [class*="label"]');
    const val = field.querySelector('.id-value, .value, [class*="value"]');
    if (!label || !val) return;
    const lTxt = label.textContent.toLowerCase();
    const vRect = val.getBoundingClientRect();
    if (lTxt.includes('name') || lTxt.includes('father') || lTxt.includes('applicant')) {
      addRegion(vRect, 'name');
    } else if (lTxt.includes('address') || lTxt.includes('पता')) {
      addRegion(vRect, 'address');
    } else if (lTxt.includes('aadhaar') || lTxt.includes('uid')) {
      addRegion(vRect, 'aadhaar');
    } else if (lTxt.includes('pan')) {
      addRegion(vRect, 'panCard');
    }
  });

  // 5f. Highlighted PII spans or explicit privacy tags (e.g. Card 2 demo rendered text)
  document.querySelectorAll('.pii-highlight, [data-pii]').forEach(el => {
    if (el.closest && el.closest('.ground-truth, .metrics-strip')) return;
    const txt = (el.innerText || el.textContent || '').trim();
    if (!txt) return;
    for (const [type, pattern] of Object.entries(PATTERNS)) {
      pattern.lastIndex = 0;
      if (pattern.test(txt)) {
        addRegion(el.getBoundingClientRect(), type);
        return;
      }
    }
    if (ADDRESS_KEYWORDS.test(txt)) {
      addRegion(el.getBoundingClientRect(), 'address');
      return;
    }
    if (/^[A-Z][a-z]+(\s+[A-Z][a-z]+)+$/.test(txt)) {
      addRegion(el.getBoundingClientRect(), 'name');
      return;
    }
    addRegion(el.getBoundingClientRect(), 'generic');
  });

  // 6. Text nodes scan — character-precise regex + contextual heuristics
  //    Key: build BROAD context from parent chain + siblings for contextual PII
  const root = document.body || document.documentElement;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.textContent && n.textContent.trim().length >= 4) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
  });

  /**
   * Build rich context string from surrounding DOM for contextual heuristics.
   * Walks up 3 ancestor levels and includes preceding siblings for maximum recall.
   */
  function buildContextText(textNode) {
    const parent = textNode.parentElement;
    if (!parent) return '';
    const parts = [];
    // Immediate parent full text (includes sibling text nodes)
    parts.push(parent.textContent || '');
    // Previous sibling element text
    if (parent.previousElementSibling) {
      parts.push(parent.previousElementSibling.textContent || '');
    }
    // Grandparent text (captures labels like "IFSC Code:" that are siblings of parent)
    const gp = parent.parentElement;
    if (gp) {
      parts.push(gp.textContent || '');
      // Great-grandparent for deeply nested structures (e.g., .pii-text > strong + br + span)
      const ggp = gp.parentElement;
      if (ggp && ggp.tagName.toLowerCase() !== 'body') {
        parts.push(ggp.textContent || '');
      }
    }
    // Also check closest semantic container (card, section)
    const container = parent.closest && parent.closest('.pii-text, .address-block, .scanned-id, .profile-info, [class*="card"]');
    if (container) {
      parts.push(container.textContent || '');
    }
    return parts.join(' ').slice(0, 500);
  }

  let currentNode;
  while ((currentNode = walker.nextNode())) {
    const txt = currentNode.textContent;
    const parent = currentNode.parentElement;
    if (!parent || ['script', 'style', 'noscript', 'canvas'].includes(parent.tagName.toLowerCase())) continue;
    // Don't redact ground truth verification guides
    if (parent.closest && parent.closest('.ground-truth, .metrics-strip')) continue;

    const contextText = buildContextText(currentNode);

    // Standard PII patterns with character-level Range bounds
    for (const [type, pattern] of Object.entries(PATTERNS)) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(txt)) !== null) {
        if (type === 'passport' && !/passport|travel/i.test(contextText)) continue;
        if (type === 'ifsc' && !/ifsc|bank|branch|code|transfer|neft|rtgs|imps|account|a\/c/i.test(contextText)) continue;
        if (type === 'bankAccount' && !/bank|account|a\/c|saving|current/i.test(contextText)) continue;
        if (type === 'creditCard' && !isValidCreditCard(m[0])) continue;

        const matchRect = getMatchRangeRect(currentNode, m.index, m.index + m[0].length);
        addRegion(matchRect, type);
      }
    }

    // Contextual address detection — require structured address context or PIN code, not stray dictionary words
    const isAddressCtx = ADDRESS_CONTEXT.test(contextText);
    const hasPinCode = /\b[1-9][0-9]{5}\b/.test(txt);
    const hasAddressKeywords = ADDRESS_KEYWORDS.test(txt) || ADDRESS_KEYWORDS.test(contextText);
    const trimmed = txt.trim();
    const hasStructuredAddress = /(?:flat|house|plot|door|room|suite|sector|block)\s*#?\s*\d+.*(?:road|street|nagar|marg|lane|avenue|colony)/i.test(trimmed) ||
                                 /(?:road|street|nagar|colony|marg|avenue|sector)\s*,?\s*(?:delhi|mumbai|bangalore|bengaluru|jaipur|kanpur|pune|hyderabad|chennai|kolkata|lucknow)/i.test(trimmed);

    if ((isAddressCtx && trimmed.length > 8) || (hasPinCode && hasAddressKeywords) || hasStructuredAddress) {
      addRegion(getNodeRect(currentNode), 'address');
    }

    // Contextual name detection
    const isNameCtx = NAME_CONTEXT.test(contextText);
    const isNameFormat = (!/^[A-Z\s]+$/.test(trimmed) && /^[A-Z][a-zA-Z'\-]+(\s+[A-Za-z][a-zA-Z'\-]+){1,3}$/.test(trimmed)) ||
                         /^[\u0900-\u097F\s]{3,}$/.test(trimmed);

    if (isNameCtx && isNameFormat && !NAME_CONTEXT.test(trimmed)) {
      addRegion(getNodeRect(currentNode), 'name');
    } else if (NAME_CONTEXT.test(trimmed)) {
      // If the text node has "Name: John Doe" inline, mask ONLY the name portion
      const nmMatch = trimmed.match(NAME_CONTEXT);
      if (nmMatch && nmMatch.index !== undefined) {
        const afterIdx = nmMatch.index + nmMatch[0].length;
        const afterTxt = trimmed.slice(afterIdx).trim();
        if (afterTxt.length > 1) {
          const matchStart = txt.indexOf(afterTxt, afterIdx);
          if (matchStart !== -1) {
            addRegion(getMatchRangeRect(currentNode, matchStart, matchStart + afterTxt.length), 'name');
          }
        }
      }
    }

    // Greeting / User Profile Name Detection (e.g. "What's the vibe, Harsh chaudhary?", "Welcome, Rohit Sharma", "Hi John")
    const GREETING_NAME_RE = /(?:what'?s\s+(?:the\s+)?vibe|welcome(?:\s+back)?|hello|hi|hey|good\s+(?:morning|afternoon|evening)|logged\s+in\s+as|signed\s+in\s+as|user)\s*[,:\-]\s*([A-Z][a-zA-Z'\-]+(?:\s+[A-Za-z][a-zA-Z'\-]+){1,3})/i;
    const greetMatch = trimmed.match(GREETING_NAME_RE);
    if (greetMatch && greetMatch[1]) {
      const namePart = greetMatch[1].trim();
      const nIdx = txt.indexOf(namePart);
      if (nIdx !== -1) {
        addRegion(getMatchRangeRect(currentNode, nIdx, nIdx + namePart.length), 'name');
      }
    }
  }

  // 7. Avatar/face images (Strict visual elements only — NEVER match layout containers/sidebars/chat windows!)
  const avatarCandidates = document.querySelectorAll(
    'img.face-img, .face-container img, .profile-section img, img[src*="avatar" i], img[src*="face" i], img[src*="portrait" i], img[src*="profile" i], img[class*="avatar" i], img[class*="profile" i], svg[class*="avatar" i], [role="img"][class*="avatar" i], .avatar, [class*="profile-pic" i], [class*="user-photo" i]'
  );

  avatarCandidates.forEach(el => {
    if (el.closest && el.closest('.ground-truth, .metrics-strip')) return;

    const tag = el.tagName.toLowerCase();
    // Strictly REJECT structural/layout container tags
    if (['aside', 'nav', 'main', 'section', 'article', 'header', 'footer', 'body', 'html', 'form', 'ul', 'ol'].includes(tag)) {
      return;
    }

    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;

    // Reject non-image containers that have multiple interactive children or substantial text content
    if (tag === 'div') {
      if (el.querySelectorAll('button, a, input, [role="button"]').length > 1) return;
      const textLen = (el.innerText || el.textContent || '').trim().length;
      if (textLen > 25) return; // Avatars don't contain paragraphs or menus
    }

    // Strict physical dimensions for human/user avatars:
    // Avatars are small visual icons/photos (16px to 260px, roughly square, never spanning the page)
    const w = rect.width;
    const h = rect.height;
    if (w < 16 || h < 16 || w > 260 || h > 260) return;

    const aspect = w / h;
    if (aspect < 0.4 || aspect > 2.5) return;

    // Max area guard: an avatar never occupies > 8% of the browser viewport
    const area = w * h;
    if (area > (vw * vh * 0.08) || area > 65000) return;

    addRegion(rect, 'face');
  });

  // 8. Interactive Elements scan (prioritizing current viewport)
  const interactive = [];
  const candidates = document.querySelectorAll(
    'button, a, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="searchbox"], [role="combobox"], [onclick], [tabindex]:not([tabindex="-1"]), summary, label[for]'
  );
  // Patch A: Collision-free stable p-IDs — global counter persists across scans
  if (!window.__privaIdCounter) window.__privaIdCounter = 1;

  candidates.forEach(el => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

    const inViewport = (rect.top < vh && rect.bottom > 0 && rect.left < vw && rect.right > 0);

    // P2-1: Always assign our own p-ID to prevent adversarial pre-seeding collisions.
    // A malicious page could pre-seed data-priva-id="p-12" on a decoy element.
    let privaId = el.getAttribute('data-priva-id');
    const expectedPrefix = `p-${window.__privaIdCounter}`;
    if (!privaId || !/^p-\d+$/.test(privaId) || document.querySelectorAll(`[data-priva-id="${privaId}"]`).length > 1) {
      privaId = `p-${window.__privaIdCounter++}`;
      el.setAttribute('data-priva-id', privaId);
    } else if (privaId) {
      // Keep existing valid unique id, but still advance counter past it
      const num = parseInt(privaId.replace('p-', ''), 10);
      if (!isNaN(num) && num >= window.__privaIdCounter) {
        window.__privaIdCounter = num + 1;
      }
    }

    const isSensitive = el.type === 'password' ||
      /password|cvv|card|aadhaar|pan|ssn|secret|token/i.test((el.name || '') + ' ' + (el.id || '') + ' ' + (el.autocomplete || ''));

    // Rich label extraction for buttons, links, and especially small icon-only buttons
    let extractedLabel = (
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      el.getAttribute('alt') ||
      ''
    ).trim();

    if (!extractedLabel) {
      const innerImg = el.querySelector('img[alt]');
      if (innerImg) extractedLabel = innerImg.getAttribute('alt') || '';
    }
    if (!extractedLabel) {
      const innerSvg = el.querySelector('svg');
      if (innerSvg) {
        extractedLabel = innerSvg.getAttribute('aria-label') || (innerSvg.querySelector('title') ? innerSvg.querySelector('title').textContent : '') || '';
      }
    }
    if (!extractedLabel) {
      extractedLabel = (el.innerText || el.textContent || '').trim();
    }
    const cleanText = extractedLabel.replace(/\s+/g, ' ').trim();
    const val = isSensitive ? '[REDACTED: SENSITIVE]' : (el.value || '');

    interactive.push({
      privaId: privaId,
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      type: el.type || null,
      name: el.name || null,
      selector: el.id ? `#${el.id}` : `[data-priva-id="${privaId}"]`,
      text: cleanText.slice(0, 80),
      value: val.slice(0, 60),
      is_redacted: isSensitive,
      in_viewport: inViewport,
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    });
  });

  // Sort: IN-VIEWPORT elements come FIRST, ordered vertically top-to-bottom!
  interactive.sort((a, b) => {
    if (a.in_viewport && !b.in_viewport) return -1;
    if (!a.in_viewport && b.in_viewport) return 1;
    return a.rect.y - b.rect.y;
  });

  // 9. Inspect whether Layer 3 OCR is needed on this page
  // Standard web pages (e.g. Amazon, Google, banking forms) have all text in DOM (100% captured by Layer 1).
  // Layer 3 OCR is ONLY needed when:
  // - The page has <canvas> elements (drawing surfaces, games, charts, or rendered documents)
  // - The page has candidate scanned identity/KYC document images (e.g. aadhaar, pan, passport photos, id cards)
  // - The page DOM text is very sparse (< 60 chars in body, indicating a pure image/PDF viewer)
  const ocrTargets = [];
  // Only target canvases that are likely charts or documents (large enough)
  const canvases = document.querySelectorAll('canvas');
  canvases.forEach(cv => {
    const r = cv.getBoundingClientRect();
    if (r.width > 120 && r.height > 120) {
      ocrTargets.push({
        x: Math.round(r.left * dpr),
        y: Math.round(r.top * dpr),
        width: Math.round(r.width * dpr),
        height: Math.round(r.height * dpr),
      });
    }
  });

  // Specifically target explicit scanned identity / KYC documents only (NOT generic cards or product images)
  const docImages = document.querySelectorAll('img[class*="aadhaar" i], img[class*="pancard" i], img[class*="passport" i], img[class*="kyc-doc" i], img[id*="aadhaar" i], img[id*="pancard" i], img[src*="aadhaar" i], img[src*="pan" i], [class*="scanned-id"] img');
  docImages.forEach(img => {
    const r = img.getBoundingClientRect();
    if (r.width > 80 && r.height > 80) {
      ocrTargets.push({
        x: Math.round(r.left * dpr),
        y: Math.round(r.top * dpr),
        width: Math.round(r.width * dpr),
        height: Math.round(r.height * dpr),
      });
    }
  });

  const bodyTextLen = (document.body ? (document.body.innerText || document.body.textContent || '') : '').trim().length;
  const isTextSparse = bodyTextLen < 40;
  const requireOcr = (ocrTargets.length > 0 || isTextSparse) && (ocrTargets.length <= 4);

  const endTime = performance.now();
  return {
    domRegions: detectedRegions,
    domElements: interactive,
    pageText: ((document.body && document.body.innerText) || '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 2500),
    domScanMs: Math.round(endTime - startTime),
    title: document.title,
    url: window.location.href,
    viewport: { width: vw, height: vh, dpr: dpr },
    requireOcr: requireOcr,
    ocrTargets: ocrTargets,
  };
}

/**
 * Executes inside target webpage: dispatches clicks, typing, scrolling,
 * and animations directly on DOM elements.
 */
async function inTabExecuteAction(tool, args) {
  function normalizeStr(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function resolveCoordinates(coords) {
    if (!coords || !Array.isArray(coords) || coords.length < 2) return null;
    let [x, y] = [Number(coords[0]), Number(coords[1])];
    if (isNaN(x) || isNaN(y)) return null;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;

    // 1. Normalized 0.0 to 1.0 (float scale, e.g. [0.45, 0.62])
    if (x >= 0 && x <= 1.0 && y >= 0 && y <= 1.0 && (x > 0 || y > 0)) {
      x = x * vw;
      y = y * vh;
    }
    // 2. Physical screenshot pixels (devicePixelRatio scaled)
    else if (dpr > 1 && (x > vw || y > vh) && (x / dpr <= vw + 10 && y / dpr <= vh + 10)) {
      x = x / dpr;
      y = y / dpr;
    }
    // 3. Normalized 0 to 1000 scale (standard Gemini bounding box / VLM coordinate space)
    else if ((x > vw || y > vh) && x <= 1000 && y <= 1000) {
      x = (x / 1000) * vw;
      y = (y / 1000) * vh;
    }

    x = Math.max(0, Math.min(vw - 1, x));
    y = Math.max(0, Math.min(vh - 1, y));
    return [Math.round(x), Math.round(y)];
  }

  function findTarget(args) {
    const resolvedCoords = resolveCoordinates(args.coordinates);

    // 1. Selector match (highest precision for exact id or data-priva-id)
    if (args.selector) {
      try {
        const el = document.querySelector(args.selector);
        if (el) {
          const rect = el.getBoundingClientRect();
          // P0-1: Selector is the most reliable grounding — always click element center.
          // Never let noisy model coordinate estimates override the precise DOM rect.
          return { el, clickX: Math.round(rect.left + rect.width / 2),
                   clickY: Math.round(rect.top + rect.height / 2), fromCoords: false };
        }
      } catch (e) {}
    }

    // 1b. Patch B: Element label grounding (p-XX from Set-of-Marks visual labels)
    if (args.element) {
      const m = String(args.element).match(/p-(\d+)/i);
      if (m) {
        try {
          const el = document.querySelector(`[data-priva-id="p-${m[1]}"]`);
          if (el) {
            const rect = el.getBoundingClientRect();
            return { el, clickX: Math.round(rect.left + rect.width / 2),
                     clickY: Math.round(rect.top + rect.height / 2), fromCoords: false };
          }
        } catch (e) {}
      }
    }

    // Stale element guard: if explicit selector or element label was requested but not found,
    // do NOT fall back to arbitrary fuzzy text matching (prevents wrong clicks on stale elements)
    if (args.selector || args.element) {
      if (resolvedCoords) {
        const [x, y] = resolvedCoords;
        let hit = document.elementFromPoint(x, y);
        if (hit) {
          const interactive = hit.closest('button, a, input, select, textarea, [role="button"], [onclick], [tabindex]') || hit;
          return { el: interactive, directTarget: hit, clickX: x, clickY: y, fromCoords: true };
        }
      }
      return { isStale: true, targetDesc: args.selector || args.element };
    }

    // 2. Coordinate match (direct click at screen coordinates)
    if (resolvedCoords) {
      const [x, y] = resolvedCoords;
      let hit = document.elementFromPoint(x, y);
      if (!hit || hit === document.body || hit === document.documentElement) {
        const offsets = [[0, 6], [0, -6], [6, 0], [-6, 0], [12, 12], [-12, -12]];
        for (const [dx, dy] of offsets) {
          const alt = document.elementFromPoint(x + dx, y + dy);
          if (alt && alt !== document.body && alt !== document.documentElement) {
            hit = alt;
            break;
          }
        }
      }

      if (hit) {
        const interactive = hit.closest('button, a, input, select, textarea, [role="button"], [onclick], [tabindex], .a-button, .s-result-item') || hit;
        return { el: interactive, directTarget: hit, clickX: x, clickY: y, fromCoords: true };
      }
    }

    // 3. Text match (smart candidate scoring, preferring current viewport and leaf elements)
    if (args.text) {
      const targetNorm = normalizeStr(args.text);
      if (targetNorm) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // Leaf-first candidates (buttons, links, labels, and text leaves)
        const candidates = Array.from(document.querySelectorAll(
          'button, a, input[type="button"], input[type="submit"], [role="button"], [onclick], ' +
          'span, p, h1, h2, h3, h4, h5, h6, strong, b, em, i, td, th, label, [aria-label]'
        ));

        let bestEl = null;
        let highestScore = -Infinity;

        for (const el of candidates) {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;

          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

          // Reject huge container elements
          if (el.childElementCount > 4) continue;

          const rawText = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
          if (rawText.length > Math.max(120, args.text.length * 4)) continue;

          const normText = normalizeStr(rawText);
          if (!normText) continue;

          let matchScore = 0;
          if (normText === targetNorm) {
            matchScore = 1200; // Exact match
          } else if (normText.startsWith(targetNorm)) {
            matchScore = 900;
          } else if (normText.includes(targetNorm)) {
            const diff = Math.max(0, rawText.length - args.text.length);
            matchScore = Math.max(200, 700 - diff * 3);
          } else if (targetNorm.includes(normText) && normText.length >= 4) {
            matchScore = 400;
          } else {
            continue;
          }

          // Heavy bonus for elements visible in the CURRENT viewport!
          const inViewport = (rect.top < vh && rect.bottom > 0 && rect.left < vw && rect.right > 0);
          if (inViewport) {
            matchScore += 800; // Strongly prefer viewport elements
          } else {
            matchScore -= 600; // Severe penalty for offscreen elements to prevent auto-scrolling away!
          }

          // Interactive bonus
          const isInteractive = el.matches('button, a, input, [role="button"], [onclick]') || el.closest('button, a, [role="button"]');
          if (isInteractive) matchScore += 300;

          // Prefer elements closer to center of viewport
          const centerYDist = Math.abs((rect.top + rect.height / 2) - (vh / 2));
          matchScore -= (centerYDist / vh) * 100;

          if (matchScore > highestScore) {
            highestScore = matchScore;
            bestEl = el.closest('button, a, input, [role="button"], [onclick], .a-button') || el;
          }
        }

        if (bestEl) {
          const rect = bestEl.getBoundingClientRect();
          const cx = Math.round(rect.left + rect.width / 2);
          const cy = Math.round(rect.top + rect.height / 2);
          return { el: bestEl, clickX: cx, clickY: cy, fromCoords: false };
        }
      }
    }

    return null;
  }

  function showRipple(x, y) {
    const r = document.createElement('div');
    r.style.cssText = `position:fixed;left:${x-22}px;top:${y-22}px;width:44px;height:44px;border-radius:50%;background:rgba(56,189,248,0.5);border:2px solid #38bdf8;box-shadow:0 0 16px #38bdf8;pointer-events:none;z-index:9999999;transform:scale(0.5);transition:all 0.6s cubic-bezier(0,0,0.2,1);`;
    document.body.appendChild(r);
    requestAnimationFrame(() => {
      r.style.transform = 'scale(2.5)';
      r.style.opacity = '0';
    });
    setTimeout(() => r.remove(), 650);
  }

  function showScrollWave(x, y, direction) {
    const isDown = (direction || 'down').toLowerCase() === 'down';
    const wave = document.createElement('div');
    wave.style.cssText = `position:fixed;left:${x-26}px;top:${y-26}px;width:52px;height:52px;border-radius:50%;background:rgba(16,185,129,0.35);border:2px solid #10b981;box-shadow:0 0 16px #10b981;pointer-events:none;z-index:9999999;display:flex;align-items:center;justify-content:center;font-size:24px;color:#ffffff;transform:scale(0.6);transition:all 0.5s cubic-bezier(0,0,0.2,1);`;
    wave.innerHTML = isDown ? '&#8595;' : '&#8593;';
    document.body.appendChild(wave);
    requestAnimationFrame(() => {
      wave.style.transform = `scale(1.5) translateY(${isDown ? 24 : -24}px)`;
      wave.style.opacity = '0';
    });
    setTimeout(() => wave.remove(), 550);
  }

  // ── Patch C: New Tools ──────────────────────────────────────────────────────

  if (tool === 'select_option') {
    const target = findTarget(args);
    const el = target ? target.el : null;
    if (!el) return { success: false, error: `Select not found: ${JSON.stringify(args)}` };
    const sel = el.tagName === 'SELECT' ? el : (el.querySelector ? el.querySelector('select') : null);
    if (!sel) return { success: false, error: 'Target is not a native <select> — try clicking it to open a custom dropdown.' };
    const wanted = String(args.value || '').trim();
    const opts = Array.from(sel.options);
    let match = opts.find(o => o.value === wanted || o.text.trim().toLowerCase() === wanted.toLowerCase());
    if (!match) match = opts.find(o => o.text.trim().toLowerCase().includes(wanted.toLowerCase()) ||
                                        wanted.toLowerCase().includes(o.text.trim().toLowerCase()));
    if (!match) {
      return { success: false, error: `Option "${wanted}" not found. Available: ${opts.slice(0, 12).map(o => o.text.trim()).join(' | ')}` };
    }
    sel.focus();
    const valueBefore = sel.value;
    sel.value = match.value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const r = sel.getBoundingClientRect();
    showRipple(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    const selEffect = (sel.value !== valueBefore) ? 'confirmed' : 'suspected_noop';
    return { success: true, effect: selEffect, message: `Selected "${match.text.trim()}" in <select> (effect: ${selEffect})` };
  }

  if (tool === 'hover') {
    const target = findTarget(args);
    if (!target || !target.el) return { success: false, error: `Could not find element to hover: ${JSON.stringify(args)}` };
    const el = target.el;
    const r0 = el.getBoundingClientRect();
    if (r0.bottom < 0 || r0.top > window.innerHeight) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(r => setTimeout(r, 350));
    }
    const rect = el.getBoundingClientRect();
    const coords = resolveCoordinates(args.coordinates);
    const inVp = rect.top >= 0 && rect.bottom <= window.innerHeight;
    const cx = (coords && inVp) ? coords[0] : Math.round(rect.left + rect.width / 2);
    const cy = (coords && inVp) ? coords[1] : Math.round(rect.top + rect.height / 2);
    showRipple(cx, cy);
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    if (window.PointerEvent) {
      el.dispatchEvent(new PointerEvent('pointerover', opts));
      el.dispatchEvent(new PointerEvent('pointerenter', opts));
      el.dispatchEvent(new PointerEvent('pointermove', opts));
    }
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', opts));
    el.dispatchEvent(new MouseEvent('mousemove', opts));
    await new Promise(r => setTimeout(r, 400));
    return { success: true, effect: 'unverifiable', message: `Hovered <${el.tagName.toLowerCase()}> ("${(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 35)}")` };
  }

  if (tool === 'scroll_to_element') {
    if (!args.selector) return { success: false, error: 'scroll_to_element requires a selector' };
    let el = null;
    try { el = document.querySelector(args.selector); } catch (e) {}
    if (!el) return { success: false, error: `Element not found: ${args.selector}` };
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await new Promise(r => setTimeout(r, 500));
    const rect = el.getBoundingClientRect();
    return { success: true, message: `Scrolled element into view (now at y=${Math.round(rect.top)}, fully visible: ${rect.top >= 0 && rect.bottom <= window.innerHeight})` };
  }

  if (tool === 'go_back') {
    const hrefBefore = window.location.href;
    window.history.back();
    await new Promise(r => setTimeout(r, 700));
    const goBackEffect = (window.location.href !== hrefBefore) ? 'confirmed' : 'unverifiable';
    return { success: true, effect: goBackEffect, message: `Went back — now at ${location.href.slice(0, 80)} (effect: ${goBackEffect})` };
  }

  if (tool === 'refresh') {
    location.reload();
    return { success: true, message: 'Page reloading' };
  }

  if (tool === 'read_page') {
    const txt = (document.body ? document.body.innerText : '')
      .replace(/\n{3,}/g, '\n\n').trim();
    return { success: true, content: txt.slice(0, 6000), message: `Read page (${txt.length} chars, first 6000 returned)` };
  }

  if (tool === 'click') {
    const target = findTarget(args);
    if (!target) {
      return { success: false, error: `Could not find element to click: ${JSON.stringify(args)}` };
    }
    if (target.isStale) {
      return { success: false, error: `ERROR: STALE_ELEMENT: target '${target.targetDesc}' was not found in current DOM (page dynamically updated). Re-read latest DOM list.` };
    }

    const el = target.el;
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    const isInViewport = (
      rect.top >= 10 &&
      rect.bottom <= vh - 10 &&
      rect.left >= 0 &&
      rect.right <= vw
    );

    // CRITICAL: ONLY scroll if the element is NOT already in the viewport!
    // Never auto-scroll when clicking coordinates or when element is already visible.
    if (!isInViewport && !target.fromCoords) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(r => setTimeout(r, 250));
    }

    // Determine click location
    const finalRect = el.getBoundingClientRect();
    const cx = target.fromCoords ? target.clickX : Math.round(finalRect.left + finalRect.width / 2);
    const cy = target.fromCoords ? target.clickY : Math.round(finalRect.top + finalRect.height / 2);
    showRipple(cx, cy);

    // Setup action effect verification
    const initialUrl = window.location.href;
    const initialActive = document.activeElement;
    let domMutations = 0;
    let observer = null;
    try {
      observer = new MutationObserver((mutations) => {
        domMutations += mutations.length;
      });
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
    } catch (e) {}

    // Dispatch to direct hit element, interactive container, and inner submit/button
    const targets = [];
    if (target.directTarget) targets.push(target.directTarget);
    if (el && !targets.includes(el)) targets.push(el);

    const innerSubmit = el.querySelector ? el.querySelector('input[type="submit"], input[type="button"], button') : null;
    if (innerSubmit && !targets.includes(innerSubmit)) {
      targets.push(innerSubmit);
    }

    // Neutralize target="_blank" to target="_self" on any anchor
    for (const t of targets) {
      const link = t.tagName === 'A' ? t : (t.closest ? t.closest('a') : null);
      if (link && link.getAttribute('target') === '_blank') {
        link.setAttribute('target', '_self');
      }
    }

    // Dispatch full pointer and mouse event sequence across targets
    const mouseOpts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    for (const t of targets) {
      if (window.PointerEvent) {
        t.dispatchEvent(new PointerEvent('pointerover', mouseOpts));
        t.dispatchEvent(new PointerEvent('pointerenter', mouseOpts));
        t.dispatchEvent(new PointerEvent('pointerdown', mouseOpts));
        t.dispatchEvent(new PointerEvent('pointerup', mouseOpts));
      }

      t.dispatchEvent(new MouseEvent('mouseover', mouseOpts));
      t.dispatchEvent(new MouseEvent('mouseenter', mouseOpts));
      t.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
      if (typeof t.focus === 'function') t.focus();
      t.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
      t.dispatchEvent(new MouseEvent('click', mouseOpts));

      // Native .click()
      if (typeof t.click === 'function') {
        try { t.click(); } catch(e) {}
      }
    }

    const parentClickable = el.closest('button, a, input, [role="button"]');
    if (parentClickable && !targets.includes(parentClickable) && typeof parentClickable.click === 'function') {
      try { parentClickable.click(); } catch(e) {}
    }

    // Wait 250ms for asynchronous DOM updates or navigation triggers
    await new Promise(r => setTimeout(r, 250));
    if (observer) {
      try { observer.disconnect(); } catch (e) {}
    }

    const urlChanged = window.location.href !== initialUrl;
    const focusChanged = document.activeElement !== initialActive && document.activeElement !== document.body;
    const isConfirmed = urlChanged || domMutations > 0 || focusChanged;
    const effect = isConfirmed ? 'confirmed' : 'suspected_noop';

    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.tagName).trim().replace(/\s+/g, ' ');
    const effectDetails = urlChanged ? ', navigated' : domMutations > 0 ? `, ${domMutations} DOM updates` : focusChanged ? ', focus changed' : '';
    const msg = isConfirmed
      ? `OK: Clicked ${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} ("${label.slice(0, 35)}") @(${cx},${cy}) (effect: confirmed${effectDetails})`
      : `WARN: Clicked ${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} ("${label.slice(0, 35)}") @(${cx},${cy}) (effect: suspected_noop - page did not change)`;

    return {
      success: true,
      effect: effect,
      message: msg,
      click_coords: [cx, cy]
    };
  }

  if (tool === 'type') {
    const target = findTarget(args);
    const el = target ? target.el : null;
    if (!el) return { success: false, error: `Could not find input to type: ${JSON.stringify(args)}` };

    const inputEl = el.matches('input, textarea, [contenteditable="true"]') ? el : (el.querySelector('input, textarea, [contenteditable="true"]') || el);

    const rect = inputEl.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const isInViewport = (rect.top >= 0 && rect.bottom <= vh && rect.left >= 0 && rect.right <= vw);
    if (!isInViewport) {
      inputEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(r => setTimeout(r, 150));
    }

    inputEl.focus();
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);
    showRipple(cx, cy);

    // P0-2: Read value BEFORE typing so we can measure effect
    const valueBefore = inputEl.isContentEditable ? (inputEl.textContent || '') : (inputEl.value || '');

    if (args.clear_first) {
      if (inputEl.isContentEditable) inputEl.textContent = '';
      else inputEl.value = '';
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const text = args.text || '';
    if (inputEl.isContentEditable) {
      inputEl.textContent = (args.clear_first ? '' : inputEl.textContent) + text;
    } else {
      inputEl.value = (args.clear_first ? '' : inputEl.value) + text;
    }
    inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: text, inputType: 'insertText' }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));

    if (args.press_enter) {
      ['keydown', 'keypress', 'keyup'].forEach(type => {
        inputEl.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      });
      if (inputEl.form) {
        inputEl.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    }

    // P0-2: Measure value AFTER typing — property-level check catches React-controlled fields
    const valueAfter = inputEl.isContentEditable ? (inputEl.textContent || '') : (inputEl.value || '');
    const typeEffect = (valueAfter !== valueBefore) ? 'confirmed' : 'suspected_noop';

    return {
      success: true,
      effect: typeEffect,
      message: `Typed into ${inputEl.tagName.toLowerCase()}${inputEl.id ? '#' + inputEl.id : ''} (effect: ${typeEffect})`
    };
  }

  if (tool === 'scroll') {
    const direction = (args.direction || 'down').toLowerCase();
    const rawAmount = parseInt(args.amount, 10);
    const amount = (!isNaN(rawAmount) && rawAmount > 0) ? rawAmount : 500;
    const dy = direction === 'up' ? -amount : amount;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const coords = resolveCoordinates(args.coordinates);
    const cx = coords ? coords[0] : Math.round(vw / 2);
    const cy = coords ? coords[1] : Math.round(vh / 2);

    showScrollWave(cx, cy, direction);

    // 1. Find target element from selector or coordinates
    let targetEl = null;
    if (args.selector) {
      try {
        targetEl = document.querySelector(args.selector);
      } catch (e) {}
    }
    if (!targetEl) {
      targetEl = document.elementFromPoint(cx, cy);
    }

    // 2. Locate closest scrollable container ancestor
    function findScrollable(el) {
      let curr = el;
      while (curr && curr !== document.documentElement && curr !== document.body) {
        try {
          const style = window.getComputedStyle(curr);
          const oy = style.overflowY;
          const ox = style.overflow;
          const canScroll = (oy === 'auto' || oy === 'scroll' || ox === 'auto' || ox === 'scroll');
          if (canScroll && curr.scrollHeight > curr.clientHeight + 10) {
            return curr;
          }
        } catch (e) {}
        curr = curr.parentElement;
      }
      return null;
    }

    const scrollContainer = findScrollable(targetEl);
    let scrolledTarget = 'window';
    let prevContainerScroll = 0;

    // 3. Scroll container if found
    if (scrollContainer) {
      prevContainerScroll = scrollContainer.scrollTop;
      scrollContainer.scrollBy({ top: dy, left: 0, behavior: 'smooth' });
      scrolledTarget = `${scrollContainer.tagName.toLowerCase()}${scrollContainer.id ? '#' + scrollContainer.id : ''}`;
    }

    // 4. Scroll window / documentElement / body
    const docEl = document.scrollingElement || document.documentElement || document.body;
    const prevWinY = window.scrollY || window.pageYOffset || (docEl ? docEl.scrollTop : 0);

    window.scrollBy({ top: dy, left: 0, behavior: 'smooth' });
    if (docEl && typeof docEl.scrollBy === 'function') {
      docEl.scrollBy({ top: dy, left: 0, behavior: 'smooth' });
    }

    // 5. Fallback after 60ms if smooth scroll was suppressed or ignored
    await new Promise(r => setTimeout(r, 60));
    if (scrollContainer && Math.abs(scrollContainer.scrollTop - prevContainerScroll) < 5) {
      scrollContainer.scrollTop += dy;
    }
    const midWinY = window.scrollY || window.pageYOffset || (docEl ? docEl.scrollTop : 0);
    if (!scrollContainer && Math.abs(midWinY - prevWinY) < 5) {
      if (docEl) docEl.scrollTop += dy;
      window.scrollTo(0, prevWinY + dy);
    }

    // 6. Dispatch synthetic WheelEvent at (cx, cy) to trigger infinite scroll and virtual list handlers
    try {
      const wheelOpts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: cx,
        clientY: cy,
        deltaY: dy,
        deltaMode: 0
      };
      const hitEl = targetEl || docEl || document.body;
      hitEl.dispatchEvent(new WheelEvent('wheel', wheelOpts));
      if (scrollContainer && scrollContainer !== hitEl) {
        scrollContainer.dispatchEvent(new WheelEvent('wheel', wheelOpts));
      }
    } catch (e) {}

    // Allow smooth scroll animation and lazy images to settle
    await new Promise(r => setTimeout(r, 400));

    const finalWinY = window.scrollY || window.pageYOffset || (docEl ? docEl.scrollTop : 0);
    const moved = Math.abs(finalWinY - prevWinY);

    // P0-2: Check container scroll delta too for inner-panel scrolls
    const containerMoved = scrollContainer ? Math.abs(scrollContainer.scrollTop - prevContainerScroll) : 0;
    const scrollEffect = (moved > 5 || containerMoved > 5) ? 'confirmed' : 'suspected_noop';

    return {
      success: true,
      effect: scrollEffect,
      message: `Scrolled ${direction} ${amount}px at (${cx},${cy}) on ${scrolledTarget} (moved: ${moved}px, effect: ${scrollEffect})`,
      scroll_coords: [cx, cy]
    };
  }

  if (tool === 'press_key') {
    const key = args.key || 'Enter';
    const active = document.activeElement || document.body;
    ['keydown', 'keypress', 'keyup'].forEach(type => {
      active.dispatchEvent(new KeyboardEvent(type, { key: key, code: key, bubbles: true, cancelable: true }));
    });
    return { success: true, effect: 'unverifiable', message: `Pressed key '${key}'` };
  }

  if (tool === 'extract_content') {
    const target = findTarget(args);
    const el = (target && target.el) || document.body;
    return { success: true, content: (el.innerText || el.textContent || '').slice(0, 800) };
  }

  if (tool === 'wait') {
    const s = parseFloat(args.seconds) || 2.0;
    // Settling delay is handled cleanly by the orchestrator post-action timer to prevent double-waiting
    return { success: true, message: `Waited ${s}s` };
  }

  if (tool === 'drag') {
    let startCoords = resolveCoordinates(args.start_coordinates || args.from_coordinates);
    let endCoords = resolveCoordinates(args.end_coordinates || args.to_coordinates);

    if (!startCoords && (args.start_selector || args.start_element || args.selector || args.element)) {
      const st = findTarget({ selector: args.start_selector || args.selector, element: args.start_element || args.element });
      if (st && !st.isStale) startCoords = [st.clickX, st.clickY];
    }
    if (!endCoords && (args.end_selector || args.end_element)) {
      const et = findTarget({ selector: args.end_selector, element: args.end_element });
      if (et && !et.isStale) endCoords = [et.clickX, et.clickY];
    }

    if (!startCoords || !endCoords) {
      return { success: false, error: 'drag requires start_coordinates and end_coordinates (e.g. [x1, y1] and [x2, y2])' };
    }

    const [x1, y1] = startCoords;
    const [x2, y2] = endCoords;

    showRipple(x1, y1);

    const startEl = document.elementFromPoint(x1, y1) || document.body;
    const endEl = document.elementFromPoint(x2, y2) || document.body;

    // Pointer sequence
    const pOpts1 = { bubbles: true, cancelable: true, view: window, clientX: x1, clientY: y1, pointerId: 1, isPrimary: true };
    startEl.dispatchEvent(new PointerEvent('pointerdown', pOpts1));
    startEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: x1, clientY: y1 }));

    // Drag intermediate steps
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const curX = Math.round(x1 + (x2 - x1) * (i / steps));
      const curY = Math.round(y1 + (y2 - y1) * (i / steps));
      await new Promise(r => setTimeout(r, 25));
      const moveOpts = { bubbles: true, cancelable: true, view: window, clientX: curX, clientY: curY, pointerId: 1, isPrimary: true };
      window.dispatchEvent(new PointerEvent('pointermove', moveOpts));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window, clientX: curX, clientY: curY }));
    }

    const pOpts2 = { bubbles: true, cancelable: true, view: window, clientX: x2, clientY: y2, pointerId: 1, isPrimary: true };
    endEl.dispatchEvent(new PointerEvent('pointerup', pOpts2));
    endEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: x2, clientY: y2 }));
    showRipple(x2, y2);

    return {
      success: true,
      effect: 'unverifiable',
      message: `Dragged from (${x1}, ${y1}) to (${x2}, ${y2})`,
      click_coords: [x2, y2]
    };
  }

  if (tool === 'finish_task') {
    return { success: true, finished: true, summary: args.summary || 'Task completed.' };
  }

  return { success: false, error: `Unknown tool: ${tool}` };
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP ORCHESTRATOR — 3-Layer Parallel Pipeline
// ═══════════════════════════════════════════════════════════════════════════

async function runTaskStep() {
  if (!isTaskActive) return;

  try {
    if (currentStep >= maxSteps) {
      console.log(`🛑 [PrivaPilot] Max steps reached (${maxSteps})`);
      isTaskActive = false;
      clearStepWatchdog();
      broadcastToUI({ type: 'TASK_FINISHED', summary: 'Max step limit reached.' });
      sendBridgeMessage({
        type: 'tool_call',
        decision: {
          tool: 'finish_task',
          args: { summary: 'Completed: Maximum step limit reached.' },
          thought: 'Reached maximum allowed autonomous steps.'
        }
      });
      return;
    }

    currentStep++;
    const stepT0 = performance.now();
    console.log(`🚀 [PrivaPilot] Running Step ${currentStep} for goal: "${currentTaskGoal}"`);

    // 0. Ensure offscreen ML engine is running
    await ensureOffscreenDocument();
    const t_offscreen = performance.now();

    // 1. Resolve target web tab safely
    const targetTab = await getTargetWebTab(currentTaskGoal);
    const tabUrl = getTabUrl(targetTab);
    if (!targetTab || !targetTab.id || (!isAllowedUrl(tabUrl) && targetTab.status !== 'loading')) {
      console.warn('⚠️ Could not find or create an accessible web tab');
      sendBridgeMessage({
        type: 'task_error',
        message: 'Could not access a valid web tab. Please open a webpage (http/https).'
      });
      isTaskActive = false;
      clearStepWatchdog();
      return;
    }

    activeTargetTabId = targetTab.id;

    // Fast DOM readiness check: since we already waited 2.0s settling time after the action,
    // check if the page has already rendered interactive DOM. If yes, proceed immediately (0ms stall).
    let isDomReady = false;
    try {
      const readyCheck = await chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        func: () => document.readyState !== 'loading' && !!document.body && (document.body.children.length > 0 || (document.body.innerText || '').length > 10),
      });
      isDomReady = !!(readyCheck && readyCheck[0] && readyCheck[0].result);
    } catch (e) {
      isDomReady = false;
    }

    // Only if DOM is completely blank/unrendered and tab reports loading, wait with a short timeout capped at 800ms
    if (!isDomReady && targetTab.status === 'loading') {
      console.log(`⏳ [PrivaPilot] Tab ${targetTab.id} DOM not ready yet, waiting briefly (max 800ms)...`);
      await new Promise(resolve => {
        let done = false;
        const timer = setTimeout(() => {
          if (!done) { done = true; chrome.tabs.onUpdated.removeListener(loadListener); resolve(); }
        }, 800);
        const loadListener = (tid, changeInfo) => {
          if (tid === targetTab.id && (changeInfo.status === 'complete' || (changeInfo.url && isAllowedUrl(changeInfo.url)))) {
            if (!done) {
              done = true;
              clearTimeout(timer);
              chrome.tabs.onUpdated.removeListener(loadListener);
              setTimeout(resolve, 50);
            }
          }
        };
        chrome.tabs.onUpdated.addListener(loadListener);
      });
      try {
        const refreshed = await chrome.tabs.get(targetTab.id);
        if (refreshed) Object.assign(targetTab, refreshed);
      } catch (e) {}
    }

    const t_domReady = performance.now();

    // 2. Capture screenshot
    let rawB64 = '';
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(targetTab.windowId, { format: 'jpeg', quality: 85 });
      if (dataUrl) {
        rawB64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
      }
    } catch (err) {
      console.warn('⚠️ captureVisibleTab skipped:', err.message);
    }
    const t_screenshot = performance.now();

    // 3-4. SANITIZATION PIPELINE — Conditional based on toggle
    let domResult = null;
    let finalSanitizedB64 = rawB64;
    let finalTelemetry = {
      domScanMs: 0, totalMs: 0, entitiesDetected: 0,
      protectionStatus: 'BYPASSED',
      gpuVendor: 'none', gpuModel: 'CPU', activeBackend: 'none',
      isNvidia: false, gpuAccelerated: false
    };

    if (sanitizationEnabled) {
      // ── SANITIZATION ON: Full 3-layer pipeline ──
      // Query the already-injected content script directly (zero serialization overhead)
      domResult = await new Promise((resolve) => {
        chrome.tabs.sendMessage(targetTab.id, { type: 'EXECUTE_PRIVACY_SHIELD' }, (resp) => {
          if (chrome.runtime.lastError || !resp) {
            resolve(null);
          } else {
            resolve(resp);
          }
        });
      });
      // Fallback: inject content script if not yet initialized
      if (!domResult) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            files: ['content/pii_rules.js', 'content/privacy_shield.js']
          });
          domResult = await new Promise((resolve) => {
            chrome.tabs.sendMessage(targetTab.id, { type: 'EXECUTE_PRIVACY_SHIELD' }, (resp) => {
              resolve(chrome.runtime.lastError ? null : (resp || null));
            });
          });
        } catch (e) {
          console.warn('⚠️ Content script fallback failed:', e.message);
        }
      }
      const t_domScan_inner = performance.now();

      const domRegions = (domResult && domResult.domRegions) ? domResult.domRegions : [];
      finalTelemetry = {
        domScanMs: domResult ? domResult.domScanMs || 0 : 0,
        totalMs: 0,
        entitiesDetected: domRegions.length,
        protectionStatus: 'DOM_ONLY',
        gpuVendor: mlEngineStatus?.gpuInfo?.vendor || 'none',
        gpuModel: mlEngineStatus?.gpuInfo?.model || 'CPU',
        activeBackend: mlEngineStatus?.gpuInfo?.backend || 'wasm',
        isNvidia: !!mlEngineStatus?.gpuInfo?.isNvidia,
        gpuAccelerated: !!mlEngineStatus?.gpuInfo?.available
      };

      // Send frame + DOM regions to offscreen engine for ML detection and canvas redaction
      if (rawB64) {
        try {
          await ensureOffscreenDocument();
          const mlResult = await sendToMLEngine({
            action: 'PROCESS_FRAME',
            imageBase64: rawB64,
            domRegions: domRegions,
            requireOcr: domResult ? !!domResult.requireOcr : false,
            ocrTargets: domResult ? (domResult.ocrTargets || []) : [],
          }, 2500);
          if (mlResult && mlResult.sanitizedImageBase64) {
            finalSanitizedB64 = mlResult.sanitizedImageBase64;
            finalTelemetry = {
              ...finalTelemetry,
              domScanMs: domResult ? domResult.domScanMs || 0 : 0,
              ...mlResult.telemetry,
              protectionStatus: mlEngineReady ? 'ML_ACTIVE' : 'DOM_REDACTED',
            };
          }
        } catch (err) {
          console.warn('⚠️ Offscreen ML engine processing failed:', err.message);
        }
      } else {
        finalTelemetry = {
          ...finalTelemetry,
          entitiesDetected: 0,
          protectionStatus: rawB64 ? 'CLEAN_FRAME' : 'NO_SCREENSHOT',
        };
      }
      const domScanDuration = Math.round(t_domScan_inner - t_screenshot);
      const mlDuration = Math.round(performance.now() - t_domScan_inner);
      console.log(
        `🛡️ [PrivaPilot] Sanitization Breakdown:\n` +
        `   • DOM Scan (L1):      ${domScanDuration}ms (${domRegions.length} PII nodes)\n` +
        `   • Face Detect (L2):   ${finalTelemetry.faceDetMs || 0}ms (${finalTelemetry.facesDetected || 0} faces)\n` +
        `   • OCR (L3):           ${finalTelemetry.ocrMs || 0}ms (${finalTelemetry.ocrPiiFound || 0} PII, executed: ${!!finalTelemetry.ocrExecuted})\n` +
        `   • Canvas Redact:      ${finalTelemetry.redactionMs || 0}ms (${finalTelemetry.totalRedacted || 0} badges)\n` +
        `   • Total Sanitization: ${domScanDuration + mlDuration}ms`
      );
    } else {
      // ── SANITIZATION OFF: Raw screenshot → agent directly ──
      // Still need DOM elements for the agent to know what's on the page
      // Query the already-injected content script directly
      domResult = await new Promise((resolve) => {
        chrome.tabs.sendMessage(targetTab.id, { type: 'EXECUTE_PRIVACY_SHIELD' }, (resp) => {
          if (chrome.runtime.lastError || !resp) {
            resolve(null);
          } else {
            resolve(resp);
          }
        });
      });
      if (!domResult) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            files: ['content/pii_rules.js', 'content/privacy_shield.js']
          });
          domResult = await new Promise((resolve) => {
            chrome.tabs.sendMessage(targetTab.id, { type: 'EXECUTE_PRIVACY_SHIELD' }, (resp) => {
              resolve(chrome.runtime.lastError ? null : (resp || null));
            });
          });
        } catch (e) {
          console.warn('⚠️ Content script fallback failed:', e.message);
        }
      }
      finalTelemetry.protectionStatus = 'BYPASSED';
      finalTelemetry.domScanMs = domResult ? domResult.domScanMs || 0 : 0;
      console.log(`⚡ [PrivaPilot] Sanitization BYPASSED — raw screenshot sent directly (${rawB64 ? Math.round(rawB64.length * 3/4/1024) : 0}KB)`);
    }
    const t_mlEngine = performance.now();

    const pageContext = {
      sanitizedImageBase64: finalSanitizedB64,
      telemetry: finalTelemetry,
      domElements: domResult ? domResult.domElements : [],
      pageText: domResult ? (domResult.pageText || '') : '',
      viewport: domResult ? domResult.viewport : null,
      title: domResult ? domResult.title : (targetTab.title || ''),
      url: domResult ? domResult.url : (targetTab.url || ''),
    };

    // 5. CRITICAL PATH: Transmit sanitized frame + DOM to server bridge FIRST (lowest latency)
    //    Include raw_image so local Electron UI viewer can toggle between Sanitized vs Original
    const t_preSend = performance.now();

    // Consume any pending user clarification (from ask_user)
    const clarification = lastUserClarification;
    lastUserClarification = null;

    // Build open tabs list for the VLM
    let openTabs = [];
    try {
      openTabs = (await chrome.tabs.query({}))
        .filter(t => isAllowedUrl(getTabUrl(t)))
        .map((t, i) => `${i + 1}. ${(t.title || '').slice(0, 40)} — ${getTabUrl(t).slice(0, 55)}`);
    } catch (e) {}

    startStepWatchdog();
    sendBridgeMessage({
      type: 'step_context',
      chat_id: currentChatId,
      chat_history: currentChatHistory,
      goal: currentTaskGoal,
      step: currentStep,
      sanitized_image: pageContext.sanitizedImageBase64,
      raw_image: rawB64,
      telemetry: pageContext.telemetry,
      dom_elements: pageContext.domElements,
      page_text: pageContext.pageText || '',
      viewport: pageContext.viewport,
      url: pageContext.url,
      title: pageContext.title,
      console_logs: [],
      max_steps: maxSteps,
      user_clarification: clarification ? `Q: ${clarification.question}\nA: ${clarification.answer}` : null,
      open_tabs: openTabs
    });
    const t_bridgeSent = performance.now();

    // 6. Update in-tab HUD (non-critical, fire-and-forget)
    chrome.tabs.sendMessage(targetTab.id, {
      type: 'UPDATE_HUD',
      status: `Thinking (Step ${currentStep})...`,
      latency: pageContext.telemetry.totalMs || pageContext.telemetry.domScanMs || 24
    }).catch(() => {
      const _ = chrome.runtime.lastError;
    });

    // 7. Broadcast telemetry to UI dashboard (includes sanitized frame for thumbnail preview)
    broadcastToUI({
      type: 'STEP_TELEMETRY',
      step: currentStep,
      chatId: currentChatId,
      telemetry: pageContext.telemetry,
      url: pageContext.url,
      title: pageContext.title,
      sanitizedImage: pageContext.sanitizedImageBase64
    });
    const t_end = performance.now();

    // ── PIPELINE TIMING REPORT ──
    const totalStepMs = Math.round(t_end - stepT0);
    const imgSizeKB = rawB64 ? Math.round(rawB64.length * 3 / 4 / 1024) : 0;
    const sanitizedSizeKB = pageContext.sanitizedImageBase64 ? Math.round(pageContext.sanitizedImageBase64.length * 3 / 4 / 1024) : 0;
    console.log(
      `⏱️ [PrivaPilot] Step ${currentStep} Pipeline Timing Report:\n` +
      `   Offscreen check:  ${Math.round(t_offscreen - stepT0)}ms\n` +
      `   Tab resolve+DOM:  ${Math.round(t_domReady - t_offscreen)}ms\n` +
      `   Screenshot:       ${Math.round(t_screenshot - t_domReady)}ms (${imgSizeKB}KB)\n` +
      `   Sanitization:     ${Math.round(t_mlEngine - t_screenshot)}ms [${sanitizationEnabled ? 'ON' : 'BYPASSED'}]\n` +
      `   Bridge send:      ${Math.round(t_bridgeSent - t_preSend)}ms (${sanitizedSizeKB}KB payload)\n` +
      `   UI broadcast:     ${Math.round(t_end - t_bridgeSent)}ms\n` +
      `   ═══ TOTAL STEP:   ${totalStepMs}ms ═══`
    );
  } catch (err) {
    console.error(`❌ [PrivaPilot] Error in runTaskStep (step ${currentStep}):`, err);
    clearStepWatchdog();
    if (isTaskActive) {
      setTimeout(() => {
        if (isTaskActive) runTaskStep();
      }, 2500);
    }
  }
}

// ── SERVER MESSAGE HANDLER ──────────────────────────────────────────────────

async function handleServerMessage(data) {
  const msgType = data.type;

  if (msgType === 'backend_shutdown') {
    console.log('🔌 [PrivaPilot] Backend shutting down. Marking disconnected immediately.');
    isBackendConnected = false;
    broadcastToUI({ type: 'BACKEND_STATUS', connected: false });
    if (socket) {
      try { socket.close(); } catch (e) {}
      socket = null;
    }
    return;
  }

  if (msgType === 'switch_chat') {
    const targetChatId = data.chatId || data.chat_id;
    if (targetChatId) {
      currentChatId = targetChatId;
      broadcastToUI({
        type: 'SWITCH_CHAT',
        chatId: targetChatId
      });
    }
    return;
  }

  if (msgType === 'sync_chats') {
    const payloadStr = JSON.stringify(data.chats || []);
    const signature = `${data.activeChatId || ''}::${payloadStr}`;
    if (signature !== lastIncomingSyncSignature) {
      lastIncomingSyncSignature = signature;
      broadcastToUI({
        type: 'SYNC_CHATS',
        chats: data.chats,
        activeChatId: data.activeChatId
      });
    }
    return;
  }

  if (msgType === 'sync_settings') {
    broadcastToUI({ type: 'SYNC_SETTINGS', settings: data.settings });
    return;
  }

  if (msgType === 'start_task') {
    currentChatId = data.chat_id || currentChatId || null;
    currentChatHistory = data.chat_history || [];
    currentTaskGoal = data.goal || '';
    currentStep = 0;
    if (data.max_steps) {
      maxSteps = parseInt(data.max_steps, 10) || 40;
    }
    isTaskActive = true;
    activeTargetTabId = null;
    console.log(`🚀 [PrivaPilot] Task Start received: "${currentTaskGoal}" (chat: ${currentChatId}, maxSteps: ${maxSteps})`);
    broadcastToUI({ type: 'BACKEND_STATUS', connected: true });
    broadcastToUI({ type: 'TASK_STARTED', goal: currentTaskGoal, chatId: currentChatId });

    // Auto-focus Chrome browser window and open sidepanel if closed (do nothing if already open)
    try {
      await ensureSidePanelVisible();
    } catch (e) {
      console.warn('[Bridge] Sidepanel visibility notice:', e.message);
    }

    // Ensure ML engine is ready before first step
    await ensureOffscreenDocument();
    runTaskStep();
    return;
  }

  if (msgType === 'stop_task') {
    if (!isTaskActive) {
      // Do nothing if no task active to prevent false 'Task stopped' messages
      return;
    }
    isTaskActive = false;
    currentTaskGoal = '';
    console.log(`🛑 [PrivaPilot] Task Stop received (chat: ${data.chat_id || 'all'})`);
    broadcastToUI({ type: 'TASK_STOPPED', chatId: data.chat_id || currentChatId });
    if (activeTargetTabId) {
      chrome.tabs.sendMessage(activeTargetTabId, {
        type: 'UPDATE_HUD',
        status: '🛑 Stopped'
      }).catch(() => { const _ = chrome.runtime.lastError; });
    }
    return;
  }

  if (msgType === 'reset_session') {
    isTaskActive = false;
    currentTaskGoal = '';
    if (!data.chat_id || data.chat_id === currentChatId) {
      currentChatId = null;
      currentChatHistory = [];
    }
    console.log(`🔄 [PrivaPilot] Session reset (chat: ${data.chat_id || 'all'})`);
    return;
  }

  if (msgType === 'user_reply' || msgType === 'USER_REPLY') {
    if (pendingUserQuestion) {
      console.log(`💬 [PrivaPilot] User reply received via bridge: "${data.answer}"`);
      pendingUserQuestion.resolve(data.answer || null);
    }
    return;
  }

  if (msgType === 'set_sanitization') {
    sanitizationEnabled = !!data.enabled;
    console.log(`🔧 [PrivaPilot] Sanitization ${sanitizationEnabled ? 'ENABLED ✅' : 'DISABLED ⚡ (raw mode)'}`);
    broadcastToUI({ type: 'SANITIZATION_STATUS', enabled: sanitizationEnabled });
    return;
  }

  if (msgType === 'tool_call') {
    const toolCallT0 = performance.now();
    const decision = data.decision || {};
    const tool = decision.tool || 'wait';
    const args = decision.args || {};
    const thought = decision.thought || '';

    const vMeta = decision.visual_context_meta;
    const vLog = vMeta ? ` | Visual: step ${vMeta.step}/${vMeta.max_steps}` : '';
    console.log(`🤖 [PrivaPilot] Action (step ${currentStep}): ${tool}${vLog}`, args);

    broadcastToUI({
      type: 'AGENT_DECISION',
      step: currentStep,
      chatId: currentChatId,
      thought: thought,
      tool: tool,
      args: args,
      visualContext: vMeta,
      remainingSubtasks: decision.remaining_subtasks || []
    });

    // HUD update (non-critical)
    if (activeTargetTabId) {
      chrome.tabs.sendMessage(activeTargetTabId, {
        type: 'UPDATE_HUD',
        status: `Step ${currentStep}: ${tool.toUpperCase()}...`
      }).catch(() => { const _ = chrome.runtime.lastError; });
    }

    // ── Use the unified router ──
    const toolExecT0 = performance.now();
    const toolResult = await dispatchToolToBrowser(tool, args);
    const toolExecMs = Math.round(performance.now() - toolExecT0);

    // Check for finish_task (handled by router)
    if (toolResult && toolResult.finished) {
      if (activeTargetTabId) {
        chrome.tabs.sendMessage(activeTargetTabId, {
          type: 'UPDATE_HUD',
          status: '✅ Task Completed!'
        }).catch(() => { const _ = chrome.runtime.lastError; });
      }
      return;
    }

    const success = toolResult ? toolResult.success !== false : false;
    const resultMsg = toolResult ? (toolResult.message || toolResult.error || JSON.stringify(toolResult)) : 'Action failed';
    const clickCoords = toolResult && toolResult.click_coords ? toolResult.click_coords : null;
    const scrollCoords = toolResult && toolResult.scroll_coords ? toolResult.scroll_coords : null;
    const effect = toolResult ? toolResult.effect : null;

    sendBridgeMessage({
      type: 'tool_result',
      step: currentStep,
      chat_id: currentChatId,
      tool: tool,
      success: success,
      result: resultMsg,
      effect: effect,
      click_coords: clickCoords,
      scroll_coords: scrollCoords
    });

    // Settling delay
    let waitDelay = 2000;
    if (tool === 'wait') {
      const s = parseFloat(args.seconds) || 2.0;
      waitDelay = Math.max(2000, Math.round(s * 1000));
    } else if (tool === 'scroll' || tool === 'scroll_to_element') {
      waitDelay = 1600;
    } else if (tool === 'hover') {
      waitDelay = 1200;
    } else if (tool === 'navigate' || tool === 'go_back' || tool === 'refresh') {
      waitDelay = 2500;
    } else {
      waitDelay = 2000;
    }

    if (activeTargetTabId) {
      chrome.tabs.sendMessage(activeTargetTabId, {
        type: 'UPDATE_HUD',
        status: `Action (${tool}) done. Settling ${(waitDelay / 1000).toFixed(1)}s...`
      }).catch(() => { const _ = chrome.runtime.lastError; });
    }

    const totalToolCallMs = Math.round(performance.now() - toolCallT0);
    console.log(`⏱️ [PrivaPilot] tool_call '${tool}' | exec: ${toolExecMs}ms | total: ${totalToolCallMs}ms → settling ${waitDelay}ms`);
    setTimeout(runTaskStep, waitDelay);
  }
}

// ── STARTUP: Initialize offscreen document ──────────────────────────────────
ensureOffscreenDocument();
