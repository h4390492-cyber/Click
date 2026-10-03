/**
 * PrivaPilot — Browser Action Executor (SIH26171)
 *
 * Dispatches precise browser interactions (click, type, scroll, navigate, etc.)
 * directly into the target webpage, providing rich visual feedback (ripple indicator)
 * and full compatibility with reactive UI frameworks (React, Vue, Angular).
 */

window.ActionExecutor = (function() {
  'use strict';

  // Intercept and buffer console logs for get_console_logs tool
  const consoleBuffer = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origErr = console.error;

  console.log = function(...args) {
    consoleBuffer.push(`[LOG] ${args.join(' ')}`);
    if (consoleBuffer.length > 50) consoleBuffer.shift();
    origLog.apply(console, args);
  };
  console.warn = function(...args) {
    consoleBuffer.push(`[WARN] ${args.join(' ')}`);
    if (consoleBuffer.length > 50) consoleBuffer.shift();
    origWarn.apply(console, args);
  };
  console.error = function(...args) {
    consoleBuffer.push(`[ERROR] ${args.join(' ')}`);
    if (consoleBuffer.length > 50) consoleBuffer.shift();
    origErr.apply(console, args);
  };

  /**
   * Shows a visual ripple effect at (x, y) so judges see agent actions.
   */
  function showVisualRipple(x, y, label = 'CLICK') {
    const ripple = document.createElement('div');
    ripple.style.cssText = `
      position: fixed;
      left: ${x - 20}px;
      top: ${y - 20}px;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: rgba(56, 189, 248, 0.4);
      border: 2px solid #38bdf8;
      box-shadow: 0 0 15px #38bdf8;
      pointer-events: none;
      z-index: 999999;
      transform: scale(0.5);
      animation: privaRipple 0.6s cubic-bezier(0, 0, 0.2, 1) forwards;
    `;

    if (!document.getElementById('priva-style-anim')) {
      const s = document.createElement('style');
      s.id = 'priva-style-anim';
      s.textContent = `
        @keyframes privaRipple {
          0% { transform: scale(0.4); opacity: 1; }
          100% { transform: scale(2.2); opacity: 0; }
        }
      `;
      document.head.appendChild(s);
    }

    document.body.appendChild(ripple);
    setTimeout(() => ripple.remove(), 650);
  }

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

    if (x >= 0 && x <= 1.0 && y >= 0 && y <= 1.0 && (x > 0 || y > 0)) {
      x = x * vw;
      y = y * vh;
    } else if (dpr > 1 && (x > vw || y > vh) && (x / dpr <= vw + 10 && y / dpr <= vh + 10)) {
      x = x / dpr;
      y = y / dpr;
    } else if ((x > vw || y > vh) && x <= 1000 && y <= 1000) {
      x = (x / 1000) * vw;
      y = (y / 1000) * vh;
    }

    x = Math.max(0, Math.min(vw - 1, x));
    y = Math.max(0, Math.min(vh - 1, y));
    return [Math.round(x), Math.round(y)];
  }

  /**
   * Helper: Find target element by selector, coordinates, or text with viewport scoring.
   */
  function findTarget(args) {
    const resolvedCoords = resolveCoordinates(args.coordinates);

    // 1. Selector match
    if (args.selector) {
      try {
        const el = document.querySelector(args.selector);
        if (el) {
          const rect = el.getBoundingClientRect();
          const cx = resolvedCoords ? resolvedCoords[0] : Math.round(rect.left + rect.width / 2);
          const cy = resolvedCoords ? resolvedCoords[1] : Math.round(rect.top + rect.height / 2);
          return { el, clickX: cx, clickY: cy, fromCoords: false };
        }
      } catch (e) {}
    }

    // 2. Coordinate match
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

    // 3. Text match
    if (args.text) {
      const targetNorm = normalizeStr(args.text);
      if (targetNorm) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;

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

          if (el.childElementCount > 4) continue;

          const rawText = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
          if (rawText.length > Math.max(120, args.text.length * 4)) continue;

          const normText = normalizeStr(rawText);
          if (!normText) continue;

          let matchScore = 0;
          if (normText === targetNorm) {
            matchScore = 1200;
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

          const inViewport = (rect.top < vh && rect.bottom > 0 && rect.left < vw && rect.right > 0);
          if (inViewport) {
            matchScore += 800;
          } else {
            matchScore -= 600;
          }

          const isInteractive = el.matches('button, a, input, [role="button"], [onclick]') || el.closest('button, a, [role="button"]');
          if (isInteractive) matchScore += 300;

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

  // ── TOOL IMPLEMENTATIONS ──────────────────────────────────────────────────

  async function executeClick(args) {
    const target = findTarget(args);
    if (!target || !target.el) {
      return { success: false, error: `Could not find element to click: ${JSON.stringify(args)}` };
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

    if (!isInViewport && !target.fromCoords) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(r => setTimeout(r, 250));
    }

    const finalRect = el.getBoundingClientRect();
    const cx = target.fromCoords ? target.clickX : Math.round(finalRect.left + finalRect.width / 2);
    const cy = target.fromCoords ? target.clickY : Math.round(finalRect.top + finalRect.height / 2);

    showVisualRipple(cx, cy, 'CLICK');

    const targets = [];
    if (target.directTarget) targets.push(target.directTarget);
    if (el && !targets.includes(el)) targets.push(el);

    const innerSubmit = el.querySelector ? el.querySelector('input[type="submit"], input[type="button"], button') : null;
    if (innerSubmit && !targets.includes(innerSubmit)) {
      targets.push(innerSubmit);
    }

    for (const t of targets) {
      const link = t.tagName === 'A' ? t : (t.closest ? t.closest('a') : null);
      if (link && link.getAttribute('target') === '_blank') {
        link.setAttribute('target', '_self');
      }
    }

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

      if (typeof t.click === 'function') {
        try { t.click(); } catch(e) {}
      }
    }

    const parentClickable = el.closest('button, a, input, [role="button"]');
    if (parentClickable && !targets.includes(parentClickable) && typeof parentClickable.click === 'function') {
      try { parentClickable.click(); } catch(e) {}
    }

    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.tagName).trim().replace(/\s+/g, ' ');
    return {
      success: true,
      message: `Clicked ${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} ("${label.slice(0, 35)}") @(${cx},${cy})`,
      tag: el.tagName,
      click_coords: [cx, cy]
    };
  }

  async function executeType(args) {
    const el = resolveElement(args);
    if (!el) {
      return { success: false, error: `Could not find input field to type: ${JSON.stringify(args)}` };
    }

    el.focus();
    const textToType = args.text || '';

    // Clear existing value if requested
    if (args.clear_first) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Realistic typing for framework data binding
    el.value = (args.clear_first ? '' : el.value) + textToType;

    // Dispatch synthetic input event (React/Vue state update)
    const inputEvt = new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      data: textToType,
      inputType: 'insertText'
    });
    el.dispatchEvent(inputEvt);
    el.dispatchEvent(new Event('change', { bubbles: true }));

    // Press Enter key if requested
    if (args.press_enter) {
      const enterEvt = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
      el.dispatchEvent(enterEvt);
      if (el.form) {
        el.form.dispatchEvent(new Event('submit', { bubbles: true }));
      }
    }

    return {
      success: true,
      message: `Typed into ${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`
    };
  }

  async function executeScroll(args) {
    const direction = (args.direction || 'down').toLowerCase();
    const rawAmount = parseInt(args.amount, 10);
    const amount = (!isNaN(rawAmount) && rawAmount > 0) ? rawAmount : 500;
    const dy = direction === 'up' ? -amount : amount;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const coords = resolveCoordinates(args.coordinates);
    const cx = coords ? coords[0] : Math.round(vw / 2);
    const cy = coords ? coords[1] : Math.round(vh / 2);

    showVisualRipple(cx, cy, direction === 'down' ? 'SCROLL ⬇' : 'SCROLL ⬆');

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

    return {
      success: true,
      message: `Scrolled ${direction} by ${amount}px at (${cx},${cy}) on ${scrolledTarget} (moved: ${moved}px)`,
      scroll_coords: [cx, cy]
    };
  }

  async function executeNavigate(args) {
    if (!args.url) return { success: false, error: 'No URL provided' };
    window.location.href = args.url;
    return { success: true, message: `Navigating to ${args.url}` };
  }

  async function executeGetConsoleLogs() {
    return {
      success: true,
      logs: consoleBuffer.slice(-15)
    };
  }

  async function executeExtractContent(args) {
    const el = resolveElement(args) || document.body;
    return {
      success: true,
      content: el.innerText.slice(0, 500)
    };
  }

  async function executePressKey(args) {
    const key = args.key || 'Enter';
    const active = document.activeElement || document.body;
    active.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true }));
    active.dispatchEvent(new KeyboardEvent('keyup', { key: key, bubbles: true }));
    return { success: true, message: `Pressed key: ${key}` };
  }

  async function executeWait(args) {
    const sec = parseFloat(args.seconds) || 1.0;
    await new Promise(r => setTimeout(r, sec * 1000));
    return { success: true, message: `Waited ${sec}s` };
  }

  // ── Dispatcher ────────────────────────────────────────────────────────────

  async function dispatchAction(toolName, args = {}) {
    console.log(`⚡ [PrivaPilot Executor] Executing tool '${toolName}':`, args);

    switch (toolName) {
      case 'click':
        return await executeClick(args);
      case 'type':
        return await executeType(args);
      case 'scroll':
        return await executeScroll(args);
      case 'navigate':
        return await executeNavigate(args);
      case 'get_console_logs':
        return await executeGetConsoleLogs();
      case 'extract_content':
        return await executeExtractContent(args);
      case 'press_key':
        return await executePressKey(args);
      case 'wait':
        return await executeWait(args);
      case 'finish_task':
        return { success: true, finished: true, summary: args.summary || 'Task completed.' };
      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  }

  return {
    dispatchAction: dispatchAction,
    getConsoleLogs: executeGetConsoleLogs
  };

})();

console.log('⚡ [PrivaPilot] Action Executor ready');
