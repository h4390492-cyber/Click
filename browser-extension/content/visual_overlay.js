/**
 * Click — Floating Tab HUD Overlay
 *
 * Injects a discreet, minimalist floating HUD on the active webpage
 * to show live privacy shield status and agent action.
 * Follows modern 2026 aesthetics: dark neutral palette, smooth curveyness,
 * and regular soft line-drawing icons without boxes.
 */

(function() {
  'use strict';

  if (document.getElementById('privapilot-floating-hud')) return;

  const hud = document.createElement('div');
  hud.id = 'privapilot-floating-hud';

  const pill = document.createElement('div');
  pill.className = 'hud-pill';

  // Soft line-drawing shield icon (no box container)
  const shieldIcon = document.createElement('div');
  shieldIcon.className = 'hud-icon-wrap';
  shieldIcon.innerHTML = `
    <svg class="hud-soft-svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <path d="M9 12l2 2 4-4"/>
    </svg>
  `;

  const info = document.createElement('div');
  info.className = 'hud-info';

  const titleRow = document.createElement('div');
  titleRow.className = 'hud-title-row';

  const badge = document.createElement('span');
  badge.className = 'hud-badge-title';
  badge.textContent = 'Privacy Shield';

  const dot = document.createElement('span');
  dot.className = 'hud-dot';

  const metric = document.createElement('span');
  metric.className = 'hud-metric';
  metric.id = 'hud-latency';
  metric.textContent = '~24ms';

  titleRow.appendChild(badge);
  titleRow.appendChild(dot);
  titleRow.appendChild(metric);

  const statusText = document.createElement('div');
  statusText.className = 'hud-status-text';
  statusText.id = 'hud-status-text';
  statusText.textContent = 'Ready for command';

  info.appendChild(titleRow);
  info.appendChild(statusText);

  // Soft line-drawing action icons without boxes
  const actionsWrap = document.createElement('div');
  actionsWrap.className = 'hud-actions';

  const stopBtn = document.createElement('button');
  stopBtn.className = 'hud-action-btn hud-stop-btn';
  stopBtn.id = 'hud-stop-btn';
  stopBtn.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="5" width="14" height="14" rx="3.5" />
    </svg>
  `;

  const openBtn = document.createElement('button');
  openBtn.className = 'hud-action-btn hud-open-btn';
  openBtn.id = 'hud-open-btn';
  openBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  `;

  actionsWrap.appendChild(stopBtn);
  actionsWrap.appendChild(openBtn);

  pill.appendChild(shieldIcon);
  pill.appendChild(info);
  pill.appendChild(actionsWrap);
  hud.appendChild(pill);

  const style = document.createElement('style');
  style.textContent = `
    #privapilot-floating-hud {
      position: fixed;
      bottom: 22px;
      right: 22px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
      pointer-events: auto;
      user-select: none;
      -webkit-font-smoothing: antialiased;
    }
    .hud-pill {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      background: rgba(14, 14, 18, 0.90);
      border: 1px solid rgba(255, 255, 255, 0.10);
      border-radius: 9999px;
      padding: 6px 10px 6px 12px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55), 0 0 1px rgba(255, 255, 255, 0.2);
      backdrop-filter: blur(24px) saturate(180%);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      color: rgba(255, 255, 255, 0.92);
      cursor: pointer;
      transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .hud-pill:hover {
      background: rgba(20, 20, 25, 0.94);
      border-color: rgba(255, 255, 255, 0.20);
      box-shadow: 0 14px 38px rgba(0, 0, 0, 0.65), 0 0 1px rgba(255, 255, 255, 0.3);
      transform: translateY(-1px);
    }
    .hud-icon-wrap {
      display: flex;
      align-items: center;
      justify-content: center;
      color: rgba(255, 255, 255, 0.92);
      flex-shrink: 0;
    }
    .hud-soft-svg {
      display: block;
      transition: transform 0.2s ease;
    }
    .hud-pill:hover .hud-soft-svg {
      transform: scale(1.06);
    }
    .hud-info {
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
    }
    .hud-title-row {
      display: flex;
      align-items: center;
      gap: 6px;
      line-height: 1.2;
    }
    .hud-badge-title {
      font-size: 11.5px;
      font-weight: 550;
      color: rgba(255, 255, 255, 0.92);
      letter-spacing: -0.15px;
    }
    .hud-dot {
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.3);
    }
    .hud-metric {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.45);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      font-weight: 450;
    }
    .hud-status-text {
      font-size: 10.5px;
      color: rgba(255, 255, 255, 0.52);
      font-weight: 400;
      max-width: 175px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.25;
    }
    .hud-actions {
      display: flex;
      align-items: center;
      gap: 2px;
      margin-left: 2px;
    }
    /* Soft drawing action buttons without boxes */
    .hud-action-btn {
      background: transparent;
      border: none;
      outline: none;
      color: rgba(255, 255, 255, 0.5);
      width: 26px;
      height: 26px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
      transition: all 0.18s ease;
      flex-shrink: 0;
    }
    .hud-action-btn:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.08);
      transform: scale(1.05);
    }
    .hud-action-btn:active {
      transform: scale(0.95);
    }
    .hud-stop-btn {
      display: none;
    }
    .hud-stop-btn.active {
      display: flex;
    }
    .hud-stop-btn:hover {
      color: #ff5555;
      background: rgba(255, 85, 85, 0.12);
    }
  `;

  function initHud() {
    if (!document.body || document.getElementById('privapilot-floating-hud')) return;
    document.head.appendChild(style);
    document.body.appendChild(hud);

    // Clicking pill or open button opens the Click sidepanel
    pill.addEventListener('click', (e) => {
      if (e.target && (e.target.id === 'hud-stop-btn' || e.target.closest('#hud-stop-btn'))) {
        return; // Handled by stop button
      }
      chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' }).catch(() => {});
    });

    if (stopBtn) {
      stopBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'STOP_TASK' }).catch(() => {});
        if (statusText) statusText.textContent = 'Stopped';
        stopBtn.classList.remove('active');
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHud);
  } else {
    initHud();
  }

  // Message listener from background script to update HUD
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'UPDATE_HUD') {
      const statusEl = document.getElementById('hud-status-text');
      const latencyEl = document.getElementById('hud-latency');
      const stopBtnEl = document.getElementById('hud-stop-btn');
      if (statusEl && message.status) statusEl.textContent = message.status;
      if (latencyEl && message.latency) latencyEl.textContent = `${message.latency}ms`;
      if (stopBtnEl) {
        if (message.status && (message.status.includes('Step') || message.status.includes('Thinking') || message.status.includes('Action'))) {
          stopBtnEl.classList.add('active');
        } else if (message.status && (message.status.includes('Stopped') || message.status.includes('Completed') || message.status.includes('Ready'))) {
          stopBtnEl.classList.remove('active');
        }
      }
    } else if (message.type === 'TASK_STARTED') {
      const stopBtnEl = document.getElementById('hud-stop-btn');
      const statusEl = document.getElementById('hud-status-text');
      if (stopBtnEl) stopBtnEl.classList.add('active');
      if (statusEl) statusEl.textContent = 'Running task...';
    } else if (message.type === 'TASK_STOPPED' || message.type === 'TASK_FINISHED') {
      const stopBtnEl = document.getElementById('hud-stop-btn');
      const statusEl = document.getElementById('hud-status-text');
      if (stopBtnEl) stopBtnEl.classList.remove('active');
      if (statusEl) statusEl.textContent = message.type === 'TASK_FINISHED' ? 'Completed' : 'Ready for command';
    }
  });

  // ── SERVICE WORKER KEEPALIVE PORT ──────────────────────────────────────
  function maintainKeepAlive() {
    try {
      if (!window.chrome || !chrome.runtime || !chrome.runtime.id) return;
      const port = chrome.runtime.connect({ name: 'privapilot-keepalive' });
      
      const pingTimer = setInterval(() => {
        try {
          if (!chrome.runtime || !chrome.runtime.id) {
            clearInterval(pingTimer);
            return;
          }
          port.postMessage({ type: 'ping', t: Date.now() });
        } catch (e) {
          clearInterval(pingTimer);
        }
      }, 20000);

      port.onDisconnect.addListener(() => {
        const _ = chrome.runtime.lastError;
        clearInterval(pingTimer);
        if (chrome.runtime && chrome.runtime.id) {
          setTimeout(maintainKeepAlive, 3000);
        }
      });
    } catch (e) {}
  }
  maintainKeepAlive();

})();
