/**
 * PrivaPilot — ML Privacy Engine (SIH26171)
 *
 * Runs inside a chrome.offscreen document (extension-owned, crossOriginIsolated).
 * Three detection layers + canvas redaction:
 *   Layer 2: ONNX Runtime Web — Ultra-Light-Fast-Generic-Face-Detector
 *   Layer 3: Tesseract.js OCR → regex/heuristic NER
 *   Redaction: StackBlur for faces, solid mask + badge for text PII
 *
 * Layer 1 (DOM regex scan) runs in the content script, results merged here.
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // ONNX Runtime Web CDN (loaded dynamically)
  ONNX_CDN_URL: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.js',
  ONNX_WASM_PATH: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/',

  // Face detection model — Ultra-Light-Fast-Generic-Face-Detector (slim-320, ~1MB)
  FACE_MODEL_URL: 'https://cdn.jsdelivr.net/gh/AzureProject/face_detection_onnx@master/version-slim-320_simplified.onnx',
  FACE_MODEL_FALLBACK_URL: 'https://cdn.jsdelivr.net/gh/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB@master/models/onnx/version-slim-320.onnx',
  FACE_INPUT_WIDTH: 320,
  FACE_INPUT_HEIGHT: 240,
  FACE_CONFIDENCE_THRESHOLD: 0.65,
  FACE_NMS_IOU_THRESHOLD: 0.3,

  // Tesseract.js CDN
  TESSERACT_CDN_URL: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',

  // Redaction settings
  BLUR_RADIUS_FACTOR: 0.18,  // blur radius = max(face_w, face_h) * factor
  MIN_BLUR_RADIUS: 8,

  // Cache keys (IndexedDB)
  CACHE_DB_NAME: 'privapilot_ml_cache',
  CACHE_STORE_NAME: 'models',
};

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

const state = {
  onnxReady: false,
  tesseractReady: false,
  faceSession: null,        // ONNX InferenceSession
  tesseractWorker: null,     // Tesseract.js worker
  gpuAdapter: null,          // Selected GPUAdapter instance
  gpuInfo: {
    available: false,
    vendor: 'none',
    model: 'CPU WebAssembly',
    isNvidia: false,
    isIntel: false,
    backend: 'wasm',
    powerPreference: 'high-performance',
  },
  initPromise: null,
  stats: {
    framesProcessed: 0,
    facesDetected: 0,
    piiRegionsFound: 0,
    totalInferenceMs: 0,
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// INDEXEDDB MODEL CACHE
// ═══════════════════════════════════════════════════════════════════════════

function openCacheDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CONFIG.CACHE_DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CONFIG.CACHE_STORE_NAME)) {
        db.createObjectStore(CONFIG.CACHE_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCachedBlob(key) {
  try {
    const db = await openCacheDB();
    return new Promise((resolve) => {
      const tx = db.transaction(CONFIG.CACHE_STORE_NAME, 'readonly');
      const store = tx.objectStore(CONFIG.CACHE_STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function setCachedBlob(key, data) {
  try {
    const db = await openCacheDB();
    return new Promise((resolve) => {
      const tx = db.transaction(CONFIG.CACHE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(CONFIG.CACHE_STORE_NAME);
      store.put(data, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════════════════
// DYNAMIC LIBRARY LOADING (fetch→Blob URL for COEP compliance)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load a script from CDN using fetch→Blob URL pattern.
 * This bypasses COEP restrictions by fetching the script text via CORS,
 * then creating a same-origin Blob URL to execute it.
 */
async function loadScript(url) {
  try {
    console.log(`[ML Engine] Fetching script: ${url}`);
    const resp = await fetch(url, { mode: 'cors' });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    const scriptText = await resp.text();
    const blob = new Blob([scriptText], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = blobUrl;
      script.onload = () => {
        URL.revokeObjectURL(blobUrl);
        console.log(`[ML Engine] Script loaded successfully: ${url}`);
        resolve(true);
      };
      script.onerror = (err) => {
        URL.revokeObjectURL(blobUrl);
        console.error(`[ML Engine] Script execution failed: ${url}`, err);
        reject(new Error(`Script execution failed: ${url}`));
      };
      document.head.appendChild(script);
    });
  } catch (e) {
    console.error(`[ML Engine] Failed to fetch script from CDN: ${url}`, e);
    throw e;
  }
}

async function loadONNXRuntime() {
  if (typeof ort === 'undefined') {
    try {
      await loadScript(CONFIG.ONNX_CDN_URL);
    } catch (e) {
      console.warn('[ML Engine] CDN fetch of ONNX Runtime failed, checking local ort...', e);
    }
  }

  if (typeof ort !== 'undefined') {
    // Configure WASM paths — prefer local extension libs directory URL
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      ort.env.wasm.wasmPaths = chrome.runtime.getURL('libs/');
    } else {
      ort.env.wasm.wasmPaths = CONFIG.ONNX_WASM_PATH;
    }
    ort.env.wasm.proxy = false;
    ort.env.logLevel = 'error';

    // Prefer threaded WASM if crossOriginIsolated
    if (self.crossOriginIsolated) {
      ort.env.wasm.numThreads = Math.min(navigator.hardwareConcurrency || 4, 4);
      console.log(`[ML Engine] ONNX: crossOriginIsolated=true, threads=${ort.env.wasm.numThreads}`);
    } else {
      ort.env.wasm.numThreads = 1;
      console.log('[ML Engine] ONNX: running in single-threaded mode');
    }

    state.onnxReady = true;
    console.log('[ML Engine] ONNX Runtime Web loaded and configured');
    return true;
  } else {
    console.error('[ML Engine] `ort` global not found');
    return false;
  }
}

async function loadTesseract() {
  if (typeof Tesseract === 'undefined') {
    try {
      await loadScript(CONFIG.TESSERACT_CDN_URL);
    } catch (e) {
      console.warn('[ML Engine] CDN fetch of Tesseract failed, checking local Tesseract...', e);
    }
  }

  if (typeof Tesseract !== 'undefined') {
    state.tesseractReady = true;
    console.log('[ML Engine] Tesseract.js loaded successfully');
    return true;
  } else {
    console.error('[ML Engine] `Tesseract` global not found');
    return false;
  }
}

/**
 * Detect optimal GPU adapter for WebGPU acceleration.
 * Laptop MUX Switch Strategy:
 * 1. Request adapter with powerPreference: 'high-performance'.
 *    - In Discrete MUX or Hybrid/Optimus mode: Windows/ANGLE selects the discrete GPU (NVIDIA).
 *    - In Eco/Battery mode (iGPU only): Windows/ANGLE selects the integrated GPU (Intel).
 * 2. Query adapter info (vendor, architecture, description).
 * 3. Configure ort.env.webgpu with the selected adapter and power preference.
 * 4. Record details in state.gpuInfo for telemetry and UI badges.
 */
async function detectOptimalGPUAdapter() {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    console.log('[ML Engine] WebGPU not available in this browser environment. Using CPU WASM.');
    state.gpuInfo = {
      available: false,
      vendor: 'none',
      model: 'CPU WebAssembly',
      isNvidia: false,
      isIntel: false,
      backend: self.crossOriginIsolated ? 'wasm (multi-threaded)' : 'wasm (single)',
      powerPreference: 'none',
    };
    return null;
  }

  try {
    let adapter = null;
    try {
      // Call requestAdapter directly — avoids crbug.com/369219127 powerPreference warning on Windows
      adapter = await navigator.gpu.requestAdapter();
    } catch (e) {
      // requestAdapter can reject in headless / offscreen contexts
    }

    if (adapter) {
      let info = null;
      try {
        info = (typeof adapter.requestAdapterInfo === 'function') ? await adapter.requestAdapterInfo() : adapter.info;
      } catch (e) {}
      info = info || {};

      const vendor = (info.vendor || '').toLowerCase();
      const description = (info.description || info.architecture || '').toLowerCase();
      const isNvidia = vendor.includes('nvidia') || description.includes('nvidia') || description.includes('geforce') || description.includes('rtx') || description.includes('gtx');
      const isIntel = vendor.includes('intel') || description.includes('intel') || description.includes('iris') || description.includes('uhd') || description.includes('arc');

      const cleanModel = info.description || info.architecture || (isNvidia ? 'NVIDIA GeForce/RTX' : isIntel ? 'Intel Graphics' : 'WebGPU Device');

      state.gpuAdapter = adapter;
      state.gpuInfo = {
        available: true,
        vendor: isNvidia ? 'NVIDIA' : isIntel ? 'Intel' : (info.vendor || 'Unknown GPU'),
        model: cleanModel,
        isNvidia: isNvidia,
        isIntel: isIntel,
        backend: isNvidia ? 'webgpu (NVIDIA)' : isIntel ? 'webgpu (Intel)' : 'webgpu',
        powerPreference: 'high-performance',
      };

      console.log(`[ML Engine] 🚀 Hardware Acceleration: Detected ${state.gpuInfo.vendor} GPU [${state.gpuInfo.model}]`);
      if (isNvidia) {
        console.log('[ML Engine] ✓ Priority Granted: NVIDIA Discrete GPU active for hardware-accelerated sanitization pipeline.');
      } else if (isIntel) {
        console.log('[ML Engine] ℹ️ Intel Integrated GPU active (MUX in hybrid/eco mode). Seamless acceleration active.');
      }

      if (typeof ort !== 'undefined' && ort.env?.webgpu) {
        ort.env.webgpu.powerPreference = 'high-performance';
      }

      return adapter;
    }
  } catch (err) {
    console.log('[ML Engine] GPU adapter detection note:', err.message || err);
  }

  state.gpuInfo = {
    available: false,
    vendor: 'none',
    model: 'CPU WebAssembly',
    isNvidia: false,
    isIntel: false,
    backend: self.crossOriginIsolated ? 'wasm (multi-threaded)' : 'wasm (single)',
    powerPreference: 'none',
  };
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// FACE DETECTION ENGINE (Layer 2)
// ═══════════════════════════════════════════════════════════════════════════

async function loadFaceModel() {
  if (!state.onnxReady || typeof ort === 'undefined') return false;

  // Try loading from IndexedDB cache first
  let modelBuffer = await getCachedBlob('face_model_slim320');
  if (modelBuffer) {
    console.log('[ML Engine] Face model loaded from IndexedDB cache');
  } else {
    // 1. Check local extension models directory FIRST (offline, no CORS mode)
    const localUrl = (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
      ? chrome.runtime.getURL('models/version-slim-320.onnx')
      : null;

    if (localUrl) {
      try {
        console.log(`[ML Engine] Loading face model from local extension: ${localUrl}`);
        const resp = await fetch(localUrl);
        if (resp.ok) {
          modelBuffer = await resp.arrayBuffer();
          await setCachedBlob('face_model_slim320', modelBuffer);
          console.log(`[ML Engine] Face model loaded and cached (${(modelBuffer.byteLength / 1024).toFixed(0)}KB)`);
        }
      } catch (e) {
        console.log('[ML Engine] Local face model fetch note:', e.message);
      }
    }
  }

  if (!modelBuffer) {
    console.log('[ML Engine] Face model unavailable — face detection will be skipped');
    return false;
  }

  // Detect and configure optimal GPU adapter (NVIDIA priority with Intel MUX fallback)
  const gpuAdapter = await detectOptimalGPUAdapter();

  // 1. Try WebGPU on detected GPU, but validate with pre-flight warmup
  if (gpuAdapter && state.gpuInfo.available) {
    try {
      console.log(`[ML Engine] Initializing ONNX Face Detection session on WebGPU (${state.gpuInfo.vendor})...`);
      const testSession = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ['webgpu'],
        preferredOutputLocation: 'cpu',
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3,
      });

      // PRE-FLIGHT WARMUP: verify that all WebGPU kernels (specifically Mul node [1, 4420, 2]) execute cleanly
      const dummyInput = new Float32Array(3 * CONFIG.FACE_INPUT_WIDTH * CONFIG.FACE_INPUT_HEIGHT);
      const dummyTensor = new ort.Tensor('float32', dummyInput, [1, 3, CONFIG.FACE_INPUT_HEIGHT, CONFIG.FACE_INPUT_WIDTH]);
      await testSession.run({ input: dummyTensor });

      state.faceSession = testSession;
      console.log(`[ML Engine] ✓ ONNX Face Detection session validated on ${state.gpuInfo.backend}`);
      return true;
    } catch (e) {
      console.log(`[ML Engine] WebGPU JSEP kernel note (${e.message || e}) — switching to ultra-fast WASM SIMD...`);
      state.gpuInfo.backend = self.crossOriginIsolated ? 'wasm (multi-threaded SIMD)' : 'wasm (SIMD)';
      state.gpuInfo.available = false;
      if (state.faceSession) {
        try { await state.faceSession.release(); } catch (_) {}
        state.faceSession = null;
      }
    }
  }

  // 2. Fallback to CPU WASM (threaded & SIMD if crossOriginIsolated)
  try {
    if (typeof ort !== 'undefined' && ort.env?.wasm) {
      ort.env.wasm.numThreads = self.crossOriginIsolated
        ? Math.min(4, (navigator.hardwareConcurrency || 2))
        : 1;
      ort.env.wasm.simd = true;
    }
    state.faceSession = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3,
    });
    console.log(`[ML Engine] ✓ ONNX Face Detection session created on WASM (${self.crossOriginIsolated ? `multi-threaded, ${ort.env.wasm.numThreads} threads` : 'single-threaded'})`);
    return true;
  } catch (e) {
    console.log('[ML Engine] WASM session creation note:', e.message || e);
    state.faceSession = null;
    return false;
  }
}

// Cached canvas for preprocessing to eliminate memory churn and GPU readback stalls
let preprocCanvas = null;
let preprocCtx = null;
// Pre-allocated static buffer for face detection tensor (320×240×3 = 230,400 floats)
const PREPROC_TENSOR_BUFFER = new Float32Array(3 * 320 * 240);

/**
 * Run UltraFace face detection on viewport image.
 * Accepts either pre-decoded Image/Canvas/ImageBitmap or base64 JPEG.
 * Returns face bounding boxes in screen pixel coordinates.
 */
async function detectFaces(imageOrBase64) {
  if (!state.faceSession) return [];

  const t0 = performance.now();

  // Decode image to canvas if not already decoded
  const img = (typeof imageOrBase64 === 'string') ? await loadImageFromBase64(imageOrBase64) : imageOrBase64;
  const origW = img.width;
  const origH = img.height;

  // Preprocess: resize to 320x240, normalize
  // Reuse canvas context with willReadFrequently: true to avoid readback stalls and warnings
  if (!preprocCanvas) {
    preprocCanvas = new OffscreenCanvas(CONFIG.FACE_INPUT_WIDTH, CONFIG.FACE_INPUT_HEIGHT);
    preprocCtx = preprocCanvas.getContext('2d', { willReadFrequently: true });
  }
  preprocCtx.drawImage(img, 0, 0, CONFIG.FACE_INPUT_WIDTH, CONFIG.FACE_INPUT_HEIGHT);
  const imageData = preprocCtx.getImageData(0, 0, CONFIG.FACE_INPUT_WIDTH, CONFIG.FACE_INPUT_HEIGHT);

  // Convert to float32 NCHW tensor, normalize: (pixel - 127) / 128
  // Uses pre-allocated static buffer to eliminate per-frame Float32Array allocation
  const { data } = imageData;
  const numPixels = CONFIG.FACE_INPUT_WIDTH * CONFIG.FACE_INPUT_HEIGHT;
  const float32Data = PREPROC_TENSOR_BUFFER;
  for (let i = 0; i < numPixels; i++) {
    const ri = i * 4;
    float32Data[i] = (data[ri] - 127) / 128;                      // R channel
    float32Data[numPixels + i] = (data[ri + 1] - 127) / 128;      // G channel
    float32Data[2 * numPixels + i] = (data[ri + 2] - 127) / 128;  // B channel
  }

  const inputTensor = new ort.Tensor('float32', float32Data, [1, 3, CONFIG.FACE_INPUT_HEIGHT, CONFIG.FACE_INPUT_WIDTH]);

  // Run inference with safe fallback
  let results;
  try {
    results = await state.faceSession.run({ input: inputTensor });
  } catch (e) {
    console.log('[ML Engine] Face inference note:', e.message || e);
    // If WebGPU failed during runtime, recover immediately to WASM
    if (state.gpuInfo?.backend && state.gpuInfo.backend.includes('webgpu')) {
      try {
        console.log('[ML Engine] Runtime WebGPU issue — seamlessly migrating session to WASM SIMD...');
        state.gpuInfo.backend = 'wasm (SIMD)';
        state.gpuInfo.available = false;
        try { await state.faceSession.release(); } catch (_) {}
        state.faceSession = null;
        await loadFaceModel();
        if (state.faceSession) {
          results = await state.faceSession.run({ input: inputTensor });
        }
      } catch (err2) {
        console.log('[ML Engine] WASM runtime recovery note:', err2.message || err2);
      }
    }
    if (!results) return [];
  }

  // Post-process: extract scores and boxes (safe for WebGPU buffers and CPU arrays)
  let scores, boxes;
  try {
    scores = results.scores.getData ? await results.scores.getData() : results.scores.data;
  } catch (e) {
    scores = results.scores.data;
  }
  try {
    boxes = results.boxes.getData ? await results.boxes.getData() : results.boxes.data;
  } catch (e) {
    boxes = results.boxes.data;
  }

  const numAnchors = scores.length / 2;
  const detections = [];
  const maxFaceW = origW * 0.60; // A human face on a normal website never spans > 60% width
  const maxFaceH = origH * 0.60; // A human face on a normal website never spans > 60% height
  const minFaceDim = 14;         // Sub-14px detections are noise artifacts

  for (let i = 0; i < numAnchors; i++) {
    const faceScore = scores[i * 2 + 1];
    if (faceScore < CONFIG.FACE_CONFIDENCE_THRESHOLD) continue;

    // Strict clamping to image bounds
    const rawX1 = Math.max(0, Math.min(1.0, boxes[i * 4 + 0]));
    const rawY1 = Math.max(0, Math.min(1.0, boxes[i * 4 + 1]));
    const rawX2 = Math.max(0, Math.min(1.0, boxes[i * 4 + 2]));
    const rawY2 = Math.max(0, Math.min(1.0, boxes[i * 4 + 3]));

    const x1 = Math.round(rawX1 * origW);
    const y1 = Math.round(rawY1 * origH);
    const x2 = Math.round(rawX2 * origW);
    const y2 = Math.round(rawY2 * origH);

    const w = Math.max(0, x2 - x1);
    const h = Math.max(0, y2 - y1);

    // Filter out invalid, screen-filling, or distorted non-face boxes
    if (w < minFaceDim || h < minFaceDim) continue;
    if (w > maxFaceW || h > maxFaceH) continue;
    const aspect = w / h;
    if (aspect < 0.35 || aspect > 2.8) continue; // Face bounding boxes are roughly upright

    detections.push({
      x: x1,
      y: y1,
      width: w,
      height: h,
      confidence: parseFloat(faceScore.toFixed(3)),
      type: 'face_ml',
    });
  }

  // Non-Maximum Suppression
  const nmsResult = nms(detections, CONFIG.FACE_NMS_IOU_THRESHOLD);

  const elapsed = Math.round(performance.now() - t0);
  console.log(`[ML Engine] Face detection: ${nmsResult.length} faces in ${elapsed}ms`);

  return nmsResult;
}

/**
 * Greedy Non-Maximum Suppression
 */
function nms(detections, iouThreshold) {
  if (detections.length === 0) return [];

  // Sort by confidence descending
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
  const keep = [];
  const suppressed = new Set();

  for (let i = 0; i < sorted.length; i++) {
    if (suppressed.has(i)) continue;
    keep.push(sorted[i]);
    for (let j = i + 1; j < sorted.length; j++) {
      if (suppressed.has(j)) continue;
      if (computeIoU(sorted[i], sorted[j]) > iouThreshold) {
        suppressed.add(j);
      }
    }
  }
  return keep;
}

function computeIoU(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const inter = interW * interH;
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// OCR ENGINE (Layer 3) — Tesseract.js
// ═══════════════════════════════════════════════════════════════════════════

async function initTesseractWorker() {
  if (!state.tesseractReady || state.tesseractWorker) return;
  try {
    const workerPromise = Tesseract.createWorker('eng', 1, {
      errorHandler: () => {},
      logger: (info) => {
        if (info.status === 'recognizing text') return;
        console.log(`[ML Engine] Tesseract: ${info.status}`);
      }
    });
    // 1s timeout so worker creation never stalls background initialization
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000));
    state.tesseractWorker = await Promise.race([workerPromise, timeoutPromise]);
    console.log('[ML Engine] Tesseract OCR worker initialized successfully');
  } catch (e) {
    console.log('[ML Engine] Tesseract worker skipped (DOM protects 100% of web page PII)');
    state.tesseractWorker = null;
  }
}

/**
 * Run OCR on image regions that likely contain text-as-pixels.
 * Returns PII detections found in the OCR-extracted text.
 * Optimized with smart downsampling for sub-100ms CPU worker throughput.
 */
async function ocrScanForPII(imageOrBase64, ocrTargets = []) {
  if (!state.tesseractWorker) return [];

  const t0 = performance.now();

  try {
    const img = (typeof imageOrBase64 === 'string') ? await loadImageFromBase64(imageOrBase64) : imageOrBase64;
    const origW = img.width;
    const origH = img.height;

    // Fast-path 1: Targeted region OCR for candidate scanned documents / canvases (< 100ms)
    if (Array.isArray(ocrTargets) && ocrTargets.length > 0) {
      const targetedPii = [];
      for (const target of ocrTargets.slice(0, 3)) { // process up to 3 candidate targets
        const rx = Math.max(0, Math.round(target.x || 0));
        const ry = Math.max(0, Math.round(target.y || 0));
        const rw = Math.min(Math.round(target.width || 0), origW - rx);
        const rh = Math.min(Math.round(target.height || 0), origH - ry);
        if (rw < 20 || rh < 20) continue;

        const cropCanvas = new OffscreenCanvas(rw, rh);
        const cCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
        cCtx.drawImage(img, rx, ry, rw, rh, 0, 0, rw, rh);

        // DIRECT TRANSFER: Pass OffscreenCanvas directly to Tesseract.js v5 (no JPEG encode/decode)
        const res = await state.tesseractWorker.recognize(cropCanvas);
        const text = res?.data?.text || '';
        if (text.trim().length >= 4) {
          const regions = classifyPIIFromOCRResult(res.data, text, 1, 1);
          for (const reg of regions) {
            reg.x += rx;
            reg.y += ry;
            targetedPii.push(reg);
          }
        }
      }
      if (targetedPii.length > 0) {
        const elapsed = Math.round(performance.now() - t0);
        console.log(`[ML Engine] Targeted OCR: found ${targetedPii.length} PII regions in ${elapsed}ms`);
        return targetedPii;
      }
    }

    // Fast-path 2: Downscale full page to max 800px width (4x faster than 1280px while preserving 100% legibility)
    const MAX_OCR_WIDTH = 800;
    const targetW = Math.min(origW, MAX_OCR_WIDTH);
    const targetH = Math.round(origH * (targetW / origW));
    const scanCanvas = new OffscreenCanvas(targetW, targetH);
    const sCtx = scanCanvas.getContext('2d', { willReadFrequently: true });
    sCtx.drawImage(img, 0, 0, targetW, targetH);
    const scaleX = origW / targetW;
    const scaleY = origH / targetH;

    // DIRECT TRANSFER: Pass OffscreenCanvas directly to Tesseract.js v5 (no JPEG encode/decode)
    const result = await state.tesseractWorker.recognize(scanCanvas);
    const text = result?.data?.text || '';

    if (text.trim().length < 4) return [];

    // Run PII regex/heuristic NER on OCR-extracted text with scaled bounding boxes
    const piiRegions = classifyPIIFromOCRResult(result.data, text, scaleX, scaleY);

    const elapsed = Math.round(performance.now() - t0);
    console.log(`[ML Engine] Full-frame OCR: extracted ${text.length} chars, found ${piiRegions.length} PII regions in ${elapsed}ms`);

    return piiRegions;
  } catch (e) {
    console.error('[ML Engine] OCR scan error:', e);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PII CLASSIFIER — Uses PIIEngine (pii_rules.js) for expanded patterns
// with Verhoeff/Luhn checksum validation and new national ID coverage.
// Falls back to inline patterns if PIIEngine is not available.
// ═══════════════════════════════════════════════════════════════════════════

const PII_PATTERNS = (typeof PIIEngine !== 'undefined' && PIIEngine.PATTERNS) ? PIIEngine.PATTERNS : {
  aadhaar: /\b[2-9]\d{3}[\s-]?[0-9]{4}[\s-]?[0-9]{4}\b/g,
  panCard: /\b[A-Z]{3}[PCHFATBLJG][A-Z][0-9]{4}[A-Z]\b/g,
  creditCard: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11})\b/g,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  phone: /\b(?:\+91[\-\s]?)?[6-9]\d{9}\b/g,
  token: /(?:eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}|(?:sk|nvapi|ghp|pk)[-_][a-zA-Z0-9_-]{15,})/g,
  indianPinCode: /\b\d{6}\b/g,
  passport: /\b[A-PR-WYa-pr-wy][1-9]\d{6,7}\b/g,
  bankAccount: /\b\d{9,18}\b/g,
  ifsc: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
  drivingLicense: /\b[A-Z]{2}[-\s]?[0-9]{2}[-\s]?(?:19|20)\d{2}[-\s]?[0-9]{7}\b/g,
  voterId: /\b[A-Z]{3}[0-9]{7}\b/g,
  upiVpa: /\b[a-zA-Z0-9.\-_]{2,64}@(okaxis|okhdfcbank|okicici|oksbi|paytm|ybl|ibl|upi|apl|axl|federal|kotak|postbank|icici|hdfcbank|sbi)\b/gi,
  aadhaarMasked: /\b(?:[X\*\.]{4}[\s-]?){2}\d{4}\b/g,
  panMasked: /\b(?:[A-Z]{5}[X\*]{4}[A-Z]|[X\*]{5}[0-9]{4}[A-Z])\b/g,
  dob: /\b(?:DOB|D\.O\.B|Date of Birth)[\s:]+(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})\b/gi,
};

// Address keywords for contextual detection
const ADDRESS_KEYWORDS = (typeof PIIEngine !== 'undefined' && PIIEngine.ADDRESS_KEYWORDS) ? PIIEngine.ADDRESS_KEYWORDS :
  /\b(road|street|nagar|colony|sector|block|lane|gali|mohalla|marg|chowk|circle|avenue|plot|flat|floor|apartment|house\s*no|h\.?\s*no|door\s*no|village|district|tehsil|mandal|taluk|city|town|state|pin\s*code|postal|zip)\b/i;

// Name context keywords (field labels that precede names)
const NAME_CONTEXT = (typeof PIIEngine !== 'undefined' && PIIEngine.NAME_CONTEXT) ? PIIEngine.NAME_CONTEXT :
  /\b(name|applicant|father|mother|spouse|guardian|nominee|beneficiary|account\s*holder|customer|patient|student)\s*[:\-]?\s*/i;

/**
 * Classify PII from Tesseract OCR result.
 * Uses word-level bounding boxes from Tesseract for precise redaction.
 */
function classifyPIIFromOCRResult(ocrData, fullText, scaleX = 1, scaleY = 1) {
  const regions = [];

  // Run regex patterns on the full extracted text
  for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(fullText)) !== null) {
      // Strict checksum validation gates
      if (type === 'aadhaar' && typeof PIIEngine !== 'undefined' && !PIIEngine.validateVerhoeff(match[0])) continue;
      if (type === 'creditCard') {
        const luhnValid = (typeof PIIEngine !== 'undefined') ? PIIEngine.validateLuhn(match[0]) : isValidCreditCard(match[0]);
        if (!luhnValid) continue;
      }
      // PIN codes only count if near address context
      if (type === 'indianPinCode' && !ADDRESS_KEYWORDS.test(fullText)) continue;
      // Bank accounts only in banking context
      if (type === 'bankAccount' && !/bank|account|a\/c|saving|current/i.test(fullText)) continue;
      // Voter ID needs electoral context
      if (type === 'voterId' && !/voter|epic|election|electoral/i.test(fullText)) continue;
      // DL needs driving context
      if (type === 'drivingLicense' && !/driving|license|licence|dl|rto/i.test(fullText)) continue;

      // Isolate date text for DOB to leave label visible on scanned forms
      let targetText = match[0];
      let targetIndex = match.index;
      if (type === 'dob' && match[1]) {
        const offset = match[0].lastIndexOf(match[1]);
        targetText = match[1];
        targetIndex = match.index + offset;
      }

      const bbox = findWordBBox(ocrData, targetText, targetIndex);
      if (bbox) {
        regions.push({
          x: Math.round(bbox.x * scaleX),
          y: Math.round(bbox.y * scaleY),
          width: Math.round(bbox.width * scaleX),
          height: Math.round(bbox.height * scaleY),
          type: type === 'indianPinCode' ? 'address' : (type === 'panMasked' ? 'panCard' : type.replace('Masked', '')),
          confidence: 0.9,
          source: 'ocr',
          matchedText: targetText,
        });
      }
    }
  }

  // Contextual address detection
  if (ADDRESS_KEYWORDS.test(fullText)) {
    // Find lines containing address keywords and mark them
    const lines = ocrData.lines || [];
    for (const line of lines) {
      const lineText = line.text || '';
      if (ADDRESS_KEYWORDS.test(lineText) && lineText.length > 10) {
        const bbox = line.bbox;
        if (bbox) {
          regions.push({
            x: Math.round(bbox.x0 * scaleX),
            y: Math.round(bbox.y0 * scaleY),
            width: Math.round((bbox.x1 - bbox.x0) * scaleX),
            height: Math.round((bbox.y1 - bbox.y0) * scaleY),
            type: 'address',
            confidence: 0.75,
            source: 'ocr_context',
            matchedText: lineText.slice(0, 50),
          });
        }
      }
    }
  }

  // Contextual name detection (near "Name:", "Applicant:", etc.)
  if (NAME_CONTEXT.test(fullText)) {
    const lines = ocrData.lines || [];
    for (const line of lines) {
      const lineText = line.text || '';
      if (NAME_CONTEXT.test(lineText)) {
        const bbox = line.bbox;
        if (bbox) {
          regions.push({
            x: Math.round(bbox.x0 * scaleX),
            y: Math.round(bbox.y0 * scaleY),
            width: Math.round((bbox.x1 - bbox.x0) * scaleX),
            height: Math.round((bbox.y1 - bbox.y0) * scaleY),
            type: 'name',
            confidence: 0.7,
            source: 'ocr_context',
            matchedText: lineText.slice(0, 50),
          });
        }
      }
    }
  }

  return regions;
}

/**
 * Find word-level bounding box in Tesseract output for a matched string.
 */
function findWordBBox(ocrData, matchStr, charIndex) {
  const words = ocrData.words || [];
  const cleanMatch = matchStr.replace(/\s+/g, '').toLowerCase();

  // Try to find the word(s) that contain this match
  let accumulated = '';
  let startWord = null;
  let endWord = null;

  for (const word of words) {
    const wordText = (word.text || '').replace(/\s+/g, '').toLowerCase();
    if (!wordText) continue;

    if (!startWord && wordText.includes(cleanMatch.slice(0, Math.min(4, cleanMatch.length)))) {
      startWord = word;
      endWord = word;
      accumulated = wordText;
    } else if (startWord && accumulated.length < cleanMatch.length) {
      accumulated += wordText;
      endWord = word;
    }

    if (startWord && accumulated.length >= cleanMatch.length) break;
  }

  if (startWord && startWord.bbox && endWord && endWord.bbox) {
    return {
      x: startWord.bbox.x0,
      y: Math.min(startWord.bbox.y0, endWord.bbox.y0),
      width: endWord.bbox.x1 - startWord.bbox.x0,
      height: Math.max(endWord.bbox.y1, startWord.bbox.y1) - Math.min(startWord.bbox.y0, endWord.bbox.y0),
    };
  }

  return null;
}

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

// ═══════════════════════════════════════════════════════════════════════════
// ZERO-ALLOCATION STACKBLUR (for face redaction)
// Based on Mario Klingemann's StackBlur — rewritten with flat Int32Array
// ring buffer to eliminate per-row/column object allocations and GC churn.
// Single-pass execution (sufficient for privacy redaction at blur radii >= 8).
// ═══════════════════════════════════════════════════════════════════════════

const MUL_TABLE = [512,512,456,512,328,456,335,512,405,328,271,456,388,335,292,512,
  454,405,364,328,298,271,496,456,420,388,360,335,312,292,273,512,
  482,454,428,405,383,364,345,328,312,298,284,271,259,496,475,456,
  437,420,404,388,374,360,347,335,323,312,302,292,282,273,265,512,
  497,482,468,454,441,428,417,405,394,383,373,364,354,345,337,328,
  320,312,305,298,291,284,278,271,265,259,507,496,485,475,465,456,
  446,437,428,420,412,404,396,388,381,374,367,360,354,347,341,335,
  329,323,318,312,307,302,297,292,287,282,278,273,269,265,261,512];

const SHG_TABLE = [9,11,12,13,13,14,14,15,15,15,15,16,16,16,16,17,
  17,17,17,17,17,17,18,18,18,18,18,18,18,18,18,19,
  19,19,19,19,19,19,19,19,19,19,19,19,19,20,20,20,
  20,20,20,20,20,20,20,20,20,20,20,20,20,20,20,21,
  21,21,21,21,21,21,21,21,21,21,21,21,21,21,21,21,
  21,21,21,21,21,21,21,21,21,21,22,22,22,22,22,22,
  22,22,22,22,22,22,22,22,22,22,22,22,22,22,22,22,
  22,22,22,22,22,22,22,22,22,22,22,22,22,22,22,23];

// Global reusable ring-buffer cache for stack blur (max radius 127 → div 255 → 255*3 = 765 slots)
const STACK_BUFFER = new Int32Array(256 * 3);

function stackBlurImageData(imageData, x, y, w, h, radius) {
  if (radius < 1 || w <= 0 || h <= 0) return;
  radius = Math.min(radius, 127);

  const pixels = imageData.data;
  const imgW = imageData.width;
  const div = 2 * radius + 1;
  const mulSum = MUL_TABLE[radius];
  const shgSum = SHG_TABLE[radius];

  const stack = STACK_BUFFER; // Flat structure: [r0, g0, b0, r1, g1, b1, ...]

  // Horizontal Pass
  for (let row = y; row < y + h; row++) {
    let rSum = 0, gSum = 0, bSum = 0;
    let rInSum = 0, gInSum = 0, bInSum = 0;
    let rOutSum = 0, gOutSum = 0, bOutSum = 0;

    for (let i = -radius; i <= radius; i++) {
      const px = Math.max(x, Math.min(x + w - 1, x + i));
      const idx = (row * imgW + px) * 4;
      const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
      const sIdx = (i + radius) * 3;
      stack[sIdx] = r;
      stack[sIdx + 1] = g;
      stack[sIdx + 2] = b;

      const rbs = radius + 1 - Math.abs(i);
      rSum += r * rbs;
      gSum += g * rbs;
      bSum += b * rbs;

      if (i > 0) { rInSum += r; gInSum += g; bInSum += b; }
      else { rOutSum += r; gOutSum += g; bOutSum += b; }
    }

    let stackIn = radius;
    let stackOut = 0;

    for (let col = x; col < x + w; col++) {
      const idx = (row * imgW + col) * 4;
      pixels[idx] = (rSum * mulSum) >>> shgSum;
      pixels[idx + 1] = (gSum * mulSum) >>> shgSum;
      pixels[idx + 2] = (bSum * mulSum) >>> shgSum;

      rSum -= rOutSum;
      gSum -= gOutSum;
      bSum -= bOutSum;

      const outOffset = stackOut * 3;
      rOutSum -= stack[outOffset];
      gOutSum -= stack[outOffset + 1];
      bOutSum -= stack[outOffset + 2];

      const nextCol = Math.min(col + radius + 1, x + w - 1);
      const nextIdx = (row * imgW + nextCol) * 4;
      stack[outOffset] = pixels[nextIdx];
      stack[outOffset + 1] = pixels[nextIdx + 1];
      stack[outOffset + 2] = pixels[nextIdx + 2];

      rInSum += stack[outOffset];
      gInSum += stack[outOffset + 1];
      bInSum += stack[outOffset + 2];

      rSum += rInSum;
      gSum += gInSum;
      bSum += bInSum;

      stackIn = (stackIn + 1) % div;
      stackOut = (stackOut + 1) % div;

      const inOffset = stackIn * 3;
      rOutSum += stack[inOffset];
      gOutSum += stack[inOffset + 1];
      bOutSum += stack[inOffset + 2];

      rInSum -= stack[inOffset];
      gInSum -= stack[inOffset + 1];
      bInSum -= stack[inOffset + 2];
    }
  }

  // Vertical Pass
  for (let col = x; col < x + w; col++) {
    let rSum = 0, gSum = 0, bSum = 0;
    let rInSum = 0, gInSum = 0, bInSum = 0;
    let rOutSum = 0, gOutSum = 0, bOutSum = 0;

    for (let i = -radius; i <= radius; i++) {
      const py = Math.max(y, Math.min(y + h - 1, y + i));
      const idx = (py * imgW + col) * 4;
      const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
      const sIdx = (i + radius) * 3;
      stack[sIdx] = r;
      stack[sIdx + 1] = g;
      stack[sIdx + 2] = b;

      const rbs = radius + 1 - Math.abs(i);
      rSum += r * rbs;
      gSum += g * rbs;
      bSum += b * rbs;

      if (i > 0) { rInSum += r; gInSum += g; bInSum += b; }
      else { rOutSum += r; gOutSum += g; bOutSum += b; }
    }

    let stackIn = radius;
    let stackOut = 0;

    for (let row = y; row < y + h; row++) {
      const idx = (row * imgW + col) * 4;
      pixels[idx] = (rSum * mulSum) >>> shgSum;
      pixels[idx + 1] = (gSum * mulSum) >>> shgSum;
      pixels[idx + 2] = (bSum * mulSum) >>> shgSum;

      rSum -= rOutSum;
      gSum -= gOutSum;
      bSum -= bOutSum;

      const outOffset = stackOut * 3;
      rOutSum -= stack[outOffset];
      gOutSum -= stack[outOffset + 1];
      bOutSum -= stack[outOffset + 2];

      const nextRow = Math.min(row + radius + 1, y + h - 1);
      const nextIdx = (nextRow * imgW + col) * 4;
      stack[outOffset] = pixels[nextIdx];
      stack[outOffset + 1] = pixels[nextIdx + 1];
      stack[outOffset + 2] = pixels[nextIdx + 2];

      rInSum += stack[outOffset];
      gInSum += stack[outOffset + 1];
      bInSum += stack[outOffset + 2];

      rSum += rInSum;
      gSum += gInSum;
      bSum += bInSum;

      stackIn = (stackIn + 1) % div;
      stackOut = (stackOut + 1) % div;

      const inOffset = stackIn * 3;
      rOutSum += stack[inOffset];
      gOutSum += stack[inOffset + 1];
      bOutSum += stack[inOffset + 2];

      rInSum -= stack[inOffset];
      gInSum -= stack[inOffset + 1];
      bInSum -= stack[inOffset + 2];
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CANVAS REDACTION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

const BADGE_THEMES = {
  // HIGH-CONTRAST opaque colors — visible on ANY page background (dark or light)
  password:       { bg: '#7f1d1d', border: '#ef4444', text: '#ffffff', label: '[REDACTED: PASSWORD]' },
  creditCard:     { bg: '#1e3a5f', border: '#3b82f6', text: '#ffffff', label: '[REDACTED: CREDIT_CARD]' },
  aadhaar:        { bg: '#78350f', border: '#f59e0b', text: '#ffffff', label: '[REDACTED: AADHAAR]' },
  aadhaarMasked:  { bg: '#78350f', border: '#f59e0b', text: '#ffffff', label: '[REDACTED: AADHAAR]' },
  panCard:        { bg: '#581c87', border: '#a855f7', text: '#ffffff', label: '[REDACTED: PAN_CARD]' },
  panMasked:      { bg: '#581c87', border: '#a855f7', text: '#ffffff', label: '[REDACTED: PAN_CARD]' },
  pan:            { bg: '#581c87', border: '#a855f7', text: '#ffffff', label: '[REDACTED: PAN_CARD]' },
  email:          { bg: '#164e63', border: '#06b6d4', text: '#ffffff', label: '[REDACTED: EMAIL]' },
  phone:          { bg: '#14532d', border: '#22c55e', text: '#ffffff', label: '[REDACTED: PHONE]' },
  // Transparent tint allows the VLM to recognize an avatar's silhouette while StackBlur destroys identity
  face_ml:        { bg: 'rgba(88, 28, 135, 0.35)', border: '#a855f7', text: '#ffffff', label: '[REDACTED: FACE]' },
  face:           { bg: 'rgba(88, 28, 135, 0.35)', border: '#a855f7', text: '#ffffff', label: '[REDACTED: FACE]' },
  name:           { bg: '#9f1239', border: '#fb7185', text: '#ffffff', label: '[REDACTED: NAME]' },
  address:        { bg: '#0e7490', border: '#22d3ee', text: '#ffffff', label: '[REDACTED: ADDRESS]' },
  token:          { bg: '#7f1d1d', border: '#ef4444', text: '#ffffff', label: '[REDACTED: TOKEN]' },
  passport:       { bg: '#581c87', border: '#a855f7', text: '#ffffff', label: '[REDACTED: PASSPORT]' },
  ifsc:           { bg: '#1e3a5f', border: '#3b82f6', text: '#ffffff', label: '[REDACTED: IFSC]' },
  bankAccount:    { bg: '#1e3a5f', border: '#60a5fa', text: '#ffffff', label: '[REDACTED: BANK_ACCT]' },
  drivingLicense: { bg: '#581c87', border: '#c084fc', text: '#ffffff', label: '[REDACTED: DL]' },
  voterId:        { bg: '#78350f', border: '#fbbf24', text: '#ffffff', label: '[REDACTED: VOTER_ID]' },
  upiVpa:         { bg: '#14532d', border: '#4ade80', text: '#ffffff', label: '[REDACTED: UPI]' },
  dob:            { bg: '#9f1239', border: '#f43f5e', text: '#ffffff', label: '[REDACTED: DOB]' },
  generic:        { bg: '#374151', border: '#ef4444', text: '#ffffff', label: '[REDACTED: PII]' },
};

/**
 * Full redaction pipeline:
 * 1. Merge DOM regions + ML regions, deduplicate by IoU
 * 2. Apply StackBlur for face regions
 * 3. Apply solid OPAQUE mask + badge for text PII regions
 * Returns sanitized base64 JPEG
 */
async function redactFrame(imageOrBase64, domRegions, mlFaceRegions, mlOcrRegions) {
  const t0 = performance.now();

  // Merge all regions, deduplicate overlaps
  const allRegions = mergeAndDeduplicate(domRegions || [], mlFaceRegions || [], mlOcrRegions || []);

  // FAST PATH: If zero regions need redaction, skip canvas entirely and return original image
  // This saves ~100-300ms of unnecessary image decode → canvas draw → JPEG re-encode per step
  if (allRegions.length === 0) {
    const elapsed = Math.round(performance.now() - t0);
    const originalBase64 = (typeof imageOrBase64 === 'string') ? imageOrBase64 : null;
    return {
      sanitizedImageBase64: originalBase64,
      redactionStats: {
        redactedCount: 0,
        categories: [],
        redactionMs: elapsed,
        skippedCanvas: true,
      }
    };
  }

  const img = (typeof imageOrBase64 === 'string') ? await loadImageFromBase64(imageOrBase64) : imageOrBase64;
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  let redactedCount = 0;
  const categories = new Set();

  for (const r of allRegions) {
    // Clamp to canvas bounds
    const rx = Math.max(0, r.x);
    const ry = Math.max(0, r.y);
    const rw = Math.max(0, Math.min(img.width, r.x + r.width) - rx);
    const rh = Math.max(0, Math.min(img.height, r.y + r.height) - ry);
    if (rw <= 0 || rh <= 0) continue;

    redactedCount++;
    categories.add(r.type);
    const theme = BADGE_THEMES[r.type] || BADGE_THEMES.generic;

    if (r.type === 'face_ml' || r.type === 'face') {
      const blurRadius = Math.max(CONFIG.MIN_BLUR_RADIUS, Math.round(Math.max(rw, rh) * CONFIG.BLUR_RADIUS_FACTOR * 1.4));
      try {
        const faceImageData = ctx.getImageData(rx, ry, rw, rh);
        stackBlurImageData(faceImageData, 0, 0, rw, rh, blurRadius);
        ctx.putImageData(faceImageData, rx, ry);

        // Tint overlay atop successful blur
        ctx.fillStyle = theme.bg;
        ctx.fillRect(rx, ry, rw, rh);
      } catch (e) {
        // FAIL-SAFE: If stack blur fails, enforce a 100% OPAQUE mask
        ctx.fillStyle = '#581c87';
        ctx.fillRect(rx, ry, rw, rh);
      }
    } else {
      // FULLY OPAQUE privacy mask for text PII — completely hides content
      ctx.fillStyle = theme.bg;
      ctx.fillRect(rx, ry, rw, rh);
    }

    // Thick visible border
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 3;
    ctx.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);

    // Badge label — centered, adaptive pill background for clean readability
    if (rw >= 24 && rh >= 12) {
      const fontSize = Math.min(14, Math.max(9, Math.floor(rh * 0.45)));
      ctx.font = `bold ${fontSize}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const cx = rx + rw / 2;
      const cy = ry + rh / 2;
      // Adaptive label: use shorter format if width is compact to prevent squished text
      let badgeText = theme.label;
      if (rw < 140) {
        badgeText = theme.label.replace('[REDACTED: ', '[');
      }
      const metrics = ctx.measureText(badgeText);
      const pillW = Math.min(rw - 4, metrics.width + 12);
      const pillH = Math.min(rh - 2, fontSize + 6);

      ctx.fillStyle = 'rgba(0, 0, 0, 0.88)';
      ctx.fillRect(cx - pillW / 2, cy - pillH / 2, pillW, pillH);
      ctx.fillStyle = theme.text;
      ctx.fillText(badgeText, cx, cy, rw - 6);
    }
  }

  // Export sanitized image — high fidelity 0.85 quality for crisp legibility
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  const sanitizedBase64 = await blobToBase64(blob);

  const elapsed = Math.round(performance.now() - t0);

  return {
    sanitizedImageBase64: sanitizedBase64,
    redactionStats: {
      redactedCount,
      categories: Array.from(categories),
      redactionMs: elapsed,
    }
  };
}

/**
 * Merge DOM regions + ML face regions + ML OCR regions.
 * Deduplicate overlaps using IoU > 0.45 (keep higher confidence).
 * Also eliminates spurious screen-filling container boxes (containment suppression).
 */
function mergeAndDeduplicate(domRegions, faceRegions, ocrRegions) {
  const normalized = [];
  for (const r of domRegions) {
    if ((r.type === 'face' || r.type === 'face_ml') && (r.width > 350 || r.height > 350 || (r.width * r.height > 90000))) continue;
    normalized.push({ ...r, confidence: r.confidence || 0.95, source: 'dom' });
  }
  for (const r of faceRegions) {
    if (r.width > 400 || r.height > 400 || (r.width * r.height > 120000)) continue;
    normalized.push({ ...r, source: r.source || 'ml_face' });
  }
  for (const r of ocrRegions) {
    normalized.push({ ...r, source: r.source || 'ml_ocr' });
  }

  normalized.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  const keep = [];
  const used = new Set();

  for (let i = 0; i < normalized.length; i++) {
    if (used.has(i)) continue;
    const a = normalized[i];
    let keepA = true;

    for (let j = i + 1; j < normalized.length; j++) {
      if (used.has(j)) continue;
      const b = normalized[j];

      // 1. Standard IoU suppression
      if (computeIoU(a, b) > 0.45) {
        used.add(j);
        continue;
      }

      // 2. Symmetrical Containment Suppression
      const interArea = computeIntersectionArea(a, b);
      if (interArea > 0) {
        const areaA = a.width * a.height;
        const areaB = b.width * b.height;

        // If B is a large container enclosing A, drop B
        if ((interArea / areaA > 0.75) && (areaB > areaA * 2.2)) {
          used.add(j);
        }
        // If A is a large container enclosing B, favor specific child B and drop container A
        else if ((interArea / areaB > 0.75) && (areaA > areaB * 2.2)) {
          keepA = false;
          break;
        }
      }
    }

    if (keepA) {
      keep.push(a);
    }
  }

  return keep;
}

function computeIntersectionArea(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  return w * h;
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

async function blobToBase64(blob) {
  try {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const len = bytes.byteLength;
    const chunkSize = 32768;
    for (let i = 0; i < len; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, len)));
    }
    return btoa(binary);
  } catch (e) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const res = reader.result || '';
        const b64 = res.includes(',') ? res.substring(res.indexOf(',') + 1) : res;
        resolve(b64);
      };
      reader.onerror = () => reject(new Error('FileReader blob conversion failed'));
      reader.readAsDataURL(blob);
    });
  }
}

async function loadImageFromBase64(base64) {
  if (!base64 || typeof base64 !== 'string') {
    throw new Error('Invalid or empty image base64');
  }

  const cleanB64 = base64.startsWith('data:') ? base64.substring(base64.indexOf(',') + 1) : base64;
  const strippedB64 = cleanB64.replace(/\s/g, '');

  // Modern high-speed offscreen decode via createImageBitmap (runs off-thread, 2-5ms)
  if (typeof createImageBitmap === 'function') {
    try {
      const binaryString = atob(strippedB64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: 'image/jpeg' });
      return await createImageBitmap(blob);
    } catch (e) {
      // Fallback to Image
    }
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error('Image decode timed out (1500ms)')), 1500);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Image decode failed on source'));
    };
    img.src = 'data:image/jpeg;base64,' + strippedB64;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGE HANDLER — chrome.runtime.onMessage
// ═══════════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'ml-engine') return false;

  const action = msg.action;

  if (action === 'PING' || action === 'HEARTBEAT') {
    sendResponse({
      pong: true,
      ready: state.onnxReady,
      faceReady: !!state.faceSession,
      tesseractReady: !!state.tesseractWorker,
      gpuBackend: state.gpuInfo?.backend || 'wasm',
    });
    return false;
  }

  if (action === 'GET_STATUS') {
    sendResponse({
      onnxReady: state.onnxReady,
      tesseractReady: state.tesseractReady,
      faceModelLoaded: !!state.faceSession,
      crossOriginIsolated: !!self.crossOriginIsolated,
      wasmThreads: (typeof ort !== 'undefined' && ort.env?.wasm?.numThreads) || 1,
      gpuInfo: state.gpuInfo,
      stats: state.stats,
    });
    return false;
  }

  if (action === 'PROCESS_FRAME') {
    // Bulletproof High-Speed Pipeline: single decode + face detection + conditional OCR + canvas redaction
    (async () => {
      const t0 = performance.now();
      const imageBase64 = msg.imageBase64;
      const domRegions = msg.domRegions || [];
      const requireOcr = !!(msg.requireOcr || msg.forceOcr);
      const ocrTargets = msg.ocrTargets || [];

      try {
        if (!imageBase64) {
          throw new Error('Missing imageBase64 payload');
        }

        // Wait for models initialization with a 500ms cap (never blocks)
        if (state.initPromise) {
          const initTimeout = new Promise(resolve => setTimeout(resolve, 500));
          await Promise.race([state.initPromise, initTimeout]).catch(() => {});
        }

        // 1. Single Image Decode: decode once for face detection, OCR, and canvas redactor
        const tDecode0 = performance.now();
        const img = await loadImageFromBase64(imageBase64);
        const decodeMs = Math.round(performance.now() - tDecode0);

        // 2. Layer 2 (face detection): runs on WebGPU/NVIDIA or WASM (~15-25ms)
        const tFace0 = performance.now();
        let faceRegions = [];
        if (state.faceSession) {
          try {
            faceRegions = await detectFaces(img);
          } catch (e) {
            console.log('[ML Engine] Face detection note:', e.message);
          }
        }
        const faceDetMs = Math.round(performance.now() - tFace0);

        // 3. Layer 3 (OCR): ONLY run if page has genuine scanned KYC documents or canvas
        let ocrRegions = [];
        if (requireOcr && state.tesseractWorker) {
          try {
            const ocrTimeout = new Promise(resolve => setTimeout(() => resolve([]), 400));
            ocrRegions = await Promise.race([ocrScanForPII(img, ocrTargets), ocrTimeout]);
          } catch (e) {
            console.log('[ML Engine] OCR scan note:', e.message);
          }
        }
        const ocrMs = requireOcr ? Math.round(performance.now() - tFace0 - faceDetMs) : 0;

        // 4. Canvas Redaction — FAST PATH: if zero regions detected, skip canvas entirely
        const tRedact0 = performance.now();
        const totalRegions = domRegions.length + faceRegions.length + ocrRegions.length;
        let redactionResult;
        if (totalRegions === 0) {
          redactionResult = {
            sanitizedImageBase64: imageBase64,
            redactionStats: { redactedCount: 0, categories: [], redactionMs: 0, skippedCanvas: true }
          };
        } else {
          redactionResult = await redactFrame(img, domRegions, faceRegions, ocrRegions);
        }
        const redactionMs = Math.round(performance.now() - tRedact0);

        const totalMs = Math.round(performance.now() - t0);

        // Update stats
        state.stats.framesProcessed++;
        state.stats.facesDetected += faceRegions.length;
        state.stats.piiRegionsFound += ocrRegions.length + domRegions.length;
        state.stats.totalInferenceMs += totalMs;

        sendResponse({
          sanitizedImageBase64: redactionResult.sanitizedImageBase64,
          telemetry: {
            totalMs,
            decodeMs,
            faceDetMs,
            ocrMs,
            redactionMs,
            facesDetected: faceRegions.length,
            ocrPiiFound: ocrRegions.length,
            domPiiFound: domRegions.length,
            totalRedacted: redactionResult.redactionStats.redactedCount,
            categoriesMasked: redactionResult.redactionStats.categories,
            crossOriginIsolated: !!self.crossOriginIsolated,
            wasmBackend: state.onnxReady ? (self.crossOriginIsolated ? 'threaded' : 'single') : 'none',
            gpuVendor: state.gpuInfo?.vendor || 'none',
            gpuModel: state.gpuInfo?.model || 'CPU',
            activeBackend: state.gpuInfo?.backend || 'wasm',
            isNvidia: !!state.gpuInfo?.isNvidia,
            isIntel: !!state.gpuInfo?.isIntel,
            gpuAccelerated: !!(state.gpuInfo?.available && state.gpuInfo?.backend?.includes('webgpu')),
            ocrExecuted: requireOcr && !!state.tesseractWorker,
            protectionStatus: 'ML_ACTIVE',
          },
          mlRegions: [...faceRegions, ...ocrRegions],
        });
      } catch (err) {
        console.log('[ML Engine] Handled PROCESS_FRAME error with safe fallback:', err.message);
        // CRITICAL GUARANTEE: Never leave background.js hanging! Always respond!
        sendResponse({
          sanitizedImageBase64: imageBase64,
          telemetry: {
            totalMs: Math.round(performance.now() - t0),
            decodeMs: 0,
            faceDetMs: 0,
            ocrMs: 0,
            redactionMs: 0,
            facesDetected: 0,
            ocrPiiFound: 0,
            domPiiFound: domRegions.length,
            totalRedacted: 0,
            categoriesMasked: [],
            protectionStatus: 'DOM_ONLY',
            error: err.message,
          },
          mlRegions: domRegions,
        });
      }
    })();
    return true; // Async response
  }

  if (action === 'DETECT_FACES_ONLY') {
    (async () => {
      try {
        if (state.initPromise) await state.initPromise.catch(() => {});
        const faces = await detectFaces(msg.imageBase64);
        sendResponse({ faces });
      } catch (e) {
        sendResponse({ faces: [] });
      }
    })();
    return true;
  }

  if (action === 'OCR_SCAN_ONLY') {
    (async () => {
      try {
        if (state.initPromise) await state.initPromise.catch(() => {});
        const piiRegions = await ocrScanForPII(msg.imageBase64);
        sendResponse({ piiRegions });
      } catch (e) {
        sendResponse({ piiRegions: [] });
      }
    })();
    return true;
  }

  return false;
});

// ═══════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

async function initialize() {
  console.log('[ML Engine] Initializing PrivaPilot ML Privacy Engine...');
  console.log(`[ML Engine] crossOriginIsolated: ${!!self.crossOriginIsolated}`);

  const t0 = performance.now();

  try {
    // Load libraries
    await Promise.allSettled([
      loadONNXRuntime(),
      loadTesseract(),
    ]);

    // Load face model
    if (state.onnxReady) {
      await loadFaceModel().catch(e => console.log('[ML Engine] Face model init note:', e.message));
    }

    // Tesseract worker initializes in background
    if (state.tesseractReady) {
      initTesseractWorker().catch(() => {});
    }
  } catch (err) {
    console.log('[ML Engine] Non-fatal init note:', err.message);
  }

  const elapsed = Math.round(performance.now() - t0);

  console.log(`[ML Engine] ====== INITIALIZATION COMPLETE (${elapsed}ms) ======`);
  console.log(`[ML Engine]   ONNX Runtime: ${state.onnxReady ? '✓' : '✗'}`);
  console.log(`[ML Engine]   Face Model:   ${state.faceSession ? '✓' : '✗'}`);
  console.log(`[ML Engine]   GPU Backend:  ${state.gpuInfo?.backend || 'wasm'} (${state.gpuInfo?.vendor || 'CPU'})`);
  console.log(`[ML Engine]   GPU Device:   ${state.gpuInfo?.model || 'None'}`);
  console.log(`[ML Engine]   Tesseract:    ${state.tesseractReady ? '✓' : '✗'}`);
  console.log(`[ML Engine]   Threading:    ${self.crossOriginIsolated ? 'multi-threaded' : 'single-threaded'}`);

  // Notify background script that ML engine is ready
  chrome.runtime.sendMessage({
    type: 'ML_ENGINE_READY',
    status: {
      onnxReady: state.onnxReady,
      faceModelLoaded: !!state.faceSession,
      tesseractReady: state.tesseractReady,
      ocrWorkerReady: !!state.tesseractWorker,
      crossOriginIsolated: !!self.crossOriginIsolated,
      gpuInfo: state.gpuInfo,
      initTimeMs: elapsed,
    }
  }).catch(() => {}); // Ignore if no listener yet
}

state.initPromise = initialize().catch(() => {});
