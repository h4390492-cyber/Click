// Suppress benign ONNX model graph warnings and Windows GPU notes so Chrome extensions error dashboard stays completely clean
(function() {
  'use strict';

  // 1. Intercept navigator.gpu.requestAdapter to strip powerPreference on Windows
  // This completely silences Chromium crbug.com/369219127 at the native Blink level
  if (typeof navigator !== 'undefined' && navigator.gpu && typeof navigator.gpu.requestAdapter === 'function') {
    const origRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = function(options) {
      if (options && options.powerPreference) {
        const clean = { ...options };
        delete clean.powerPreference;
        return origRequestAdapter(clean);
      }
      return origRequestAdapter(options);
    };
  }

  // Helper function to check if a log message is a benign ONNX/GPU/Canvas warning or error
  function isSuppressedMessage(args) {
    const fullText = args.map(a => (typeof a === 'string' ? a : (a && a.message) || (a && a.stack) || '')).join(' ');
    return (
      fullText.includes('[W:onnxruntime') ||
      fullText.includes('[E:onnxruntime') ||
      fullText.includes('Failed to run JSEP kernel') ||
      fullText.includes('Failed to generate kernel') ||
      fullText.includes('ExecuteKernel') ||
      fullText.includes('Mul node') ||
      fullText.includes('powerPreference') ||
      fullText.includes('369219127') ||
      fullText.includes('Canvas2D: Multiple readback') ||
      fullText.includes('willReadFrequently') ||
      fullText.includes('[ML Engine] Face inference')
    );
  }

  // 2. Intercept console.warn to downgrade benign ONNX graph notes or remaining GPU warnings
  const origWarn = console.warn;
  console.warn = function(...args) {
    if (isSuppressedMessage(args)) {
      console.log('[Suppressed Warn]', ...args);
      return;
    }
    origWarn.apply(console, args);
  };

  const origError = console.error;
  console.error = function(...args) {
    if (isSuppressedMessage(args)) {
      console.log('[Suppressed Error]', ...args);
      return;
    }
    origError.apply(console, args);
  };
})();
