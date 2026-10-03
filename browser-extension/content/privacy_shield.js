/**
 * PrivaPilot — Client-Side Privacy Shield Engine (SIH26171) v3.0
 *
 * Layer 1 of the 3-layer privacy pipeline.
 * Runs locally inside the user's browser (content script context).
 * Dynamically detects sensitive / PII elements using DOM semantics + regex.
 *
 * Canvas redaction has been moved to the chrome.offscreen ML engine (v3.0)
 * which handles StackBlur for faces and merged region redaction.
 *
 * Known limitation (stated honestly):
 * Heuristic name detection cannot reliably identify arbitrary person names
 * without a trained NER classifier. Regex catches names only when preceded
 * by contextual labels like "Name:", "Applicant:", etc.
 */

// Hoisted RegExp for unlabeled Indian name detection to avoid per-node heap allocations
const EMBEDDED_NAME_PATTERN = /\b([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+){1,2})\b/g;

window.PrivaShield = (function() {
  'use strict';

  // ── PII REGEX PATTERNS — Use PIIEngine if available (shared pii_rules.js) ──
  const PATTERNS = (typeof PIIEngine !== 'undefined' && PIIEngine.PATTERNS) ? PIIEngine.PATTERNS : {
    aadhaar: /\b[2-9]\d{3}[\s-]?[0-9]{4}[\s-]?[0-9]{4}\b/g,
    panCard: /\b[A-Z]{3}[PCHFATBLJG][A-Z][0-9]{4}[A-Z]\b/g,
    creditCard: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11})\b/g,
    email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    phone: /\b(?:\+91[\-\s]?)?[6-9]\d{9}\b/g,
    token: /(?:eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}|(?:sk|nvapi|ghp|pk)[-_][a-zA-Z0-9_-]{15,})/g,
    passport: /\b[A-PR-WYa-pr-wy][1-9]\d{6,7}\b/g,
    ifsc: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    drivingLicense: /\b[A-Z]{2}[-\s]?[0-9]{2}[-\s]?(?:19|20)\d{2}[-\s]?[0-9]{7}\b/g,
    voterId: /\b[A-Z]{3}[0-9]{7}\b/g,
    upiVpa: /\b[a-zA-Z0-9.\-_]{2,64}@(okaxis|okhdfcbank|okicici|oksbi|paytm|ybl|ibl|upi|apl|axl|federal|kotak|postbank|icici|hdfcbank|sbi)\b/gi,
    aadhaarMasked: /\b(?:[X\*\.]{4}[\s-]?){2}\d{4}\b/g,
    panMasked: /\b(?:[A-Z]{5}[X\*]{4}[A-Z]|[X\*]{5}[0-9]{4}[A-Z])\b/g,
    dob: /\b(?:DOB|D\.O\.B|Date of Birth)[\s:]+(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})\b/gi,
  };

  // ── Contextual heuristic patterns — use PIIEngine if available ───────────
  const ADDRESS_KEYWORDS = (typeof PIIEngine !== 'undefined' && PIIEngine.ADDRESS_KEYWORDS) ? PIIEngine.ADDRESS_KEYWORDS :
    /\b(road|street|nagar|colony|sector|block|lane|gali|mohalla|marg|avenue|plot|flat|floor|apartment|apartments|house|delhi|mumbai|bangalore|bengaluru|jaipur|kanpur|up|karnataka|नगर|मार्ग|सड़क)\b/i;
  const ADDRESS_CONTEXT = (typeof PIIEngine !== 'undefined' && PIIEngine.ADDRESS_CONTEXT) ? PIIEngine.ADDRESS_CONTEXT :
    /(?:delivery|residential|shipping|permanent|office)?\s*address|पता|निवास/i;
  const NAME_CONTEXT = (typeof PIIEngine !== 'undefined' && PIIEngine.NAME_CONTEXT) ? PIIEngine.NAME_CONTEXT :
    /\b(name|applicant|father'?s?\s*name|mother'?s?\s*name|spouse|guardian|nominee|beneficiary|account\s*holder|customer|patient|student|employee|passenger|candidate|आवेदक|नाम|पिता)\s*[:\-]?\s*/i;

  /**
   * Luhn Algorithm check for valid credit cards to prevent false alarms.
   */
  function isValidCreditCard(str) {
    if (typeof PIIEngine !== 'undefined') return PIIEngine.validateLuhn(str);
    const cleaned = str.replace(/[\s-]/g, '');
    if (!/^\d{13,19}$/.test(cleaned)) return false;
    let sum = 0, alt = false;
    for (let i = cleaned.length - 1; i >= 0; i--) {
      let n = parseInt(cleaned.charAt(i), 10);
      if (alt) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  /**
   * Verhoeff checksum for Aadhaar — delegates to PIIEngine if available.
   */
  function isValidAadhaar(str) {
    if (typeof PIIEngine !== 'undefined') return PIIEngine.validateVerhoeff(str);
    return true; // No inline Verhoeff fallback — accept conservatively
  }

  // Multi-rect match extraction: returns individual per-line rects to avoid
  // over-redacting neighboring text when a match spans wrapped lines.
  function getMatchRangeRects(textNode, startIdx, endIdx, dpr = 1) {
    try {
      const len = textNode.length || 0;
      const s = Math.max(0, Math.min(len, startIdx));
      const e = Math.max(s, Math.min(len, endIdx));
      if (s === e) return [];

      const range = document.createRange();
      range.setStart(textNode, s);
      range.setEnd(textNode, e);
      const rects = range.getClientRects();

      if (rects.length === 0) {
        const b = range.getBoundingClientRect();
        if (b && b.width > 0 && b.height > 0) {
          return [{
            x: Math.round(b.left * dpr),
            y: Math.round(b.top * dpr),
            width: Math.round(b.width * dpr),
            height: Math.round(b.height * dpr)
          }];
        }
        return []; // Drop the textNode.parentElement fallback to prevent redacting large enclosing wrappers
      }

      // Return individual bounding boxes per wrapped line fragment
      const results = [];
      for (const r of rects) {
        if (r.width <= 0 || r.height <= 0) continue;
        results.push({
          x: Math.round(r.left * dpr),
          y: Math.round(r.top * dpr),
          width: Math.round(r.width * dpr),
          height: Math.round(r.height * dpr)
        });
      }
      return results;
    } catch {
      return [];
    }
  }

  // Legacy single-rect wrapper for backward compatibility
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

  /**
   * Layer 1: DOM Semantic Analysis & Bounding Rect Extraction
   */
  function detectSensitiveRegions() {
    const regions = [];
    const dpr = window.devicePixelRatio || 1;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    function addRegion(rect, type, rawValue = '') {
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      regions.push({
        type: type,
        x: Math.round(rect.left * dpr),
        y: Math.round(rect.top * dpr),
        width: Math.round(rect.width * dpr),
        height: Math.round(rect.height * dpr),
        valueLength: rawValue ? rawValue.length : 0
      });
    }

    // 1. Password Inputs
    document.querySelectorAll('input[type="password"], input[name*="password" i], input[id*="password" i], input[autocomplete*="password" i], input[id*="cvv" i], input[name*="cvv" i]').forEach(el => {
      addRegion(el.getBoundingClientRect(), 'password', el.value);
    });

    // 2. Credit Card Inputs
    document.querySelectorAll('input[autocomplete="cc-number"], input[name*="card" i], input[id*="card" i], input[placeholder*="XXXX" i]').forEach(el => {
      addRegion(el.getBoundingClientRect(), 'creditCard', el.value);
    });

    // 3. Email Inputs
    document.querySelectorAll('input[type="email"], input[autocomplete="email"], input[name*="email" i], input[id*="email" i]').forEach(el => {
      addRegion(el.getBoundingClientRect(), 'email', el.value);
    });

    // 4. Phone Inputs
    document.querySelectorAll('input[type="tel"], input[autocomplete="tel"], input[name*="phone" i], input[id*="phone" i], input[name*="mobile" i]').forEach(el => {
      addRegion(el.getBoundingClientRect(), 'phone', el.value);
    });

    // 5. Sensitive Indian KYC Inputs (Aadhaar & PAN inputs)
    document.querySelectorAll('input[name*="aadhaar" i], input[id*="aadhaar" i], input[name*="pan" i], input[id*="pan" i]').forEach(el => {
      const isPan = /pan/i.test(el.name + el.id);
      addRegion(el.getBoundingClientRect(), isPan ? 'panCard' : 'aadhaar', el.value);
    });

    // 5b. Name Inputs (catches "Rohit Sharma" in name fields)
    document.querySelectorAll('input[name*="name" i], input[id*="name" i], input[placeholder*="name" i], input[autocomplete*="name" i], input[aria-label*="name" i]').forEach(el => {
      if (el.type === 'password' || el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return;
      if (el.value && el.value.trim().length > 1) {
        addRegion(el.getBoundingClientRect(), 'name', el.value);
      }
    });

    // 5c. Scan visible input values for PII with Verhoeff & Luhn checksum gating
    document.querySelectorAll('input:not([type="password"]):not([type="hidden"]), textarea').forEach(el => {
      const val = el.value || '';
      if (val.trim().length < 4) return;
      for (const [type, pattern] of Object.entries(PATTERNS)) {
        pattern.lastIndex = 0;
        if (pattern.test(val)) {
          if (type === 'bankAccount' && !/bank|account|a\/c/i.test(val)) continue;
          if (type === 'creditCard' && !isValidCreditCard(val)) continue;
          if (type === 'aadhaar' && !isValidAadhaar(val)) continue;
          addRegion(el.getBoundingClientRect(), type.replace('Masked', ''), val);
          break;
        }
      }
    });

    // 5d. Name elements in DOM (e.g. <div class="name">Arjun Mehta</div>, .profile-name, .id-value)
    document.querySelectorAll('[class*="name" i]:not(input):not(form):not(html):not(body), .author, .user-name, .username, .profile-name, .account-holder, .profile-info .name, .scanned-id .id-value').forEach(el => {
      if (el.closest && el.closest('.ground-truth, .metrics-strip')) return;
      // Filter out common non-person-name classes
      const classStr = (el.className || '').toString().toLowerCase();
      if (/(?:^|[\s_-])(product|item|file|filename|tag|brand|app|domain|service|code|class|icon|method|var|field|tool|menu|step|key|rule|status|title)(?:[\s_-]|$)/.test(classStr)) {
        return;
      }

      const txt = (el.innerText || el.textContent || '').trim();
      if (txt.length >= 2 && txt.length <= 40) {
        const isName = (!/^[A-Z\s]+$/.test(txt) && /^[A-Z][a-zA-Z'\-]+(\s+[A-Za-z][a-zA-Z'\-]+){1,3}$/.test(txt)) ||
                       /^[\u0900-\u097F\s]{3,}$/.test(txt);
        const isUIPhrase = /^(new chat|search chats|privacy shield|recent|notebooks|students|images|videos|library|settings|pro|free|help|faq|home|menu|profile|account|sign out|log in)$/i.test(txt);
        const isHeader = /^(full\s*)?name|first\s*name|last\s*name$/i.test(txt);

        if (isName && !isHeader && !isUIPhrase) {
          const prev = el.previousElementSibling;
          const prevTxt = prev ? prev.textContent.toLowerCase() : '';
          if (prevTxt.includes('pan') || prevTxt.includes('aadhaar') || prevTxt.includes('address') || prevTxt.includes('dob')) return;
          addRegion(el.getBoundingClientRect(), 'name', txt);
        }
      }
    });

    // 5e. Scanned ID card field key-value pairs
    document.querySelectorAll('.id-field, .field, [class*="id-field"]').forEach(field => {
      if (field.closest && field.closest('.ground-truth, .metrics-strip')) return;
      const label = field.querySelector('.id-label, .label, [class*="label"]');
      const val = field.querySelector('.id-value, .value, [class*="value"]');
      if (!label || !val) return;
      const lTxt = label.textContent.toLowerCase();
      const vRect = val.getBoundingClientRect();
      if (lTxt.includes('name') || lTxt.includes('father') || lTxt.includes('applicant')) {
        addRegion(vRect, 'name', val.textContent);
      } else if (lTxt.includes('address') || lTxt.includes('पता')) {
        addRegion(vRect, 'address', val.textContent);
      } else if (lTxt.includes('aadhaar') || lTxt.includes('uid')) {
        addRegion(vRect, 'aadhaar', val.textContent);
      } else if (lTxt.includes('pan')) {
        addRegion(vRect, 'panCard', val.textContent);
      }
    });

    // 6. Text Nodes Inspection (character-precise Range bounds)
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          if (!node.textContent || node.textContent.trim().length < 4) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName.toLowerCase();
          if (['script', 'style', 'noscript', 'canvas'].includes(tag)) return NodeFilter.FILTER_REJECT;
          if (parent.closest && parent.closest('.ground-truth, .metrics-strip')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let currentNode;
    while ((currentNode = walker.nextNode())) {
      const text = currentNode.textContent;
      const parent = currentNode.parentElement;
      if (!parent) continue;

      const parentText = parent.textContent || '';
      const prevSiblingText = parent.previousElementSibling ? parent.previousElementSibling.textContent : '';
      const prevNodeText = currentNode.previousSibling ? currentNode.previousSibling.textContent : '';
      const grandparentText = (parent.parentElement ? parent.parentElement.textContent : parentText) || '';
      const contextText = `${prevSiblingText} ${prevNodeText} ${parentText} ${grandparentText}`.slice(0, 300);

      // Standard PII patterns with character-level Range bounds
      for (const [type, pattern] of Object.entries(PATTERNS)) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(text)) !== null) {
          if (type === 'passport' && !/passport|travel/i.test(contextText)) continue;
          if (type === 'ifsc' && !/ifsc|bank|branch|code|transfer|neft|rtgs|imps|account|a\/c/i.test(contextText)) continue;
          if (type === 'bankAccount' && !/bank|account|a\/c|saving|current/i.test(contextText)) continue;
          if (type === 'creditCard' && !isValidCreditCard(m[0])) continue;
          if (type === 'aadhaar' && !isValidAadhaar(m[0])) continue;
          if (type === 'voterId' && !/voter|epic|election|electoral/i.test(contextText)) continue;
          if (type === 'drivingLicense' && !/driving|license|licence|dl|rto/i.test(contextText)) continue;

          // DOB label preservation: redact only the captured date, preserve "DOB:" label for VLM
          let startPos = m.index;
          let matchLen = m[0].length;
          if (type === 'dob' && m[1]) {
            const dateOffset = m[0].lastIndexOf(m[1]);
            startPos = m.index + dateOffset;
            matchLen = m[1].length;
          }

          // Multi-rect extraction: each wrapped line gets its own bounding box
          const rects = getMatchRangeRects(currentNode, startPos, startPos + matchLen, dpr);
          for (const box of rects) {
            regions.push({ ...box, type: type === 'panMasked' ? 'panCard' : type.replace('Masked', ''), valueLength: matchLen });
          }
        }
      }

      // Contextual address detection
      const isAddressCtx = ADDRESS_CONTEXT.test(contextText);
      const hasPinCode = /\b[1-9][0-9]{5}\b/.test(text);
      const hasAddressKeywords = ADDRESS_KEYWORDS.test(text) || ADDRESS_KEYWORDS.test(contextText);
      const trimmed = text.trim();
      const hasStructuredAddress = /(?:flat|house|plot|door|room|suite|sector|block)\s*#?\s*\d+.*(?:road|street|nagar|marg|lane|avenue|colony)/i.test(trimmed) ||
                                   /(?:road|street|nagar|colony|marg|avenue|sector)\s*,?\s*(?:delhi|mumbai|bangalore|bengaluru|jaipur|kanpur|pune|hyderabad|chennai|kolkata|lucknow)/i.test(trimmed);

      if ((isAddressCtx && trimmed.length > 8) || (hasPinCode && hasAddressKeywords) || hasStructuredAddress) {
        addRegion(getNodeRect(currentNode), 'address', text);
      }

      // Contextual name detection
      const isNameCtx = NAME_CONTEXT.test(contextText);
      const isNameFormat = (!/^[A-Z\s]+$/.test(trimmed) && /^[A-Z][a-zA-Z'\-]+(\s+[A-Za-z][a-zA-Z'\-]+){1,3}$/.test(trimmed)) ||
                           /^[\u0900-\u097F\s]{3,}$/.test(trimmed);

      if (isNameCtx && isNameFormat && !NAME_CONTEXT.test(trimmed)) {
        addRegion(getNodeRect(currentNode), 'name', text);
      } else if (NAME_CONTEXT.test(trimmed)) {
        const nmMatch = trimmed.match(NAME_CONTEXT);
        if (nmMatch && nmMatch.index !== undefined) {
          const afterIdx = nmMatch.index + nmMatch[0].length;
          const afterTxt = trimmed.slice(afterIdx).trim();
          if (afterTxt.length > 1) {
            const matchStart = text.indexOf(afterTxt, afterIdx);
            if (matchStart !== -1) {
              addRegion(getMatchRangeRect(currentNode, matchStart, matchStart + afterTxt.length), 'name', afterTxt);
            }
          }
        }
      }

      // Greeting / User Profile Name Detection (e.g. "What's the vibe, Harsh chaudhary?")
      const GREETING_NAME_RE = /(?:what'?s\s+(?:the\s+)?vibe|welcome(?:\s+back)?|hello|hi|hey|good\s+(?:morning|afternoon|evening)|logged\s+in\s+as|signed\s+in\s+as|user)\s*[,:\-]\s*([A-Z][a-zA-Z'\-]+(?:\s+[A-Za-z][a-zA-Z'\-]+){1,3})/i;
      const greetMatch = trimmed.match(GREETING_NAME_RE);
      if (greetMatch && greetMatch[1]) {
        const namePart = greetMatch[1].trim();
        const nIdx = text.indexOf(namePart);
        if (nIdx !== -1) {
          const rects = getMatchRangeRects(currentNode, nIdx, nIdx + namePart.length, dpr);
          for (const box of rects) {
            regions.push({ ...box, type: 'name', valueLength: namePart.length });
          }
        }
      }

      // Honorific & Kinship Anchoring for arbitrary names (Mr. Rajesh, S/O Ramesh, etc.)
      if (typeof PIIEngine !== 'undefined') {
        let hMatch;
        PIIEngine.HONORIFIC_PREFIXES.lastIndex = 0;
        while ((hMatch = PIIEngine.HONORIFIC_PREFIXES.exec(text)) !== null) {
          const nameStr = hMatch[1];
          const nStart = hMatch.index + (hMatch[0].length - nameStr.length);
          const rects = getMatchRangeRects(currentNode, nStart, nStart + nameStr.length, dpr);
          for (const box of rects) {
            regions.push({ ...box, type: 'name', valueLength: nameStr.length });
          }
        }

        PIIEngine.KINSHIP_ANCHORS.lastIndex = 0;
        while ((hMatch = PIIEngine.KINSHIP_ANCHORS.exec(text)) !== null) {
          const nameStr = hMatch[1];
          const nStart = hMatch.index + (hMatch[0].length - nameStr.length);
          const rects = getMatchRangeRects(currentNode, nStart, nStart + nameStr.length, dpr);
          for (const box of rects) {
            regions.push({ ...box, type: 'name', valueLength: nameStr.length });
          }
        }

        // Unlabeled Indian Surname Lookup (e.g. "Rajesh Sharma" without any label)
        // Works both on isolated elements AND embedded in prose sentences
        // Use hoisted RegExp with manual index reset
        EMBEDDED_NAME_PATTERN.lastIndex = 0;
        let nameCandidate;
        while ((nameCandidate = EMBEDDED_NAME_PATTERN.exec(text)) !== null) {
          const candidateStr = nameCandidate[1];
          if (PIIEngine.isLikelyPersonName(candidateStr)) {
            const rects = getMatchRangeRects(currentNode, nameCandidate.index, nameCandidate.index + candidateStr.length, dpr);
            for (const box of rects) {
              regions.push({ ...box, type: 'name', valueLength: candidateStr.length });
            }
          }
        }
      }
    }

    // Semantic Table Column Scan (detects arbitrary person names inside tabular KYC layouts)
    document.querySelectorAll('table').forEach(table => {
      const headers = Array.from(table.querySelectorAll('th'));
      let nameColIdx = -1;
      headers.forEach((th, idx) => {
        if (/\b(name|applicant|candidate|beneficiary|passenger|employee|customer)\b/i.test(th.innerText || '')) {
          nameColIdx = idx;
        }
      });

      if (nameColIdx !== -1) {
        const rows = table.querySelectorAll('tbody tr, tr');
        rows.forEach(row => {
          const cells = row.querySelectorAll('td');
          if (cells[nameColIdx]) {
            const cell = cells[nameColIdx];
            const text = (cell.innerText || '').trim();
            if (text.length > 2 && text.length < 50 && !/^(name|applicant)$/i.test(text)) {
              const r = cell.getBoundingClientRect();
              regions.push({
                type: 'name',
                x: Math.round(r.left * dpr),
                y: Math.round(r.top * dpr),
                width: Math.round(r.width * dpr),
                height: Math.round(r.height * dpr),
                valueLength: text.length
              });
            }
          }
        });
      }
    });

    // 7. Visual Avatars & Face Images (Strict visual elements only — NEVER match layout containers/sidebars/chat windows!)
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
        if (textLen > 25) return;
      }

      // Strict physical dimensions for human/user avatars (16px to 260px)
      const w = rect.width;
      const h = rect.height;
      if (w < 16 || h < 16 || w > 260 || h > 260) return;

      const aspect = w / h;
      if (aspect < 0.4 || aspect > 2.5) return;

      const area = w * h;
      if (area > (vw * vh * 0.08) || area > 65000) return;

      addRegion(rect, 'face');
    });

    return regions;
  }

  /**
   * Sanitized Interactive DOM Snapshot
   * Extracts interactive elements with unique IDs for precise tool calling,
   * while wiping any personal values from the snapshot.
   */
  function extractSanitizedInteractiveTree() {
    const interactive = [];
    const elements = document.querySelectorAll(
      'button, a, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="searchbox"], [role="combobox"], [onclick], [tabindex]:not([tabindex="-1"])'
    );
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Persist counter on window across all execution passes
    if (!window.__privaIdCounter) window.__privaIdCounter = 1;

    elements.forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || el.offsetParent === null) return;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

      const inViewport = (rect.top < vh && rect.bottom > 0 && rect.left < vw && rect.right > 0);
      const tag = el.tagName.toLowerCase();

      // Verify existing ID uniqueness; re-stamp if missing or duplicated by dynamic DOM updates
      let privaId = el.getAttribute('data-priva-id');
      if (!privaId || !/^p-\d+$/.test(privaId) || document.querySelectorAll(`[data-priva-id="${privaId}"]`).length > 1) {
        privaId = `p-${window.__privaIdCounter++}`;
        el.setAttribute('data-priva-id', privaId);
      } else {
        const num = parseInt(privaId.replace('p-', ''), 10);
        if (!isNaN(num) && num >= window.__privaIdCounter) {
          window.__privaIdCounter = num + 1;
        }
      }

      const isPassword = el.type === 'password';
      const isSensitive = /password|cvv|card|aadhaar|pan|ssn|secret|token/i.test(
        (el.name || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('autocomplete') || '')
      );

      let cleanText = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      let cleanVal = el.value || '';

      if (isPassword || isSensitive) {
        cleanVal = '[REDACTED: SENSITIVE]';
        cleanText = '[REDACTED: SENSITIVE]';
      }

      interactive.push({
        privaId: privaId,
        tag: tag,
        id: el.id || null,
        type: el.type || null,
        name: el.name || null,
        selector: el.id ? `#${el.id}` : `[data-priva-id="${privaId}"]`,
        text: cleanText.slice(0, 80),
        value: cleanVal.slice(0, 60),
        is_redacted: isPassword || isSensitive,
        in_viewport: inViewport,
        rect: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
    });

    interactive.sort((a, b) => {
      if (a.in_viewport && !b.in_viewport) return -1;
      if (!a.in_viewport && b.in_viewport) return 1;
      return a.rect.y - b.rect.y;
    });

    return interactive;
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    detectSensitiveRegions: detectSensitiveRegions,
    extractSanitizedInteractiveTree: extractSanitizedInteractiveTree
  };

})();

// ── Chrome Runtime Message Listener ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'EXECUTE_PRIVACY_SHIELD') {
    // v4.0: Returns full DOM scan result matching the shape background.js expects.
    // Canvas redaction is handled by the offscreen ML engine.
    const startTime = performance.now();
    const dpr = window.devicePixelRatio || 1;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const sensitiveRegions = window.PrivaShield.detectSensitiveRegions();
    const domElements = window.PrivaShield.extractSanitizedInteractiveTree();
    const logs = window.ActionExecutor ? window.ActionExecutor.getConsoleLogs() : [];

    // OCR target detection (canvases + scanned KYC document images)
    const ocrTargets = [];
    document.querySelectorAll('canvas').forEach(cv => {
      const r = cv.getBoundingClientRect();
      if (r.width > 120 && r.height > 120) {
        ocrTargets.push({
          x: Math.round(r.left * dpr), y: Math.round(r.top * dpr),
          width: Math.round(r.width * dpr), height: Math.round(r.height * dpr),
        });
      }
    });
    document.querySelectorAll('img[class*="aadhaar" i], img[class*="pancard" i], img[class*="passport" i], img[class*="kyc-doc" i], img[id*="aadhaar" i], img[id*="pancard" i], img[src*="aadhaar" i], img[src*="pan" i], [class*="scanned-id"] img').forEach(img => {
      const r = img.getBoundingClientRect();
      if (r.width > 80 && r.height > 80) {
        ocrTargets.push({
          x: Math.round(r.left * dpr), y: Math.round(r.top * dpr),
          width: Math.round(r.width * dpr), height: Math.round(r.height * dpr),
        });
      }
    });

    const bodyTextLen = (document.body ? (document.body.innerText || document.body.textContent || '') : '').trim().length;
    const isTextSparse = bodyTextLen < 40;
    const requireOcr = (ocrTargets.length > 0 || isTextSparse) && (ocrTargets.length <= 4);

    const endTime = performance.now();

    sendResponse({
      domRegions: sensitiveRegions,
      domElements: domElements,
      consoleLogs: logs,
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
      telemetry: {
        entitiesDetected: sensitiveRegions.length,
        categoriesMasked: Array.from(new Set(sensitiveRegions.map(r => r.type))),
      }
    });
    return false; // Synchronous response
  }

  if (request.type === 'EXECUTE_TOOL') {
    if (window.ActionExecutor) {
      window.ActionExecutor.dispatchAction(request.tool, request.args)
        .then(result => {
          sendResponse(result);
        })
        .catch(err => {
          sendResponse({ success: false, error: String(err) });
        });
      return true; // Async response
    } else {
      sendResponse({ success: false, error: 'ActionExecutor not loaded' });
    }
  }
});

console.log('🛡️ [PrivaPilot] Privacy Shield v3.0 initialized (SIH26171 — DOM Layer + ML Offscreen)');
