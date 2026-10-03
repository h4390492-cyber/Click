/**
 * PrivaPilot — High-Precision PII Rule Engine & Checksum Validators
 * Universal module: exports to globalThis for Chrome MV3 Content Script & Offscreen contexts.
 *
 * Features:
 *  - Verhoeff checksum validation for Aadhaar (zero false-positive 12-digit IDs)
 *  - Luhn checksum for credit cards
 *  - Expanded PII patterns: DL, Voter ID, UPI VPA, DOB, masked formats
 *  - Case-insensitive regexes for PAN, DL, Voter ID, IFSC (handles OCR/lowercase input)
 *  - Honorific/kinship name anchoring (Mr., S/O, D/O, etc.)
 *  - Indian surname lexicon for unlabeled name classification
 */
'use strict';

(function() {
  const root = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : self);

  // ── 1. MATHEMATICAL CHECKSUMS ──────────────────────────────────────────
  const VERHOEFF_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
  ];

  const VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
  ];

  function validateVerhoeff(str) {
    if (!str || typeof str !== 'string') return false;
    const clean = str.replace(/[\s\-\.]/g, '');
    if (!/^\d{12}$/.test(clean)) return false;
    let c = 0;
    const reversed = clean.split('').reverse().map(Number);
    for (let i = 0; i < reversed.length; i++) {
      c = VERHOEFF_D[c][VERHOEFF_P[i % 8][reversed[i]]];
    }
    return c === 0;
  }

  function validateLuhn(str) {
    if (!str || typeof str !== 'string') return false;
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

  // ── 2. COMPREHENSIVE PII REGEX PATTERNS ────────────────────────────────
  // Case-insensitive (/gi) on PAN, DL, Voter ID, IFSC to handle OCR output & lowercase user input
  const PATTERNS = {
    // 12-digit National ID (first digit 2-9 per UIDAI specifications)
    aadhaar: /\b[2-9]\d{3}[\s-]?[0-9]{4}[\s-]?[0-9]{4}\b/g,
    aadhaarMasked: /\b(?:[X\*\.]{4}[\s-]?){2}\d{4}\b/gi,

    // PAN Card (4th character constitution: P, C, H, F, A, T, B, L, J, G)
    panCard: /\b[A-Z]{3}[PCHFATBLJG][A-Z][0-9]{4}[A-Z]\b/gi,
    panMasked: /\b(?:[A-Z]{5}[X\*]{4}[A-Z]|[X\*]{5}[0-9]{4}[A-Z])\b/gi,

    // Driving License: State code (2) + RTO (2) + Year (4) + 7 digits
    drivingLicense: /\b[A-Z]{2}[-\s]?[0-9]{2}[-\s]?(?:19|20)\d{2}[-\s]?[0-9]{7}\b/gi,

    // Voter ID (EPIC): 3 alphabetic + 7 numeric
    voterId: /\b[A-Z]{3}[0-9]{7}\b/gi,

    // Passport: 1 letter (A-W except Q,X,Z) + 7 or 8 digits
    passport: /\b[A-PR-WYa-pr-wy][1-9]\d{6,7}\b/g,

    // UPI / VPA
    upiVpa: /\b[a-zA-Z0-9.\-_]{2,64}@(okaxis|okhdfcbank|okicici|oksbi|paytm|ybl|ibl|upi|apl|axl|federal|kotak|postbank|icici|hdfcbank|sbi)\b/gi,

    // Credit Cards (Visa, MasterCard, Amex, Discover, JCB)
    creditCard: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11})\b/g,

    // Contact & Financial
    email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    phone: /\b(?:\+91[\-\s]?)?[6-9]\d{9}\b/g,
    ifsc: /\b[A-Z]{4}0[A-Z0-9]{6}\b/gi,
    bankAccount: /\b\d{9,18}\b/g,
    token: /(?:eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}|(?:sk|nvapi|ghp|pk)[-_][a-zA-Z0-9_-]{15,})/g,

    // Date of Birth: captures prefix in m[0], date in m[1] — redact only m[1]
    dob: /\b(?:DOB|D\.O\.B|Date of Birth)[\s:]+(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})\b/gi,
  };

  // ── 3. NAME ANCHORING & LEXICON ────────────────────────────────────────
  const HONORIFIC_PREFIXES = /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof|Shri|Smt|Master|Kumar|Md|Mohd|Adv|Capt|Maj|Col)\.?\s+([A-Z][a-zA-Z'\-]+(?:\s+[A-Za-z][a-zA-Z'\-]+){1,2})\b/g;
  const KINSHIP_ANCHORS = /\b(?:S\/O|D\/O|W\/O|C\/O|Son of|Daughter of|Wife of|Care of|Signed by|Authorized Signatory)[\s:]+([A-Z][a-zA-Z'\-]+(?:\s+[A-Za-z][a-zA-Z'\-]+){1,2})\b/gi;

  const SURNAME_LEXICON = new Set([
    'sharma', 'verma', 'singh', 'kumar', 'gupta', 'patel', 'shah', 'rao', 'reddy',
    'nair', 'khan', 'das', 'banerjee', 'mukherjee', 'joshi', 'iyer', 'mehta', 'chaudhary',
    'bhat', 'mishra', 'pandey', 'yadav', 'saxena', 'agarwal', 'jain', 'chatterjee', 'ghosh',
    'deshmukh', 'kulkarni', 'patil', 'naidu', 'shetty', 'pillai', 'menon', 'hegde',
    'tiwari', 'chauhan', 'rathore', 'thakur', 'dubey', 'shukla', 'trivedi', 'dwivedi',
    'kapoor', 'malhotra', 'arora', 'bhatia', 'chopra', 'bajaj', 'sethi', 'khanna',
    'rajan', 'mohan', 'subramaniam', 'venkatesh', 'krishnan', 'sundaram', 'natarajan'
  ]);

  function isLikelyPersonName(candidate) {
    if (!candidate || typeof candidate !== 'string') return false;
    const tokens = candidate.trim().split(/\s+/);
    if (tokens.length < 2 || tokens.length > 4) return false;
    const lastToken = tokens[tokens.length - 1].toLowerCase().replace(/[^a-z]/g, '');
    return SURNAME_LEXICON.has(lastToken);
  }

  // ── 4. CONTEXTUAL HELPER PATTERNS ──────────────────────────────────────
  const ADDRESS_KEYWORDS = /\b(road|street|nagar|colony|sector|block|lane|gali|mohalla|marg|chowk|circle|avenue|plot|flat|floor|apartment|apartments|house|tower|village|district|tehsil|mandal|city|town|prestige|koramangala|lajpat|delhi|mumbai|bangalore|bengaluru|jaipur|kanpur|up|karnataka|नगर|मार्ग|सड़क)\b/i;
  const ADDRESS_CONTEXT = /(?:delivery|residential|shipping|permanent|office|mailing|correspondence)?\s*address|पता|निवास/i;
  const NAME_CONTEXT = /\b(name|applicant|father'?s?\s*name|mother'?s?\s*name|spouse|guardian|nominee|beneficiary|account\s*holder|customer|patient|student|employee|passenger|candidate|आवेदक|नाम|पिता)\s*[:\-]?\s*/i;

  // ── 5. EXPORT TO GLOBAL SCOPE ──────────────────────────────────────────
  const PIIEngine = {
    PATTERNS,
    validateVerhoeff,
    validateLuhn,
    HONORIFIC_PREFIXES,
    KINSHIP_ANCHORS,
    SURNAME_LEXICON,
    isLikelyPersonName,
    ADDRESS_KEYWORDS,
    ADDRESS_CONTEXT,
    NAME_CONTEXT,
  };

  // Bind to globalThis so MV3 content scripts and offscreen documents can access it
  root.PIIEngine = PIIEngine;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PIIEngine;
  }
})();
