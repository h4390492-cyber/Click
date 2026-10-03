/**
 * Click — Extension Sidepanel Chat & Automation Controller
 *
 * Implements full agent chat pipeline matching the Electron desktop app:
 * - Collapsible sidebar rail (Chats toggle, New Chat +, previous chat tray)
 * - Settings overlay with AI model, steps, visual history, and privacy toggles
 * - Multi-chat persistent storage in localStorage
 * - Exactly 3 translucent suggestions with hover-only refresh button
 * - Live agent execution stream (thoughts, action pills, step pills + thumbnails,
 *   interactive ask_user cards, collapsible activity groups)
 * - Seamless synchronization with Electron app's typing bar and bridge
 */

(function() {
  'use strict';

  // ── DOM ELEMENTS ───────────────────────────────────────────────────────────
  const privacyToggleBtn = document.getElementById('privacyToggleBtn');

  // Top Navigation & Chats Tray Drawer elements
  const chatsToggleBtn = document.getElementById('chatsToggleBtn');
  const chatsTrayDrawer = document.getElementById('chatsTrayDrawer');
  const trayChatsList = document.getElementById('trayChatsList');
  const trayCloseBtn = document.getElementById('trayCloseBtn');
  const newChatBtn = document.getElementById('newChatBtn');
  const settingsBtn = document.getElementById('settingsBtn');

  // App Container & Connection elements
  const appContainer = document.getElementById('appContainer');
  const connectionNotice = document.getElementById('connectionNotice');
  const launchAppBtn = document.getElementById('launchAppBtn');

  // Check if running within Chrome extension environment
  const isExtensionContext = (
    typeof chrome !== 'undefined' &&
    typeof chrome.runtime !== 'undefined' &&
    typeof chrome.runtime.sendMessage === 'function' &&
    typeof window !== 'undefined' &&
    window.location &&
    window.location.protocol === 'chrome-extension:'
  );

  // Maintain active sidepanel port connection to background service worker
  let sidepanelPort = null;
  try {
    if (isExtensionContext && typeof chrome.runtime.connect === 'function') {
      sidepanelPort = chrome.runtime.connect({ name: 'click-sidepanel' });
      sidepanelPort.onMessage.addListener((msg) => {
        if (msg && msg.type === 'BACKEND_STATUS') {
          setConnectionStatus(!!msg.connected);
        }
        if (msg && msg.type === 'SYNC_CHATS') {
          applyRemoteChats(msg.chats, msg.activeChatId);
        }
        if (msg && msg.type === 'SWITCH_CHAT') {
          applyRemoteSwitch(msg.chatId);
        }
      });
    }
  } catch (e) {}

  // Settings Overlay elements
  const settingsOverlay = document.getElementById('settings-overlay');
  const settingsCloseBtn = document.getElementById('settings-close-btn');
  const settingChatModel = document.getElementById('setting-chat-model');
  const settingMaxSteps = document.getElementById('setting-max-steps');
  const settingVisualHistory = document.getElementById('setting-visual-history');
  const settingSanitization = document.getElementById('setting-sanitization');

  // Chat Area elements
  const chatArea = document.getElementById('chatArea');
  const chatEmpty = document.getElementById('chatEmpty');
  const quickChips = document.getElementById('quickChips');
  const refreshBtn = document.getElementById('refreshBtn');
  const messagesList = document.getElementById('messagesList');

  // Modal elements
  const screenshotModal = document.getElementById('screenshotModal');
  const modalBackdrop = document.getElementById('modalBackdrop');
  const modalCloseBtn = document.getElementById('modalCloseBtn');
  const modalTitle = document.getElementById('modalTitle');
  const modalImg = document.getElementById('modalImg');

  // ── STATE ──────────────────────────────────────────────────────────────────
  let chats = [];           // Array of { id, title, messages: [] }
  let activeChatId = null;
  let trayOpen = false;
  let settingsOpen = false;
  let currentTargetTabId = null;
  let taskStartTime = null;
  let activeTimers = {};
  let currentSuggestionSet = 0;

  // Curated suggestion sets (exactly 3 items each)
  const SUGGESTION_SETS = [
    [
      'Search for headphones & compare prices',
      'Add to cart and proceed to checkout',
      'Summarize this page & key details'
    ],
    [
      'Find best discount codes & offers',
      'Read top rated customer reviews',
      'Filter products by 4+ star ratings'
    ],
    [
      'Extract product specifications & specs',
      'Check return policy & shipping info',
      'Find similar recommended items'
    ]
  ];

  function escapeHtml(str) {
    if (typeof str !== 'string') return String(str || '');
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function normalizeDataUrl(b64) {
    if (!b64 || typeof b64 !== 'string') return '';
    const clean = b64.trim();
    if (!clean) return '';
    if (clean.startsWith('data:image/')) return clean;
    if (clean.startsWith('data:')) return clean;
    return `data:image/jpeg;base64,${clean}`;
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  // ── MULTI-CHAT PERSISTENCE & PIPELINE ──────────────────────────────────────
  let isApplyingRemoteSync = false;
  let lastSyncedChatsJson = '';
  let lastSyncedActiveId = null;
  let syncDebounceTimer = null;

  /**
   * Deep-prune image base64 strings to create a compact version for localStorage.
   * Handles both top-level step_items and those nested inside activity_group.items.
   */
  function createLightweightChats(chatList, maxImageLen = 2000) {
    if (!Array.isArray(chatList)) return [];
    return chatList.map(c => {
      if (!c || !Array.isArray(c.messages)) return c;
      return {
        ...c,
        messages: c.messages.map(m => {
          if (!m) return m;
          // Clean nested activity_group items
          if (m.type === 'activity_group' && Array.isArray(m.items)) {
            return {
              ...m,
              items: m.items.map(it => {
                if (it && (it.type === 'step_item' || it.type === 'screenshot') && it.content && it.content.length > maxImageLen) {
                  return { ...it, content: '' };
                }
                return it;
              })
            };
          }
          // Clean top-level step_item content
          if ((m.type === 'step_item' || m.type === 'screenshot') && m.content && m.content.length > maxImageLen) {
            return { ...m, content: '' };
          }
          return m;
        })
      };
    });
  }

  /**
   * Resilient storage engine:
   * 1. Purges obsolete 'cp_chats' key to reclaim storage space.
   * 2. Saves full data to chrome.storage.local (unlimited quota).
   * 3. Progressively compacts and safely writes to localStorage without throwing QuotaExceededError.
   */
  function persistChats(chatList) {
    // 1. Immediately remove legacy CommandPilot key to free up 2-5MB
    try {
      localStorage.removeItem('cp_chats');
    } catch (e) {}

    // 2. High-capacity background persistence via chrome.storage.local
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      try {
        chrome.storage.local.set({ click_chats: chatList }).catch(() => {});
      } catch (e) {}
    }

    // 3. Progressive fallback save to localStorage
    try {
      // Attempt A: Save lightweight version (strip huge base64 frames > 2000 chars)
      const lightweight = createLightweightChats(chatList, 2000);
      localStorage.setItem('click_chats', JSON.stringify(lightweight));
    } catch (errA) {
      console.warn('[Click] LocalStorage quota limit reached, attempting aggressive compaction...', errA);
      try {
        // Attempt B: Aggressive prune — strip all step_item images and keep only last 10 chats
        const aggressive = createLightweightChats(chatList, 0).slice(0, 10);
        localStorage.setItem('click_chats', JSON.stringify(aggressive));
      } catch (errB) {
        try {
          // Attempt C: Ultra-minimal fallback — only current active chat and titles
          const minimal = (chatList || []).slice(0, 5).map(c => ({
            id: c.id,
            title: c.title,
            messages: (c.id === activeChatId ? (c.messages || []).slice(-15) : [])
          }));
          localStorage.setItem('click_chats', JSON.stringify(minimal));
        } catch (errC) {
          console.error('[Click] Critical storage quota exceeded in localStorage:', errC);
        }
      }
    }
  }

  function applyRemoteSwitch(newChatId) {
    if (!newChatId || newChatId === activeChatId) return;
    if (chats.some(c => c.id === newChatId)) {
      activeChatId = newChatId;
      lastSyncedActiveId = activeChatId;
      renderChatsTray();
      renderChat();
    }
  }

  function applyRemoteChats(newChats, newActiveChatId) {
    if (!Array.isArray(newChats) || newChats.length === 0) return;
    const incomingJson = JSON.stringify(newChats);
    const currentJson = JSON.stringify(chats);
    if (incomingJson === currentJson && (!newActiveChatId || activeChatId === newActiveChatId)) {
      return;
    }
    if (incomingJson === lastSyncedChatsJson && (!newActiveChatId || lastSyncedActiveId === newActiveChatId)) {
      return;
    }

    lastSyncedChatsJson = incomingJson;
    if (newActiveChatId) lastSyncedActiveId = newActiveChatId;

    isApplyingRemoteSync = true;
    try {
      chats = newChats;
      if (newActiveChatId && chats.some(c => c.id === newActiveChatId)) {
        activeChatId = newActiveChatId;
      } else if (chats.length > 0 && !chats.some(c => c.id === activeChatId)) {
        activeChatId = chats[0].id;
      }
      persistChats(chats);
      renderChatsTray();
      renderChat();
    } catch (err) {
      console.warn('[Click] Error in applyRemoteChats:', err);
    } finally {
      isApplyingRemoteSync = false;
    }
  }

  function requestChatsFromBridge() {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'REQUEST_CHATS_FROM_BRIDGE' }).catch(() => {});
    }
    // Also try fast HTTP fetch from backend
    fetch('http://127.0.0.1:8765/api/chats')
      .then(res => res.json())
      .then(data => {
        if (data && Array.isArray(data.chats) && data.chats.length > 0) {
          applyRemoteChats(data.chats, data.active_chat_id);
        }
      })
      .catch(() => {});
  }

  function initChats() {
    try {
      const saved = localStorage.getItem('click_chats') || localStorage.getItem('cp_chats');
      if (saved) {
        chats = JSON.parse(saved);
        if (Array.isArray(chats) && chats.length > 0) {
          activeChatId = chats[0].id;
          lastSyncedChatsJson = JSON.stringify(chats);
          lastSyncedActiveId = activeChatId;
          renderChatsTray();
          renderChat();
        }
      }
      // Purge legacy key to free quota immediately
      localStorage.removeItem('cp_chats');
    } catch (e) {}

    // Also check chrome.storage.local for full fidelity history
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['click_chats']).then(res => {
        if (res && Array.isArray(res.click_chats) && res.click_chats.length > 0) {
          if (!chats || chats.length === 0 || res.click_chats.length > chats.length) {
            chats = res.click_chats;
            if (!activeChatId || !chats.some(c => c.id === activeChatId)) {
              activeChatId = chats[0].id;
            }
            renderChatsTray();
            renderChat();
          }
        }
      }).catch(() => {});
    }

    // Request latest synced chats from Electron app / backend
    requestChatsFromBridge();

    if (!chats || chats.length === 0) {
      newChat();
    }
  }

  function saveChats(immediate = false) {
    persistChats(chats);

    // Sync to Electron app via bridge relay (only if not currently applying remote sync)
    if (isApplyingRemoteSync) return;

    const currentJson = JSON.stringify(chats);
    if (currentJson === lastSyncedChatsJson && activeChatId === lastSyncedActiveId) {
      return;
    }
    lastSyncedChatsJson = currentJson;
    lastSyncedActiveId = activeChatId;

    const sendSync = () => {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          type: 'SYNC_CHATS_TO_BRIDGE',
          chats: chats,
          activeChatId: activeChatId
        }).catch(() => {});
      }
    };

    if (immediate) {
      if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
      syncDebounceTimer = null;
      sendSync();
      return;
    }

    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(() => {
      syncDebounceTimer = null;
      sendSync();
    }, 120);
  }

  function getActiveChat() {
    return chats.find(c => c.id === activeChatId);
  }

  function newChat() {
    if (settingsOpen) toggleSettings(false);
    if (trayOpen) toggleChatsTray(false);
    taskStartTime = null;

    const chat = {
      id: generateId(),
      title: 'New Chat',
      messages: []
    };
    chats.unshift(chat);
    activeChatId = chat.id;
    lastSyncedActiveId = activeChatId;
    saveChats(true);
    renderChatsTray();
    renderChat();
  }

  function switchChat(chatId) {
    if (chatId === activeChatId) return;
    if (settingsOpen) toggleSettings(false);
    if (trayOpen) toggleChatsTray(false);

    activeChatId = chatId;
    lastSyncedActiveId = activeChatId;
    renderChatsTray();
    renderChat();

    // 0ms instant switch relay to Electron
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'SWITCH_CHAT_TO_BRIDGE',
        chatId: chatId
      }).catch(() => {});
    }

    saveChats(true);
  }

  function deleteChat(chatId) {
    chats = chats.filter(c => c.id !== chatId);
    if (activeChatId === chatId) {
      if (chats.length === 0) {
        newChat();
        return;
      } else {
        activeChatId = chats[0].id;
        lastSyncedActiveId = activeChatId;
        renderChat();
      }
    }
    saveChats(true);
    renderChatsTray();
  }

  function autoTitleChat(text) {
    const chat = getActiveChat();
    if (!chat || chat.title !== 'New Chat') return;
    let clean = text.trim();
    if (clean.length > 22) clean = clean.substring(0, 20) + '...';
    chat.title = clean;
    saveChats();
    renderChatsTray();
  }

  // ── CHATS TRAY DRAWER (Top Expandable Tray) ───────────────────────────────
  function toggleChatsTray(forceState) {
    trayOpen = typeof forceState === 'boolean' ? forceState : !trayOpen;
    if (chatsTrayDrawer) chatsTrayDrawer.classList.toggle('open', trayOpen);
    if (chatsToggleBtn) chatsToggleBtn.classList.toggle('active', trayOpen);
    if (trayOpen) {
      if (settingsOpen) toggleSettings(false);
      requestChatsFromBridge();
      renderChatsTray();
    }
  }

  function renderChatsTray() {
    if (!trayChatsList) return;
    trayChatsList.innerHTML = '';

    if (!chats || chats.length === 0) {
      trayChatsList.innerHTML = `
        <div class="tray-empty">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.35;margin-bottom:5px;">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <span style="font-size:11px;color:var(--text-muted);">No saved chats</span>
        </div>
      `;
      return;
    }

    chats.forEach(chat => {
      const el = document.createElement('div');
      el.className = `chat-item${chat.id === activeChatId ? ' active' : ''}`;
      el.onclick = (e) => {
        if (!e.target.closest('.chat-item-delete')) {
          switchChat(chat.id);
          toggleChatsTray(false);
        }
      };

      el.innerHTML = `
        <svg class="chat-item-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span class="chat-item-text">${escapeHtml(chat.title || 'New Chat')}</span>
        <button type="button" class="chat-item-delete" data-tooltip="Delete chat">
          <svg class="chat-delete-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      `;

      const delBtn = el.querySelector('.chat-item-delete');
      if (delBtn) {
        delBtn.onclick = (e) => {
          e.stopPropagation();
          deleteChat(chat.id);
        };
      }

      trayChatsList.appendChild(el);
    });
  }

  // Backward compatibility alias
  const renderSidebar = renderChatsTray;
  const toggleSidebar = toggleChatsTray;

  // ── SETTINGS OVERLAY ───────────────────────────────────────────────────────
  function toggleSettings(forceState) {
    settingsOpen = typeof forceState === 'boolean' ? forceState : !settingsOpen;
    if (settingsOverlay) settingsOverlay.classList.toggle('visible', settingsOpen);
    if (settingsBtn) settingsBtn.classList.toggle('active', settingsOpen);
    if (settingsOpen) {
      if (trayOpen) toggleChatsTray(false);
      fetchKeysStatus();
    }
  }

  function loadSettings() {
    try {
      fetchKeysStatus();
      const chatModel = localStorage.getItem('command_pilot_chat_model');
      if (chatModel && settingChatModel) settingChatModel.value = chatModel;

      const maxSteps = localStorage.getItem('command_pilot_pilot_max_steps');
      if (maxSteps && settingMaxSteps) settingMaxSteps.value = maxSteps;

      const visHist = localStorage.getItem('command_pilot_pilot_visual_history_turns');
      if (visHist && settingVisualHistory) settingVisualHistory.value = visHist;

      const sanitize = localStorage.getItem('command_pilot_sanitization');
      if (sanitize !== null && settingSanitization) {
        const isOn = sanitize !== 'false';
        settingSanitization.classList.toggle('on', isOn);
        if (privacyToggleBtn) privacyToggleBtn.classList.toggle('active', isOn);
      }
    } catch (e) {}
  }

  function changeSetting(key, val, notifyBridge = true) {
    try { localStorage.setItem('command_pilot_' + key, val); } catch (e) {}
    if (notifyBridge && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'UPDATE_SETTING_TO_BRIDGE',
        key: key,
        value: val
      });
    }
  }

  if (settingChatModel) {
    settingChatModel.addEventListener('change', () => changeSetting('chat_model', settingChatModel.value));
  }
  if (settingMaxSteps) {
    settingMaxSteps.addEventListener('change', () => changeSetting('pilot_max_steps', settingMaxSteps.value));
  }
  if (settingVisualHistory) {
    settingVisualHistory.addEventListener('change', () => changeSetting('pilot_visual_history_turns', settingVisualHistory.value));
  }
  if (settingSanitization) {
    settingSanitization.addEventListener('click', () => {
      const isOn = settingSanitization.classList.toggle('on');
      changeSetting('sanitization', isOn ? 'true' : 'false');
      if (privacyToggleBtn) privacyToggleBtn.classList.toggle('active', isOn);
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'TOGGLE_SANITIZATION', enabled: isOn });
      }
    });
  }
  if (privacyToggleBtn) {
    privacyToggleBtn.addEventListener('click', () => {
      const isOn = privacyToggleBtn.classList.toggle('active');
      changeSetting('sanitization', isOn ? 'true' : 'false');
      if (settingSanitization) settingSanitization.classList.toggle('on', isOn);
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: 'TOGGLE_SANITIZATION', enabled: isOn });
      }
    });
  }

  // ── SECURE API KEYS: MINIMALIST DYNAMIC PROVIDER STORES ─────────────────
  const onboardingCard = document.getElementById('onboardingCard');
  const onboardingSetupBtn = document.getElementById('onboardingSetupBtn');
  const saveChangesBar = document.getElementById('saveChangesBar');
  const saveStatusHint = document.getElementById('saveStatusHint');
  const saveErrorFeedback = document.getElementById('saveErrorFeedback');
  const btnSaveAllChanges = document.getElementById('btnSaveAllChanges');
  const btnResetAllData = document.getElementById('btnResetAllData');

  const ICONS = {
    pen: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>`,
    check: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    cross: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`
  };

  let keyStore = {
    nvidia: [],
    google: [],
    groq: []
  };

  function renderProviderKeys(provider) {
    const listEl = document.getElementById(`list-${provider}`);
    const countEl = document.getElementById(`count-${provider}`);
    if (!listEl) return;

    const items = keyStore[provider] || [];
    if (countEl) {
      const activeCount = items.filter(it => it.valid || it.isNew || it.isEditing).length;
      countEl.textContent = activeCount ? `${activeCount} active` : 'Not configured';
    }

    listEl.innerHTML = '';
    if (items.length === 0) {
      const emptyNotice = document.createElement('div');
      emptyNotice.className = 'key-empty-notice';
      emptyNotice.textContent = 'No keys configured. Click + Add to add one.';
      listEl.appendChild(emptyNotice);
      return;
    }

    items.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = `key-entry-row ${item.isEditing ? 'editing' : ''}`;

      if (item.isEditing) {
        const wrap = document.createElement('div');
        wrap.className = 'key-edit-wrap';

        // Toggle button: User explicitly chooses KEY vs ENV
        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'btn-mode-toggle';
        toggleBtn.title = 'Switch between direct key and environment variable';
        toggleBtn.innerHTML = `
          <span class="mode-label ${item.mode === 'key' ? 'mode-active' : ''}">KEY</span>
          <span class="mode-divider">/</span>
          <span class="mode-label ${item.mode === 'env' ? 'mode-active' : ''}">ENV</span>
        `;
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          item.mode = item.mode === 'key' ? 'env' : 'key';
          input.placeholder = item.mode === 'env' ? 'Env var name (e.g. NVIDIA_API_KEY)' : 'Paste API key...';
          toggleBtn.innerHTML = `
            <span class="mode-label ${item.mode === 'key' ? 'mode-active' : ''}">KEY</span>
            <span class="mode-divider">/</span>
            <span class="mode-label ${item.mode === 'env' ? 'mode-active' : ''}">ENV</span>
          `;
        });

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'key-edit-input';
        input.placeholder = item.mode === 'env' ? 'Env var name (e.g. NVIDIA_API_KEY)' : 'Paste API key...';
        input.value = item.value || '';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.addEventListener('input', (e) => {
          item.value = e.target.value.trim();
        });

        wrap.appendChild(toggleBtn);
        wrap.appendChild(input);
        row.appendChild(wrap);

        // Actions: Small right tick icon (save) + cross icon (cancel)
        const actions = document.createElement('div');
        actions.className = 'key-entry-actions';

        const saveAction = async () => {
          const val = (input.value || '').trim();
          if (!val) {
            input.focus();
            input.style.borderColor = 'rgba(239, 83, 80, 0.6)';
            setTimeout(() => { input.style.borderColor = ''; }, 1200);
            return;
          }
          item.value = val;
          item.isEditing = false;
          item.isNew = false;
          renderProviderKeys(provider);
          await saveProviderKeys(provider);
        };

        const cancelAction = () => {
          if (item.isNew) {
            keyStore[provider].splice(idx, 1);
          } else {
            item.value = item.originalValue !== undefined ? item.originalValue : item.value;
            item.mode = item.originalMode || item.mode;
            item.isEditing = false;
          }
          renderProviderKeys(provider);
        };

        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            saveAction();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelAction();
          }
        });

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'ghost-btn btn-entry-save';
        saveBtn.title = 'Save (Enter)';
        saveBtn.innerHTML = ICONS.check;
        saveBtn.addEventListener('click', saveAction);

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'ghost-btn btn-entry-cancel';
        cancelBtn.title = 'Cancel (Esc)';
        cancelBtn.innerHTML = ICONS.cross;
        cancelBtn.addEventListener('click', cancelAction);

        actions.appendChild(saveBtn);
        actions.appendChild(cancelBtn);
        row.appendChild(actions);

        // Auto focus input and place cursor at end
        setTimeout(() => {
          input.focus();
          if (input.setSelectionRange) {
            const len = input.value.length;
            input.setSelectionRange(len, len);
          }
        }, 30);
      } else {
        const left = document.createElement('div');
        left.className = 'key-entry-left';

        const modePill = document.createElement('span');
        modePill.className = `key-mode-pill ${item.mode === 'env' ? 'env' : ''}`;
        modePill.textContent = (item.mode || 'KEY').toUpperCase();

        const valSpan = document.createElement('span');
        valSpan.className = 'key-value-text';
        valSpan.textContent = item.display || item.masked || '••••••••';
        valSpan.title = item.display || item.masked || '';

        left.appendChild(modePill);
        left.appendChild(valSpan);
        row.appendChild(left);

        const actions = document.createElement('div');
        actions.className = 'key-entry-actions';

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'ghost-btn btn-entry-edit';
        editBtn.title = 'Edit key';
        editBtn.innerHTML = ICONS.pen;
        editBtn.addEventListener('click', () => {
          item.isEditing = true;
          item.originalValue = item.value || '';
          item.originalMode = item.mode || 'key';
          renderProviderKeys(provider);
        });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'ghost-btn btn-entry-remove';
        removeBtn.title = 'Remove key';
        removeBtn.innerHTML = ICONS.cross;
        removeBtn.addEventListener('click', async () => {
          keyStore[provider].splice(idx, 1);
          renderProviderKeys(provider);
          await saveProviderKeys(provider);
        });

        actions.appendChild(editBtn);
        actions.appendChild(removeBtn);
        row.appendChild(actions);
      }

      listEl.appendChild(row);
    });
  }

  // Hook up "+ Add Key" buttons
  document.querySelectorAll('.btn-add-key').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const provider = btn.getAttribute('data-provider');
      if (!provider || !keyStore[provider]) return;

      const box = document.getElementById(`box-${provider}`);
      if (box) box.open = true;

      keyStore[provider].push({
        mode: 'key',
        value: '',
        isNew: true,
        isEditing: true
      });
      renderProviderKeys(provider);
    });
  });

  function updateEmptyState(hasConfiguredKeys) {
    const emptyReady = document.getElementById('emptyReadyState');
    const noMessages = !activeChatId || !chats.find(c => c.id === activeChatId)?.messages?.length;

    if (!hasConfiguredKeys) {
      if (onboardingCard) onboardingCard.style.display = noMessages ? 'flex' : 'none';
      if (emptyReady) emptyReady.style.display = 'none';
    } else {
      if (onboardingCard) onboardingCard.style.display = 'none';
      if (emptyReady) emptyReady.style.display = noMessages ? 'flex' : 'none';
    }
  }

  if (onboardingSetupBtn) {
    onboardingSetupBtn.addEventListener('click', () => {
      toggleSettings(true);
      const target = document.getElementById('box-nvidia');
      if (target) {
        target.open = true;
        setTimeout(() => {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          target.classList.add('highlight-flash');
          setTimeout(() => target.classList.remove('highlight-flash'), 1200);
        }, 120);
      }
    });
  }

  async function fetchKeysStatus() {
    try {
      const resp = await fetch('http://127.0.0.1:8765/api/keys/status');
      if (!resp.ok) return;
      const data = await resp.json();

      ['nvidia', 'google', 'groq'].forEach(p => {
        const info = data.keys?.[p];
        if (info && Array.isArray(info.items)) {
          keyStore[p] = info.items.map(it => ({
            index: it.index,
            mode: it.mode || 'key',
            value: it.value || '',
            masked: it.masked || '',
            display: it.display || it.masked || '',
            valid: it.valid !== false,
            isEditing: false,
            isNew: false
          }));
        } else {
          keyStore[p] = [];
        }
        renderProviderKeys(p);
      });

      const hasKeys = !!data.configured;
      updateEmptyState(hasKeys);
    } catch (e) {
      // Backend not running yet
    }
  }

  async function saveProviderKeys(provider) {
    if (saveErrorFeedback) saveErrorFeedback.textContent = '';

    const payload = {
      nvidia_keys: (keyStore.nvidia || []).filter(it => !it.isEditing || it.value).map(it => ({
        mode: it.mode || 'key',
        value: it.value || ''
      })).filter(it => it.value),

      google_keys: (keyStore.google || []).filter(it => !it.isEditing || it.value).map(it => ({
        mode: it.mode || 'key',
        value: it.value || ''
      })).filter(it => it.value),

      groq_keys: (keyStore.groq || []).filter(it => !it.isEditing || it.value).map(it => ({
        mode: it.mode || 'key',
        value: it.value || ''
      })).filter(it => it.value)
    };

    try {
      const resp = await fetch('http://127.0.0.1:8765/api/keys/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const res = await resp.json();
      if (res.errors && res.errors.length > 0) {
        if (saveErrorFeedback) {
          saveErrorFeedback.textContent = `⚠️ ${res.errors.join('; ')}`;
          setTimeout(() => { if (saveErrorFeedback) saveErrorFeedback.textContent = ''; }, 4000);
        }
      }
    } catch (err) {
      if (saveErrorFeedback) {
        saveErrorFeedback.textContent = 'Error connecting to server';
        setTimeout(() => { if (saveErrorFeedback) saveErrorFeedback.textContent = ''; }, 3000);
      }
    } finally {
      await fetchKeysStatus();
    }
  }

  if (btnResetAllData) {
    btnResetAllData.addEventListener('click', async () => {
      const ok = confirm(
        '⚠️ Factory Reset Confirmation\n\n' +
        'This will:\n' +
        '• Clear all saved chats and history\n' +
        '• Remove configured API keys from settings\n' +
        '• Reset Click to a fresh installation state\n\n' +
        'Are you sure you want to proceed?'
      );
      if (!ok) return;

      btnResetAllData.disabled = true;
      btnResetAllData.textContent = 'Resetting...';
      try {
        const resp = await fetch('http://127.0.0.1:8765/api/reset-data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clear_chats: true, clear_keys: true })
        });
        await resp.json();

        // Clear local storage
        try {
          localStorage.removeItem('click_chats');
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.remove(['click_chats']).catch(() => {});
          }
        } catch (e) {}

        chats = [];
        activeChatId = null;
        renderChatsTray();
        await fetchKeysStatus();
        renderChat();
        alert('Click has been reset to factory state.');
      } catch (err) {
        alert('Error resetting data: ' + err.message);
      } finally {
        btnResetAllData.disabled = false;
        btnResetAllData.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
          <span>Clear All Data</span>
        `;
      }
    });
  }

  // ── EXACTLY 3 TRANSLUCENT SUGGESTIONS & HOVER REFRESH ──────────────────────
  function renderSuggestions() {
    if (!quickChips) return;
    quickChips.innerHTML = '';

    const items = SUGGESTION_SETS[currentSuggestionSet % SUGGESTION_SETS.length];
    items.forEach(prompt => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip-item';
      btn.textContent = prompt;
      btn.onclick = () => sendSuggestionTask(prompt);
      quickChips.appendChild(btn);
    });
  }

  function cycleSuggestions() {
    currentSuggestionSet++;
    renderSuggestions();
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      cycleSuggestions();
    });
  }

  function sendSuggestionTask(prompt) {
    const chat = getActiveChat();
    if (!chat) return;

    taskStartTime = Date.now();
    addMessage('user', prompt);
    autoTitleChat(prompt);

    const chatHistory = (chat.messages || [])
      .filter(m => m.role === 'user' || m.role === 'agent')
      .map(m => {
        if (m.type === 'activity_group') {
          const details = [];
          if (m.title) details.push(m.title);
          (m.items || []).forEach(it => {
            if (it.type === 'action' && it.label) details.push(`Action: ${it.label}`);
            if (it.type === 'thought' && it.content) details.push(`Thought: ${it.content}`);
            if (it.type === 'ask_user' && it.answer) details.push(`User confirmed: "${it.answer}"`);
          });
          return { role: 'assistant', content: details.slice(-4).join('; ') };
        }
        return { role: m.role === 'agent' ? 'assistant' : 'user', content: m.content || '' };
      })
      .filter(m => m.content && m.content.trim());

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'START_TASK',
        goal: prompt,
        chatId: activeChatId,
        chatHistory: chatHistory,
        tabId: currentTargetTabId
      });
    }
  }

  // ── ACTION ICONS (Soft Line Drawings without boxes) ────────────────────────
  function getToolIconSvg(tool) {
    switch (tool) {
      case 'click':
        return `<svg class="action-pill-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l7 17 2.5-6.5L20 12 4 4z"/></svg>`;
      case 'type':
        return `<svg class="action-pill-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`;
      case 'scroll':
        return `<svg class="action-pill-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="3" x2="12" y2="21"/><polyline points="8 7 12 3 16 7"/><polyline points="8 17 12 21 16 17"/></svg>`;
      case 'navigate':
        return `<svg class="action-pill-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>`;
      case 'press_key':
        return `<svg class="action-pill-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2.5"/><line x1="6" y1="8" x2="6" y2="8"/><line x1="10" y1="8" x2="10" y2="8"/><line x1="14" y1="8" x2="14" y2="8"/><line x1="18" y1="8" x2="18" y2="8"/><line x1="8" y1="16" x2="16" y2="16"/></svg>`;
      case 'wait':
        return `<svg class="action-pill-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
      case 'extract_content':
        return `<svg class="action-pill-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
      case 'get_console_logs':
        return `<svg class="action-pill-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
      default:
        return `<svg class="action-pill-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
    }
  }

  function cleanSelectorName(selector) {
    if (!selector || typeof selector !== 'string') return '';
    let sel = selector.trim().replace(/\s*\(.*?\)\s*/g, '').replace(/["']/g, '');
    const attrMatch = sel.match(/\[(?:aria-label|placeholder|data-testid|title|name)=([^\]]+)\]/i);
    if (attrMatch && attrMatch[1]) {
      sel = attrMatch[1];
    } else {
      const idMatch = sel.match(/#([a-zA-Z0-9_-]+)/);
      if (idMatch) sel = idMatch[1];
    }
    sel = sel.replace(/[-_]?(?:btn|button|input|field|txt|box|wrap)$/i, '');
    sel = sel.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_/.]+/g, ' ');
    return sel.trim() || selector;
  }

  function formatActionLabel(tool, args) {
    if (!tool || tool === 'finish_task') return null;
    args = args || {};

    switch (tool) {
      case 'click': {
        if (args.text && typeof args.text === 'string' && args.text.trim()) {
          let t = args.text.trim();
          if (t.length > 28) t = t.substring(0, 26) + '...';
          return `Click "${t}"`;
        }
        if (args.selector) {
          return `Click "${cleanSelectorName(args.selector)}"`;
        }
        if (args.coordinates && Array.isArray(args.coordinates)) {
          return `Click (${Math.round(args.coordinates[0])}, ${Math.round(args.coordinates[1])})`;
        }
        return 'Click element';
      }
      case 'type': {
        const field = args.selector ? cleanSelectorName(args.selector) : 'field';
        const val = typeof args.text === 'string' ? args.text.trim() : '';
        if (val) {
          const displayVal = val.length > 20 ? val.substring(0, 18) + '...' : val;
          return `Type "${displayVal}" in ${field}${args.press_enter ? ' ↵' : ''}`;
        }
        return `Fill ${field}`;
      }
      case 'scroll': {
        const dir = (args.direction || 'down').toLowerCase();
        return dir === 'up' ? 'Scroll up' : 'Scroll down';
      }
      case 'navigate': {
        let u = args.url || '';
        try {
          const parsed = new URL(u);
          u = parsed.hostname + (parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '');
        } catch (e) {}
        if (u.length > 30) u = u.substring(0, 27) + '...';
        return u ? `Open ${u}` : 'Navigate';
      }
      case 'wait': {
        return `Wait ${args.seconds || 1}s`;
      }
      case 'press_key': {
        return `Press ${args.key || 'Key'}`;
      }
      case 'extract_content': {
        const target = args.selector ? cleanSelectorName(args.selector) : 'content';
        return `Read ${target}`;
      }
      case 'get_console_logs': {
        return 'Inspect console logs';
      }
      default: {
        return tool.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      }
    }
  }

  // ── CHAT RENDERING ─────────────────────────────────────────────────────────
  function renderChat() {
    const chat = getActiveChat();
    if (!chat || !chat.messages.length) {
      if (chatEmpty) chatEmpty.style.display = 'flex';
      if (messagesList) messagesList.innerHTML = '';
      const hasKeys = Object.values(keyStore).some(arr => arr.some(k => k.valid || k.value));
      updateEmptyState(hasKeys);
      return;
    }

    if (chatEmpty) chatEmpty.style.display = 'none';
    if (!messagesList) return;

    messagesList.innerHTML = '';
    chat.messages.forEach(m => {
      renderMessageItem(m, messagesList);
    });

    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function renderMessageItem(m, container) {
    if (m.type === 'thought') {
      const el = document.createElement('div');
      el.className = 'thought-bubble';
      el.textContent = m.content;
      container.appendChild(el);

    } else if (m.type === 'action') {
      const el = document.createElement('div');
      el.className = 'action-pill';
      const iconSvg = getToolIconSvg(m.tool);
      let statusSvg = '';
      if (m.status === 'done') {
        statusSvg = `<svg class="action-status-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      } else if (m.status === 'error') {
        statusSvg = `<svg class="action-status-svg error" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
      }
      el.innerHTML = `
        ${iconSvg}
        <span class="action-pill-text">${escapeHtml(m.label || m.content)}</span>
        ${statusSvg}
      `;
      container.appendChild(el);

    } else if (m.type === 'step_item' || m.type === 'screenshot') {
      const row = document.createElement('div');
      row.className = 'step-row';

      let pillHtml = `<div class="step-pill"><span>Captured image</span>`;
      if (m.latency) pillHtml += `<span class="step-meta">${m.latency}ms</span>`;
      pillHtml += `</div>`;

      let thumbHtml = '';
      if (m.content && m.content.length > 30) {
        thumbHtml = `
          <div class="step-thumb-wrap" role="button" tabindex="0" data-tooltip="View captured frame">
            <img class="step-thumb-img" src="${m.content}" draggable="false" alt="" />
          </div>
        `;
      }

      row.innerHTML = pillHtml + thumbHtml;

      if (m.content && m.content.length > 30) {
        const thumbEl = row.querySelector('.step-thumb-wrap');
        if (thumbEl) {
          thumbEl.onclick = () => openModal(m.content, `Captured Frame`);
        }
      }

      container.appendChild(row);

    } else if (m.type === 'activity_group') {
      const box = document.createElement('details');
      box.className = 'activity-box';
      if (m.expanded) box.open = true;

      const frames = (m.items || []).filter(it => it.type === 'step_item').length;
      const frameText = frames > 0 ? `${frames} ${frames === 1 ? 'frame' : 'frames'}` : '';

      box.innerHTML = `
        <summary class="activity-header">
          <svg class="activity-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
          <span class="activity-title">${escapeHtml(m.title || `Worked for ${m.duration || 'a few seconds'}`)}</span>
          ${frameText ? `<span class="activity-count">${frameText}</span>` : ''}
        </summary>
        <div class="activity-body"></div>
      `;

      box.ontoggle = () => {
        if (m.expanded !== box.open) {
          m.expanded = box.open;
          saveChats();
        }
      };

      const body = box.querySelector('.activity-body');
      (m.items || []).forEach(item => {
        renderMessageItem(item, body);
      });

      container.appendChild(box);

    } else if (m.type === 'ask_user') {
      const card = document.createElement('div');
      card.className = 'ask-user-card';

      const cardId = m.id || (m.id = 'ask_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5));

      if (activeTimers[cardId]) {
        clearInterval(activeTimers[cardId]);
        delete activeTimers[cardId];
      }

      const headerRow = document.createElement('div');
      headerRow.className = 'ask-header-row';

      const badge = document.createElement('span');
      badge.className = 'ask-badge';
      badge.textContent = 'Input requested';

      const timerEl = document.createElement('span');
      timerEl.className = 'ask-timer';
      headerRow.appendChild(badge);
      headerRow.appendChild(timerEl);
      card.appendChild(headerRow);

      const questionEl = document.createElement('div');
      questionEl.className = 'ask-question';
      questionEl.textContent = m.question || 'The agent needs your input to proceed:';
      card.appendChild(questionEl);

      const handleChoice = (answerText) => {
        if (!answerText || !answerText.trim() || m.status !== 'pending') return;
        const finalAnswer = answerText.trim();
        m.status = 'answered';
        m.answer = finalAnswer;
        if (activeTimers[cardId]) {
          clearInterval(activeTimers[cardId]);
          delete activeTimers[cardId];
        }
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: 'USER_REPLY', answer: finalAnswer });
        }
        saveChats();
        renderChat();
      };

      if (m.status === 'answered') {
        timerEl.style.display = 'none';
        const answeredEl = document.createElement('div');
        answeredEl.className = 'ask-answered-row';
        answeredEl.innerHTML = `<span class="ask-answered-label">Selected:</span> <strong>${escapeHtml(m.answer)}</strong>`;
        card.appendChild(answeredEl);
      } else if (m.status === 'expired' || (m.expiresAt && Date.now() >= m.expiresAt)) {
        m.status = 'expired';
        timerEl.textContent = '⏱ Expired';
        timerEl.classList.add('urgent');
        const expiredEl = document.createElement('div');
        expiredEl.className = 'ask-answered-row';
        expiredEl.innerHTML = `<span style="color:var(--text-muted);font-size:11px;">Response window expired</span>`;
        card.appendChild(expiredEl);
      } else {
        const updateCountdown = () => {
          const expiresAt = m.expiresAt || (Date.now() + 180000);
          const remainingSec = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
          const mins = Math.floor(remainingSec / 60);
          const secs = remainingSec % 60;
          timerEl.textContent = `⏱ ${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
          if (remainingSec <= 30) timerEl.classList.add('urgent');
          if (remainingSec <= 0) {
            if (activeTimers[cardId]) {
              clearInterval(activeTimers[cardId]);
              delete activeTimers[cardId];
            }
            m.status = 'expired';
            saveChats();
            renderChat();
          }
        };

        updateCountdown();
        activeTimers[cardId] = setInterval(updateCountdown, 1000);

        const optionsContainer = document.createElement('div');
        optionsContainer.className = 'ask-options-list';

        const opts = Array.isArray(m.options) ? m.options : [];
        opts.forEach(opt => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ask-option-btn';
          btn.innerHTML = `
            <svg class="ask-radio-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/></svg>
            <span>${escapeHtml(opt)}</span>
          `;
          btn.onclick = () => handleChoice(opt);
          optionsContainer.appendChild(btn);
        });

        // "Other..." row
        const otherRow = document.createElement('div');
        otherRow.className = 'ask-other-row';
        otherRow.innerHTML = `
          <svg class="ask-radio-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          <span class="ask-other-label">Other...</span>
        `;

        otherRow.onclick = (e) => {
          e.stopPropagation();
          if (otherRow.dataset.expanded) return;
          otherRow.dataset.expanded = 'true';
          otherRow.innerHTML = `
            <input class="ask-custom-input" placeholder="Type response..." />
            <button class="ask-custom-send-btn" type="button">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>
              </svg>
            </button>
          `;
          const customInput = otherRow.querySelector('.ask-custom-input');
          const customSend = otherRow.querySelector('.ask-custom-send-btn');
          if (customInput) {
            customInput.focus();
            customInput.onkeydown = (ev) => {
              if (ev.key === 'Enter') handleChoice(customInput.value);
            };
          }
          if (customSend && customInput) {
            customSend.onclick = () => handleChoice(customInput.value);
          }
        };

        optionsContainer.appendChild(otherRow);
        card.appendChild(optionsContainer);
      }

      container.appendChild(card);

    } else {
      // Standard user or agent message bubble
      const el = document.createElement('div');
      el.className = `msg ${m.role}`;
      el.innerHTML = `<div class="msg-bubble">${escapeHtml(m.content)}</div>`;
      container.appendChild(el);
    }
  }

  // ── HELPER CHAT ACTIONS ───────────────────────────────────────────────────
  function addMessage(role, content) {
    if (!content) return;
    const chat = getActiveChat();
    if (!chat) return;

    chat.messages.push({ role, content, type: 'text' });
    saveChats();
    renderChat();
  }

  function addThought(thought) {
    if (!thought || !thought.trim()) return;
    const chat = getActiveChat();
    if (!chat) return;

    chat.messages.push({ role: 'agent', type: 'thought', content: thought.trim() });
    saveChats();
    renderChat();
  }

  function addActionPill(tool, args, label) {
    if (!label) return;
    const chat = getActiveChat();
    if (!chat) return;

    chat.messages.push({
      role: 'agent',
      type: 'action',
      tool: tool,
      args: args,
      label: label,
      status: 'running'
    });
    saveChats();
    renderChat();
  }

  function markLastActionDone() {
    const chat = getActiveChat();
    if (!chat) return;

    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].type === 'action') {
        if (chat.messages[i].status !== 'done') {
          chat.messages[i].status = 'done';
          saveChats();
          renderChat();
        }
        break;
      }
    }
  }

  function markLastActionFailed(err) {
    const chat = getActiveChat();
    if (!chat) return;

    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].type === 'action') {
        chat.messages[i].status = 'error';
        if (err) chat.messages[i].label += ` (Failed)`;
        saveChats();
        renderChat();
        break;
      }
    }
  }

  function addStepItem(step, latency, imgB64) {
    const chat = getActiveChat();
    if (!chat) return;

    chat.messages.push({
      role: 'agent',
      type: 'step_item',
      step: step,
      latency: latency || 0,
      content: normalizeDataUrl(imgB64)
    });
    saveChats();
    renderChat();
  }

  function addAskUserPrompt(data) {
    data = data || {};
    const question = data.question || 'The agent needs your input to proceed:';
    let options = Array.isArray(data.options) && data.options.length ? [...data.options] : [];
    const timeoutMs = Number(data.timeoutMs || data.timeout_ms) || 180000;

    if (!options.length) {
      options = ['Yes, proceed', 'No, skip', 'Cancel'];
    }

    const chat = getActiveChat();
    if (!chat) return;

    for (let i = chat.messages.length - 1; i >= Math.max(0, chat.messages.length - 3); i--) {
      if (chat.messages[i].type === 'ask_user' && chat.messages[i].status === 'pending' && chat.messages[i].question === question) {
        return;
      }
    }

    chat.messages.push({
      id: 'ask_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      role: 'agent',
      type: 'ask_user',
      question: question,
      options: options,
      status: 'pending',
      answer: null,
      expiresAt: Date.now() + timeoutMs,
      timeoutMs: timeoutMs
    });
    saveChats();
    renderChat();
  }

  function collapseToWorkedBox(durationStr) {
    const chat = getActiveChat();
    if (!chat || !chat.messages.length) return;

    let lastUserIdx = -1;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    const searchStart = lastUserIdx >= 0 ? lastUserIdx + 1 : 0;
    const items = [];
    const removeIndices = new Set();

    for (let i = searchStart; i < chat.messages.length; i++) {
      const m = chat.messages[i];
      if (m.type === 'step_item' || m.type === 'thought' || m.type === 'action' || m.type === 'ask_user') {
        items.push(m);
        removeIndices.add(i);
      }
    }

    if (items.length === 0) return;

    const firstIdx = Array.from(removeIndices)[0];
    chat.messages = chat.messages.filter((_, idx) => !removeIndices.has(idx));

    chat.messages.splice(firstIdx, 0, {
      role: 'agent',
      type: 'activity_group',
      duration: durationStr,
      title: `Worked for ${durationStr}`,
      items: items,
      expanded: false
    });

    saveChats();
    renderChat();
  }

  // ── ACTIVE TAB RESOLUTION ──────────────────────────────────────────────────
  async function updateActiveTab() {
    try {
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const tab = tabs[0] || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        if (tab) currentTargetTabId = tab.id;
      }
    } catch (e) {}
  }
  updateActiveTab();
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      if (chrome.tabs.onActivated) chrome.tabs.onActivated.addListener(updateActiveTab);
      if (chrome.tabs.onUpdated) chrome.tabs.onUpdated.addListener(updateActiveTab);
    }
  } catch (e) {}

  // ── MODAL LIGHTBOX ─────────────────────────────────────────────────────────
  function openModal(imgSrc, title) {
    if (!screenshotModal || !imgSrc) return;
    if (modalImg) modalImg.src = imgSrc;
    if (modalTitle) modalTitle.textContent = title || 'Captured Frame';
    screenshotModal.classList.add('visible');
  }

  function closeModal() {
    if (screenshotModal) screenshotModal.classList.remove('visible');
  }

  if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeModal);
  if (modalBackdrop) modalBackdrop.addEventListener('click', closeModal);

  // ── BUTTON HANDLERS ────────────────────────────────────────────────────────
  if (chatsToggleBtn) chatsToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleChatsTray();
  });
  if (trayCloseBtn) trayCloseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleChatsTray(false);
  });
  if (newChatBtn) newChatBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    newChat();
  });
  if (settingsBtn) settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSettings();
  });
  if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSettings(false);
  });

  // Close drawer when clicking outside
  document.addEventListener('click', (e) => {
    if (trayOpen && chatsTrayDrawer && !chatsTrayDrawer.contains(e.target) && !chatsToggleBtn.contains(e.target)) {
      toggleChatsTray(false);
    }
  });

  // ── CONNECTION STATUS & DESKTOP APP LAUNCHER ──────────────────────────────
  let isConnectedToBridge = false;
  let isLaunching = false;

  function setConnectionStatus(connected) {
    isConnectedToBridge = !!connected;
    if (!connectionNotice) return;

    if (isConnectedToBridge) {
      if (appContainer) appContainer.classList.remove('disconnected');
      connectionNotice.classList.add('hidden');
      setTimeout(() => {
        if (isConnectedToBridge) connectionNotice.style.display = 'none';
      }, 800);
    } else {
      if (appContainer) appContainer.classList.add('disconnected');
      connectionNotice.style.display = 'flex';
      void connectionNotice.offsetWidth; // Force reflow for smooth backdrop-filter unblur
      connectionNotice.classList.remove('hidden');
    }
  }

  function queryConnectionStatus() {
    if (isExtensionContext) {
      try {
        chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATUS' }, (resp) => {
          if (!chrome.runtime.lastError && resp && typeof resp.connected === 'boolean') {
            setConnectionStatus(resp.connected);
          }
        });
      } catch (e) {}
    }
  }

  if (launchAppBtn) {
    launchAppBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (isLaunching) return;
      isLaunching = true;

      const btnSpan = launchAppBtn.querySelector('span');
      if (btnSpan) btnSpan.textContent = 'Launching Click...';
      launchAppBtn.style.opacity = '0.65';
      launchAppBtn.style.pointerEvents = 'none';

      // 1. Launch desktop app via registered Windows custom URL protocol (click://)
      try {
        const a = document.createElement('a');
        a.href = 'click://launch';
        a.target = '_self';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          try { a.remove(); } catch (err) {}
        }, 500);
      } catch (err) {
        console.warn('Anchor launch notice:', err);
      }

      try {
        window.location.assign('click://launch');
      } catch (err) {}

      // 2. Instruct background service worker to reconnect immediately
      if (isExtensionContext) {
        try {
          chrome.runtime.sendMessage({ type: 'RECONNECT_BRIDGE' }, () => {
            const _ = chrome.runtime.lastError;
          });
        } catch (err) {}
      }

      // 3. Keep polling background connection status until connected
      let attempts = 0;
      const pollInterval = setInterval(() => {
        attempts++;
        queryConnectionStatus();
        if (isConnectedToBridge || attempts >= 50) {
          clearInterval(pollInterval);
          isLaunching = false;
          if (btnSpan) btnSpan.textContent = 'Launch Click';
          launchAppBtn.style.opacity = '1';
          launchAppBtn.style.pointerEvents = 'auto';
        }
      }, 800);
    });
  }

  // ── BACKGROUND MESSAGE LISTENER (Connected to Electron Typing Bar & Bridge) ──
  if (isExtensionContext && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;

    if (msg.type === 'BACKEND_STATUS') {
      setConnectionStatus(!!msg.connected);
    }

    if (msg.type === 'TASK_STARTED') {
      setConnectionStatus(true);
      if (!taskStartTime) taskStartTime = Date.now();
      if (msg.chatId && msg.chatId !== activeChatId) {
        if (chats.some(c => c.id === msg.chatId)) {
          activeChatId = msg.chatId;
        } else {
          const newC = { id: msg.chatId, title: 'New Chat', messages: [] };
          chats.unshift(newC);
          activeChatId = msg.chatId;
        }
        lastSyncedActiveId = activeChatId;
        renderChatsTray();
        renderChat();
      }
      if (msg.goal) {
        const chat = getActiveChat();
        if (chat) {
          const lastMsg = chat.messages.length ? chat.messages[chat.messages.length - 1] : null;
          if (!lastMsg || lastMsg.content !== msg.goal) {
            addMessage('user', msg.goal);
            autoTitleChat(msg.goal);
          }
        }
      }
    }

    if (msg.type === 'AGENT_DECISION') {
      setConnectionStatus(true);
      if (msg.chatId && activeChatId && msg.chatId !== activeChatId) {
        return;
      }
      if (msg.thought) {
        addThought(msg.thought);
      }
      if (msg.tool && msg.tool !== 'finish_task') {
        if (msg.tool === 'ask_user') {
          addAskUserPrompt(msg.args || {});
        } else {
          const actionLabel = formatActionLabel(msg.tool, msg.args);
          if (actionLabel) {
            addActionPill(msg.tool, msg.args, actionLabel);
          }
        }
      }
    }

    if (msg.type === 'STEP_TELEMETRY') {
      setConnectionStatus(true);
      if (msg.chatId && activeChatId && msg.chatId !== activeChatId) {
        return;
      }
      const t = msg.telemetry || {};
      const latency = t.totalMs || t.domScanMs || 0;
      addStepItem(msg.step, latency, msg.sanitizedImage || '');
      markLastActionDone();
    }

    if (msg.type === 'ASK_USER') {
      addAskUserPrompt(msg);
    }

    if (msg.type === 'TASK_FINISHED') {
      if (msg.chatId && activeChatId && msg.chatId !== activeChatId) {
        return;
      }
      markLastActionDone();
      const elapsedMs = taskStartTime ? (Date.now() - taskStartTime) : 0;
      taskStartTime = null;

      let durStr = '';
      if (elapsedMs > 0) {
        const sec = elapsedMs / 1000;
        durStr = sec < 60 ? `${sec.toFixed(1)}s` : `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
      }

      collapseToWorkedBox(durStr || 'a few seconds');
      addMessage('agent', msg.summary || 'Task completed successfully.');
    }

    if (msg.type === 'TASK_STOPPED') {
      if (!taskStartTime) return; // Ignore if no task was active!
      if (msg.chatId && activeChatId && msg.chatId !== activeChatId) {
        return;
      }
      markLastActionDone();
      const elapsedMs = taskStartTime ? (Date.now() - taskStartTime) : 0;
      taskStartTime = null;
      const durStr = elapsedMs > 0 ? `${(elapsedMs / 1000).toFixed(1)}s` : 'a few seconds';

      collapseToWorkedBox(durStr);
      addMessage('agent', 'Task stopped.');
    }

    if (msg.type === 'SWITCH_CHAT') {
      applyRemoteSwitch(msg.chatId);
    }

    if (msg.type === 'SANITIZATION_STATUS') {
      const isOn = !!msg.enabled;
      if (privacyToggleBtn) privacyToggleBtn.classList.toggle('active', isOn);
      if (settingSanitization) settingSanitization.classList.toggle('on', isOn);
      changeSetting('sanitization', isOn ? 'true' : 'false', false);
    }

    if (msg.type === 'SYNC_SETTINGS' && msg.settings) {
      const s = msg.settings;
      if (s.chat_model && settingChatModel) {
        settingChatModel.value = s.chat_model;
        changeSetting('chat_model', s.chat_model, false);
      }
      if (s.pilot_max_steps && settingMaxSteps) {
        settingMaxSteps.value = String(s.pilot_max_steps);
        changeSetting('pilot_max_steps', String(s.pilot_max_steps), false);
      }
      if (s.pilot_visual_history_turns && settingVisualHistory) {
        settingVisualHistory.value = String(s.pilot_visual_history_turns);
        changeSetting('pilot_visual_history_turns', String(s.pilot_visual_history_turns), false);
      }
      if (s.sanitization !== undefined && settingSanitization) {
        const isOn = String(s.sanitization) !== 'false';
        settingSanitization.classList.toggle('on', isOn);
        if (privacyToggleBtn) privacyToggleBtn.classList.toggle('active', isOn);
        changeSetting('sanitization', isOn ? 'true' : 'false', false);
      }
    }

    if (msg.type === 'SYNC_CHATS') {
      applyRemoteChats(msg.chats, msg.activeChatId);
    }
  });
}

  // ── CUSTOM SLEEK FLOATING NEUTRAL TOOLTIP SYSTEM ─────────────────────────
  let customTooltipEl = null;
  let activeTooltipTarget = null;

  function initCustomTooltips() {
    customTooltipEl = document.getElementById('clickCustomTooltip');
    if (!customTooltipEl) {
      customTooltipEl = document.createElement('div');
      customTooltipEl.id = 'clickCustomTooltip';
      customTooltipEl.className = 'click-custom-tooltip';
      customTooltipEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(customTooltipEl);
    }

    // Convert any remaining title attributes to data-tooltip to prevent native OS browser boxes
    function sanitizeTitles(root = document) {
      root.querySelectorAll('[title]').forEach(el => {
        if (!el.getAttribute('data-tooltip')) {
          el.setAttribute('data-tooltip', el.getAttribute('title'));
        }
        el.removeAttribute('title');
      });
    }

    sanitizeTitles();

    try {
      const observer = new MutationObserver(() => sanitizeTitles());
      observer.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}

    function positionTooltip(target, text) {
      if (!customTooltipEl || !text) return;
      customTooltipEl.textContent = text;
      customTooltipEl.classList.add('visible');

      const rect = target.getBoundingClientRect();
      const tipRect = customTooltipEl.getBoundingClientRect();

      // Center horizontally on target element
      let left = rect.left + (rect.width / 2) - (tipRect.width / 2);
      const pad = 6;
      if (left < pad) left = pad;
      if (left + tipRect.width > window.innerWidth - pad) {
        left = window.innerWidth - pad - tipRect.width;
      }

      // Default: position below target with 6px gap. If close to viewport bottom, position above.
      let top = rect.bottom + 6;
      if (top + tipRect.height > window.innerHeight - pad) {
        top = Math.max(pad, rect.top - tipRect.height - 6);
      }

      customTooltipEl.style.left = `${Math.round(left)}px`;
      customTooltipEl.style.top = `${Math.round(top)}px`;
    }

    function hideTooltip() {
      activeTooltipTarget = null;
      if (customTooltipEl) {
        customTooltipEl.classList.remove('visible');
      }
    }

    document.addEventListener('mouseover', (e) => {
      const target = e.target.closest('[data-tooltip]');
      if (target) {
        if (target.hasAttribute('title')) {
          target.removeAttribute('title');
        }
        const text = target.getAttribute('data-tooltip');
        if (text && text.trim()) {
          activeTooltipTarget = target;
          positionTooltip(target, text.trim());
        }
      }
    });

    document.addEventListener('mouseout', (e) => {
      const target = e.target.closest('[data-tooltip]');
      if (target && target === activeTooltipTarget) {
        hideTooltip();
      }
    });

    document.addEventListener('mousedown', hideTooltip);
    window.addEventListener('scroll', hideTooltip, true);
  }

  // ── INITIALIZATION ─────────────────────────────────────────────────────────
  initChats();
  loadSettings();
  renderSuggestions();
  initCustomTooltips();
  queryConnectionStatus();
  setInterval(queryConnectionStatus, 3000);

})();
