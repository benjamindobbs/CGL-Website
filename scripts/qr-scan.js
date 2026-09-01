// Camera QR scanner overlay. Load scripts/vendor/jsQR.min.js before this file.
//
//   scanQr()
//     .then((text) => { /* decoded string */ })
//     .catch((err) => { /* err.reason: 'cancel' | 'denied' | 'nocamera' | 'unsupported' */ });
//
// Opens a full-screen camera view, decodes ~10x/sec, resolves on the first hit.
// Needs a secure context (HTTPS or localhost) for camera access.
(function () {
    const DECODE_INTERVAL_MS = 100;
    const MAX_EDGE = 640; // downscale frames before decoding for phone perf

    function scanQr() {
        return new Promise((resolve, reject) => {
            const gum = navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
            if (!gum) {
                reject({ reason: 'unsupported', message: 'This browser cannot use the camera.' });
                return;
            }
            if (typeof jsQR !== 'function') {
                reject({ reason: 'unsupported', message: 'QR scanner failed to load. Refresh and try again.' });
                return;
            }

            const overlay = document.createElement('div');
            overlay.className = 'qr-scan-overlay';
            overlay.innerHTML =
                '<div class="qr-scan-box">' +
                '  <div class="qr-scan-frame">' +
                '    <video class="qr-scan-video" playsinline muted></video>' +
                '    <div class="qr-scan-reticle"></div>' +
                '  </div>' +
                '  <p class="qr-scan-hint">Point the camera at the item’s QR code</p>' +
                '  <button type="button" class="qr-scan-cancel secondary-btn">Cancel</button>' +
                '</div>';
            document.body.appendChild(overlay);

            const video = overlay.querySelector('.qr-scan-video');
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d', { willReadFrequently: true });

            let stream = null;
            let timer = null;
            let done = false;

            function cleanup() {
                done = true;
                if (timer) clearTimeout(timer);
                document.removeEventListener('keydown', onKey);
                if (stream) stream.getTracks().forEach((t) => t.stop());
                overlay.remove();
            }
            function finish(text) {
                if (done) return;
                cleanup();
                resolve(text);
            }
            function fail(reason, message) {
                if (done) return;
                cleanup();
                reject({ reason, message });
            }
            function onKey(e) {
                if (e.key === 'Escape') fail('cancel', 'Scan cancelled.');
            }

            overlay.querySelector('.qr-scan-cancel').addEventListener('click', () => fail('cancel', 'Scan cancelled.'));
            document.addEventListener('keydown', onKey);

            function tick() {
                if (done) return;
                const w = video.videoWidth;
                const h = video.videoHeight;
                if (video.readyState === video.HAVE_ENOUGH_DATA && w && h) {
                    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
                    const cw = Math.round(w * scale);
                    const ch = Math.round(h * scale);
                    canvas.width = cw;
                    canvas.height = ch;
                    ctx.drawImage(video, 0, 0, cw, ch);
                    let img = null;
                    try {
                        img = ctx.getImageData(0, 0, cw, ch);
                    } catch (e) {
                        img = null; // tainted canvas — shouldn't happen with a camera stream
                    }
                    if (img) {
                        const result = jsQR(img.data, cw, ch, { inversionAttempts: 'dontInvert' });
                        if (result && result.data && result.data.trim()) {
                            finish(result.data.trim());
                            return;
                        }
                    }
                }
                timer = setTimeout(tick, DECODE_INTERVAL_MS);
            }

            Promise.resolve(
                navigator.mediaDevices.getUserMedia({
                    video: { facingMode: { ideal: 'environment' } },
                    audio: false,
                })
            )
                .then((s) => {
                    if (done) {
                        s.getTracks().forEach((t) => t.stop());
                        return null;
                    }
                    stream = s;
                    video.srcObject = s;
                    return video.play();
                })
                .then(() => {
                    if (!done) timer = setTimeout(tick, DECODE_INTERVAL_MS);
                })
                .catch((err) => {
                    const name = err && err.name;
                    if (name === 'NotAllowedError' || name === 'SecurityError') {
                        fail('denied', 'Camera permission was denied. Allow camera access and try again.');
                    } else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') {
                        fail('nocamera', 'No usable camera was found.');
                    } else {
                        fail('nocamera', (err && err.message) || 'Could not start the camera.');
                    }
                });
        });
    }

    window.scanQr = scanQr;
})();
