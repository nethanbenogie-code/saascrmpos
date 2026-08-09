// LysiPOS — camera barcode scanner via the native BarcodeDetector API.
// Falls back gracefully when unavailable.

export function isScannerSupported() {
  return typeof window !== 'undefined'
    && 'BarcodeDetector' in window
    && !!navigator.mediaDevices?.getUserMedia;
}

const DEFAULT_FORMATS = ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'qr_code', 'itf', 'codabar'];

/**
 * Opens a camera modal and resolves with { value, format } on the first detected code.
 * Rejects with Error('cancelled') if the user closes the modal.
 */
export function openScanner(opts = {}) {
  return new Promise(async (resolve, reject) => {
    if (!('BarcodeDetector' in window)) {
      reject(new Error('This browser does not support BarcodeDetector. Try Chrome / Edge on Android, or Safari on iOS 17+.'));
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      reject(new Error('Camera access is not available in this browser.'));
      return;
    }

    let supported = [];
    try { supported = await BarcodeDetector.getSupportedFormats(); } catch {}
    const wanted = opts.formats || DEFAULT_FORMATS;
    const formats = wanted.filter((f) => supported.includes(f));
    if (!formats.length) {
      reject(new Error('No supported barcode formats on this device.'));
      return;
    }
    const detector = new BarcodeDetector({ formats });

    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal" style="width:min(520px,100%)">
        <div class="m-h">
          <h3 style="margin:0">📷 Scan barcode / QR</h3>
          <div style="flex:1"></div>
          <button class="btn small ghost" data-flip title="Flip camera">🔄</button>
          <button class="btn small ghost" data-close>✕</button>
        </div>
        <div class="m-b" style="padding:0">
          <div style="position:relative;background:#000">
            <video autoplay playsinline muted style="width:100%;display:block;max-height:60vh;object-fit:cover"></video>
            <div style="position:absolute;inset:18% 12%;border:2px solid #22d3ee;border-radius:14px;pointer-events:none;box-shadow:0 0 0 9999px rgba(0,0,0,.35)"></div>
          </div>
          <div class="muted" style="padding:10px 14px" data-status>Point the camera at a barcode…</div>
          <div class="muted" style="padding:0 14px 10px;font-size:11px">Formats: ${formats.join(', ')}</div>
        </div>
      </div>`;
    document.getElementById('modal-root').appendChild(back);

    const video = back.querySelector('video');
    const status = back.querySelector('[data-status]');
    let stream = null;
    let raf = 0;
    let facingMode = opts.facingMode || 'environment';

    const cleanup = () => {
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      back.remove();
    };
    const cancel = () => { cleanup(); reject(new Error('cancelled')); };
    back.querySelector('[data-close]').addEventListener('click', cancel);
    back.addEventListener('click', (e) => { if (e.target === back) cancel(); });

    const startCamera = async () => {
      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facingMode } }, audio: false
        });
        video.srcObject = stream;
        await video.play();
      } catch (e) {
        status.textContent = 'Camera error: ' + e.message;
        setTimeout(() => { cleanup(); reject(e); }, 1500);
      }
    };

    back.querySelector('[data-flip]').addEventListener('click', async () => {
      facingMode = facingMode === 'environment' ? 'user' : 'environment';
      await startCamera();
    });

    await startCamera();
    let lastAttempt = 0;
    const tick = async (ts) => {
      if (ts - lastAttempt > 150 && video.readyState >= 2) {
        lastAttempt = ts;
        try {
          const codes = await detector.detect(video);
          if (codes && codes.length) {
            const c = codes[0];
            status.textContent = `${c.format}: ${c.rawValue}`;
            cleanup();
            resolve({ value: c.rawValue, format: c.format });
            return;
          }
        } catch { /* keep scanning */ }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });
}
