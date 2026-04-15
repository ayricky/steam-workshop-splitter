/* ═══════════════════════════════════════════════════════════════
   Steam Workshop GIF Splitter
   ═══════════════════════════════════════════════════════════════ */

// Polyfill
if (typeof CanvasRenderingContext2D !== 'undefined' &&
    !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
        r = typeof r === 'number' ? r : 0;
        this.moveTo(x + r, y);
        this.arcTo(x + w, y, x + w, y + h, r);
        this.arcTo(x + w, y + h, x, y + h, r);
        this.arcTo(x, y + h, x, y, r);
        this.arcTo(x, y, x + w, y, r);
        this.closePath(); return this;
    };
}

// ── State ──────────────────────────────────────────────────────
let uploadedFile = null, currentJobId = null, pollInterval = null;
let animFrame = null, sourceEl = null;
let trimStart = 0, trimEnd = 0, videoDuration = 0;
let lastDrawTime = 0, isDraggingTrim = false;
let preprocessPollInterval = null, activePreprocessId = null;
let exactEstimateCache = new Map(), estimateCalibration = null;
let estimateDebounce = null, estimateRequestSeq = 0;
// Crop state (normalized 0-1 relative to source)
let cropX = 0, cropY = 0, cropW = 1, cropH = 1;
// Skip zones (array of {id, start, end} in seconds)
let skipZones = [], skipZoneId = 0, activeSkipZoneId = null;

// ── DOM ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const dropZone = $('drop-zone'), fileInput = $('file-input');
const workspace = $('workspace'), processBtn = $('process-btn');
const panelW = $('panel-width'), panelH = $('panel-height');
const fpsSlider = $('fps-slider'), colorsSldr = $('colors-slider'), speedSldr = $('speed-slider');
const fpsVal = $('fps-value'), colorsVal = $('colors-value'), speedVal = $('speed-value');
const totalDim = $('total-dimensions');
const maxSizeEl = $('max-size');
const preprocessBtn = $('preprocess-btn'), preprocessStatus = $('preprocess-status');
const canvas = $('split-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const PANELS = 5, STEAM_GAP = 4;

// ══════════════════════════════════════════════════════════════
//  UPLOAD
// ══════════════════════════════════════════════════════════════
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', handleFile);
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) { fileInput.files = e.dataTransfer.files; handleFile(); }
});

async function handleFile() {
    const file = fileInput.files[0];
    if (!file) return;
    $('upload-content').innerHTML = `<div class="spinner"></div><p style="margin-top:10px">Uploading...</p>`;
    const form = new FormData(); form.append('file', file);
    try {
        const res = await fetch('/upload', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        uploadedFile = data;
        resetExactMetrics();
        setPreprocessStatus('');
        openWorkspace(data);
    } catch (e) { alert('Upload failed: ' + e.message); resetUpload(); }
}

function resetUpload() {
    $('upload-content').innerHTML = `
        <p>Drop a GIF or video here, or <span class="link">browse</span></p>
        <small>mp4 webm avi mov mkv gif</small>`;
}

// ══════════════════════════════════════════════════════════════
//  WORKSPACE
// ══════════════════════════════════════════════════════════════
function openWorkspace(data) {
    $('landing').style.display = 'none';
    workspace.style.display = '';

    $('fb-name').textContent = data.filename;
    const bits = [`${data.width}x${data.height}`, data.size_human, `${data.duration}s`];
    if (data.fps) bits.push(`${data.fps} FPS`);
    $('fb-meta').textContent = bits.join('  ·  ');

    $('change-file-btn').onclick = () => {
        stopPreviewLoop();
        stopPreprocessPolling();
        resetExactMetrics();
        setPreprocessStatus('');
        workspace.style.display = 'none';
        $('landing').style.display = '';
        resetUpload();
        $('results-section').style.display = 'none';
        resetBtn();
    };

    // Reset skip zones
    skipZones = []; skipZoneId = 0; activeSkipZoneId = null;

    const box = $('preview-media');
    if (data.is_video) {
        box.innerHTML = `<video id="src-el" muted playsinline
            src="/uploaded/${data.saved_filename}"></video>`;
        sourceEl = $('src-el');
        sourceEl.addEventListener('play', () => {
            $('pp-play').style.display = 'none';
            $('pp-pause').style.display = '';
        });
        sourceEl.addEventListener('pause', () => {
            $('pp-play').style.display = '';
            $('pp-pause').style.display = 'none';
        });
        sourceEl.addEventListener('loadedmetadata', () => {
            videoDuration = sourceEl.duration;
            trimStart = 0; trimEnd = videoDuration;
            // Reset speed slider and preview playback rate
            speedSldr.value = 1; speedVal.textContent = '1x';
            if ($('speed-hint')) $('speed-hint').textContent = '1x \u2014 original speed';
            sourceEl.playbackRate = 1;
            initTrimBar();
            sourceEl.play();
            initCropBox();
            startPreviewLoop();
            updateEstimate();
        });
        $('trim-section').style.display = '';
        $('trim-section-gif').style.display = 'none';
    } else {
        box.innerHTML = `<img id="src-el" src="/uploaded/${data.saved_filename}">`;
        sourceEl = $('src-el');
        sourceEl.addEventListener('load', () => {
            initCropBox();
            startPreviewLoop();
            updateEstimate();
        }, { once: true });
        $('trim-section').style.display = 'none';
        $('trim-section-gif').style.display = '';
        $('start-time').value = 0;
        $('end-time').value = data.duration;
    }

    if (data.fps) {
        fpsSlider.value = Math.min(Math.round(data.fps), 24);
        fpsVal.textContent = fpsSlider.value;
    }

    // Reset crop to full frame
    cropX = 0; cropY = 0; cropW = 1; cropH = 1;
    autoMatchRatio(data.width, data.height);

    $('results-section').style.display = 'none';
    $('processing-section').style.display = 'none';
    resetBtn(); updateEstimate();
}

function autoMatchRatio(srcW, srcH) {
    const pw = parseInt(panelW.value) || 122;
    const newH = Math.round((pw * PANELS) * (srcH / srcW));
    panelH.value = Math.max(50, Math.min(500, newH));
    updateDims();
}

// ══════════════════════════════════════════════════════════════
//  CROP BOX (4-edge + body drag)
// ══════════════════════════════════════════════════════════════
function initCropBox() {
    const box = $('crop-box');
    if (!sourceEl || !box) return;

    cropX = 0; cropY = 0; cropW = 1; cropH = 1;
    updateCropBox();

    let mode = null, mx0 = 0, my0 = 0;
    let cx0 = 0, cy0 = 0, cw0 = 0, ch0 = 0;

    const down = (e, m) => {
        e.preventDefault(); e.stopPropagation();
        mode = m;
        const pt = e.touches ? e.touches[0] : e;
        mx0 = pt.clientX; my0 = pt.clientY;
        cx0 = cropX; cy0 = cropY; cw0 = cropW; ch0 = cropH;
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('touchend', up);
    };

    const move = (e) => {
        e.preventDefault();
        const rect = $('crop-source').getBoundingClientRect();
        const pt = e.touches ? e.touches[0] : e;
        const dx = (pt.clientX - mx0) / rect.width;
        const dy = (pt.clientY - my0) / rect.height;

        if (mode === 'move') {
            cropX = clamp(cx0 + dx, 0, 1 - cropW);
            cropY = clamp(cy0 + dy, 0, 1 - cropH);
        } else if (mode === 'top') {
            const ny = clamp(cy0 + dy, 0, cy0 + ch0 - 0.05);
            cropH = ch0 - (ny - cy0); cropY = ny;
        } else if (mode === 'bottom') {
            cropH = clamp(ch0 + dy, 0.05, 1 - cropY);
        } else if (mode === 'left') {
            const nx = clamp(cx0 + dx, 0, cx0 + cw0 - 0.05);
            cropW = cw0 - (nx - cx0); cropX = nx;
        } else if (mode === 'right') {
            cropW = clamp(cw0 + dx, 0.05, 1 - cropX);
        }
        updateCropBox();
        updatePanelSizeFromCrop();
    };

    const up = () => {
        mode = null;
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.removeEventListener('touchmove', move);
        document.removeEventListener('touchend', up);
        updateEstimate();
    };

    // Body drag
    box.addEventListener('mousedown', e => {
        if (e.target.dataset.edge) return;
        down(e, 'move');
    });
    box.addEventListener('touchstart', e => {
        if (e.target.dataset.edge) return;
        down(e, 'move');
    }, { passive: false });

    // Edge drags
    box.querySelectorAll('.crop-edge').forEach(edge => {
        const handler = e => down(e, edge.dataset.edge);
        edge.addEventListener('mousedown', handler);
        edge.addEventListener('touchstart', handler, { passive: false });
    });
}

function updateCropBox() {
    const box = $('crop-box');
    if (!box) return;
    box.style.left   = (cropX * 100) + '%';
    box.style.top    = (cropY * 100) + '%';
    box.style.width  = (cropW * 100) + '%';
    box.style.height = (cropH * 100) + '%';

    // Info text
    if (sourceEl) {
        const srcW = sourceEl.videoWidth || sourceEl.naturalWidth || 1;
        const srcH = sourceEl.videoHeight || sourceEl.naturalHeight || 1;
        const cw = Math.round(srcW * cropW);
        const ch = Math.round(srcH * cropH);
        const pw = Math.round(122 * (cw / srcW) / (cropW)); // just use panelW
        const outW = parseInt(panelW.value) || 122;
        const outH = Math.round((outW * PANELS) * (ch / cw));
        $('crop-info').textContent = `${outW} x ${clamp(outH, 50, 500)}`;
    }
}

function updatePanelSizeFromCrop() {
    if (!sourceEl) return;
    const srcW = sourceEl.videoWidth || sourceEl.naturalWidth || 1;
    const srcH = sourceEl.videoHeight || sourceEl.naturalHeight || 1;
    const croppedW = srcW * cropW;
    const croppedH = srcH * cropH;

    // Keep width at current value, calculate height from cropped aspect ratio
    const pw = parseInt(panelW.value) || 122;
    const newH = Math.round((pw * PANELS) * (croppedH / croppedW));
    panelH.value = clamp(newH, 50, 500);
    updateDims();
}

// ══════════════════════════════════════════════════════════════
//  TRIM BAR
// ══════════════════════════════════════════════════════════════
function initTrimBar() {
    updateTrimUI();
    initPlayheadDrag();
    makeTrimHandle($('trim-handle-start'), pct => {
        trimStart = Math.max(0, Math.min(pct * videoDuration, trimEnd - 0.1));
        clampSkipZones();
        updateTrimUI(); updateEstimate();
        sourceEl.currentTime = trimStart;
    });
    makeTrimHandle($('trim-handle-end'), pct => {
        trimEnd = Math.min(videoDuration, Math.max(pct * videoDuration, trimStart + 0.1));
        clampSkipZones();
        updateTrimUI(); updateEstimate();
        sourceEl.currentTime = trimEnd;
    });
    $('trim-track').addEventListener('click', e => {
        if (e.target.classList.contains('trim-handle') || e.target.closest('.skip-zone') || e.target.id === 'trim-playhead') return;
        const rect = $('trim-track').getBoundingClientRect();
        sourceEl.currentTime = clamp((e.clientX - rect.left) / rect.width, 0, 1) * videoDuration;
    });
    // Skip-zone + trim-loop enforcement moved to the 60fps rAF loop
    // (enforcePlaybackBounds) so we never show stale frames.
    // Restart when video reaches its natural end (no loop attr)
    sourceEl.addEventListener('ended', () => {
        sourceEl.currentTime = trimStart;
        sourceEl.play();
    });
}

function makeTrimHandle(handle, onMove) {
    let dragging = false, wasPlaying = false;
    const start = e => {
        e.preventDefault(); dragging = true; isDraggingTrim = true;
        handle.classList.add('dragging');
        wasPlaying = sourceEl && !sourceEl.paused;
        if (wasPlaying) sourceEl.pause();
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', stop);
        document.addEventListener('touchmove', move, { passive: false });
        document.addEventListener('touchend', stop);
    };
    const move = e => {
        if (!dragging) return; e.preventDefault();
        const rect = $('trim-track').getBoundingClientRect();
        const cx = e.touches ? e.touches[0].clientX : e.clientX;
        onMove(clamp((cx - rect.left) / rect.width, 0, 1));
    };
    const stop = () => {
        dragging = false; isDraggingTrim = false;
        handle.classList.remove('dragging');
        if (wasPlaying) { sourceEl.currentTime = trimStart; sourceEl.play(); }
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', stop);
        document.removeEventListener('touchmove', move);
        document.removeEventListener('touchend', stop);
    };
    handle.addEventListener('mousedown', start);
    handle.addEventListener('touchstart', start, { passive: false });
}

function updateTrimUI() {
    if (!videoDuration) return;
    const sp = (trimStart / videoDuration) * 100;
    const ep = (trimEnd / videoDuration) * 100;
    $('trim-range').style.left = sp + '%';
    $('trim-range').style.width = (ep - sp) + '%';
    $('trim-handle-start').style.left = `calc(${sp}% - 5px)`;
    $('trim-handle-end').style.left = `calc(${ep}% - 5px)`;
    $('trim-start-label').textContent = trimStart.toFixed(1) + 's';
    $('trim-end-label').textContent = trimEnd.toFixed(1) + 's';
}

function updatePlayhead() {
    if (!videoDuration || !sourceEl) return;
    const t = sourceEl.currentTime || 0;
    $('trim-playhead').style.left = (t / videoDuration) * 100 + '%';
    const tt = $('transport-time');
    if (tt) tt.textContent = t.toFixed(1) + 's / ' + (trimEnd || videoDuration).toFixed(1) + 's';
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── Playhead drag (scrub) ─────────────────────────────────────
function initPlayheadDrag() {
    const ph = $('trim-playhead');
    if (!ph) return;
    let wasPlaying = false;
    const start = e => {
        e.preventDefault(); e.stopPropagation();
        wasPlaying = sourceEl && !sourceEl.paused;
        if (wasPlaying) sourceEl.pause();
        isDraggingTrim = true;
        ph.classList.add('dragging');
        const doMove = e2 => {
            e2.preventDefault();
            const rect = $('trim-track').getBoundingClientRect();
            const cx = (e2.touches ? e2.touches[0] : e2).clientX;
            const t = clamp((cx - rect.left) / rect.width, 0, 1) * videoDuration;
            sourceEl.currentTime = clamp(t, trimStart, trimEnd);
        };
        const doStop = () => {
            isDraggingTrim = false;
            ph.classList.remove('dragging');
            if (wasPlaying) sourceEl.play();
            document.removeEventListener('mousemove', doMove);
            document.removeEventListener('mouseup', doStop);
            document.removeEventListener('touchmove', doMove);
            document.removeEventListener('touchend', doStop);
        };
        document.addEventListener('mousemove', doMove);
        document.addEventListener('mouseup', doStop);
        document.addEventListener('touchmove', doMove, { passive: false });
        document.addEventListener('touchend', doStop);
    };
    ph.addEventListener('mousedown', start);
    ph.addEventListener('touchstart', start, { passive: false });
}

// ══════════════════════════════════════════════════════════════
//  SKIP ZONES  (selectable — click to pick, skip in/out edits it)
// ══════════════════════════════════════════════════════════════
function addSkipZone() {
    if (!videoDuration) return;
    const mid = (trimStart + trimEnd) / 2;
    const span = Math.max(0.2, (trimEnd - trimStart) * 0.1);
    const newId = skipZoneId++;
    skipZones.push({ id: newId, start: mid - span / 2, end: mid + span / 2 });
    activeSkipZoneId = newId;   // auto-select the new zone
    renderSkipZones();
    updateEstimate();
}

function removeSkipZone(id) {
    skipZones = skipZones.filter(z => z.id !== id);
    if (activeSkipZoneId === id) activeSkipZoneId = skipZones.length ? skipZones[skipZones.length - 1].id : null;
    renderSkipZones();
    updateEstimate();
}

function selectSkipZone(id) {
    activeSkipZoneId = (activeSkipZoneId === id) ? null : id;
    renderSkipZones();
}

/** Return the zone that skip-in / skip-out should operate on. */
function getActiveSkipZone() {
    if (activeSkipZoneId !== null) {
        const z = skipZones.find(z => z.id === activeSkipZoneId);
        if (z) return z;
    }
    return skipZones.length ? skipZones[skipZones.length - 1] : null;
}

function clampSkipZones() {
    skipZones = skipZones.filter(z => z.end > trimStart && z.start < trimEnd);
    if (activeSkipZoneId !== null && !skipZones.find(z => z.id === activeSkipZoneId)) activeSkipZoneId = null;
    skipZones.forEach(z => {
        z.start = Math.max(z.start, trimStart);
        z.end = Math.min(z.end, trimEnd);
    });
    renderSkipZones();
}

function renderSkipZones() {
    document.querySelectorAll('.skip-zone').forEach(el => el.remove());
    if (!videoDuration) return;
    const track = $('trim-track');

    skipZones.forEach((zone, idx) => {
        const left = (zone.start / videoDuration) * 100;
        const width = ((zone.end - zone.start) / videoDuration) * 100;

        const el = document.createElement('div');
        el.className = 'skip-zone' + (zone.id === activeSkipZoneId ? ' active' : '');
        el.style.left = left + '%';
        el.style.width = width + '%';

        // Label badge showing zone number
        const badge = document.createElement('span');
        badge.className = 'skip-badge';
        badge.textContent = idx + 1;
        el.appendChild(badge);

        el.innerHTML += '<div class="skip-handle skip-handle-l"></div><div class="skip-handle skip-handle-r"></div>';

        el.addEventListener('dblclick', e => { e.stopPropagation(); removeSkipZone(zone.id); });

        // Body drag — move the whole skip zone; click (no move) → select
        const bodyDrag = e => {
            if (e.target.closest('.skip-handle')) return;
            e.preventDefault(); e.stopPropagation();
            const rect = track.getBoundingClientRect();
            const startX = (e.touches ? e.touches[0] : e).clientX;
            const origStart = zone.start, origEnd = zone.end, span = origEnd - origStart;
            let moved = false;
            const doMove = e2 => {
                e2.preventDefault();
                const cx = (e2.touches ? e2.touches[0] : e2).clientX;
                if (!moved && Math.abs(cx - startX) < 4) return;
                moved = true;
                const dt = ((cx - startX) / rect.width) * videoDuration;
                let ns = origStart + dt, ne = origEnd + dt;
                if (ns < trimStart) { ns = trimStart; ne = trimStart + span; }
                if (ne > trimEnd)   { ne = trimEnd;   ns = trimEnd - span;   }
                zone.start = ns; zone.end = ne;
                renderSkipZones();
            };
            const doStop = () => {
                document.removeEventListener('mousemove', doMove);
                document.removeEventListener('mouseup', doStop);
                document.removeEventListener('touchmove', doMove);
                document.removeEventListener('touchend', doStop);
                if (!moved) selectSkipZone(zone.id);
                updateEstimate();
            };
            document.addEventListener('mousemove', doMove);
            document.addEventListener('mouseup', doStop);
            document.addEventListener('touchmove', doMove, { passive: false });
            document.addEventListener('touchend', doStop);
        };
        el.addEventListener('mousedown', bodyDrag);
        el.addEventListener('touchstart', bodyDrag, { passive: false });

        makeSkipHandle(el.querySelector('.skip-handle-l'), zone, 'left');
        makeSkipHandle(el.querySelector('.skip-handle-r'), zone, 'right');

        track.appendChild(el);
    });

    updateSkipInfo();
}

function makeSkipHandle(handle, zone, side) {
    const start = e => {
        e.preventDefault(); e.stopPropagation();
        activeSkipZoneId = zone.id;  // auto-select when dragging a handle
        const doMove = e2 => {
            e2.preventDefault();
            const rect = $('trim-track').getBoundingClientRect();
            const cx = e2.touches ? e2.touches[0].clientX : e2.clientX;
            const t = clamp((cx - rect.left) / rect.width, 0, 1) * videoDuration;
            if (side === 'left') zone.start = clamp(t, trimStart, zone.end - 0.05);
            else zone.end = clamp(t, zone.start + 0.05, trimEnd);
            renderSkipZones();
        };
        const doStop = () => {
            document.removeEventListener('mousemove', doMove);
            document.removeEventListener('mouseup', doStop);
            document.removeEventListener('touchmove', doMove);
            document.removeEventListener('touchend', doStop);
            updateEstimate();
        };
        document.addEventListener('mousemove', doMove);
        document.addEventListener('mouseup', doStop);
        document.addEventListener('touchmove', doMove, { passive: false });
        document.addEventListener('touchend', doStop);
    };
    handle.addEventListener('mousedown', start);
    handle.addEventListener('touchstart', start, { passive: false });
}

function updateSkipInfo() {
    const el = $('skip-info');
    if (!el) return;
    if (!skipZones.length) { el.textContent = ''; return; }
    const totalSkip = skipZones.reduce((s, z) => s + (z.end - z.start), 0);
    const activeIdx = skipZones.findIndex(z => z.id === activeSkipZoneId);
    const sel = activeIdx >= 0 ? ` · editing #${activeIdx + 1}` : '';
    el.textContent = `${skipZones.length} skip${skipZones.length > 1 ? 's' : ''}, ${totalSkip.toFixed(1)}s removed${sel} (click to select · dbl-click to delete)`;
}

// ══════════════════════════════════════════════════════════════
//  SPLIT PREVIEW (canvas, reads crop region from source)
// ══════════════════════════════════════════════════════════════

/** Called every rAF tick (~60fps). Jumps over skip zones and loops
 *  at trim boundaries so no black frames are ever visible. */
function enforcePlaybackBounds() {
    if (!sourceEl || isDraggingTrim || sourceEl.paused) return;
    const t = sourceEl.currentTime;
    // Jump over skip zones
    for (const zone of skipZones) {
        if (t >= zone.start && t < zone.end) {
            sourceEl.currentTime = zone.end;
            return;
        }
    }
    // Loop at trim end
    if (t >= trimEnd) { sourceEl.currentTime = trimStart; }
}

function startPreviewLoop() {
    stopPreviewLoop(); lastDrawTime = 0;
    (function loop(now) {
        animFrame = requestAnimationFrame(loop);
        // Enforce skip / trim bounds at 60fps — no stale frames
        enforcePlaybackBounds();
        // Smooth playhead + time at full framerate
        updatePlayhead();
        // Draw split at target FPS
        const interval = 1000 / (parseInt(fpsSlider.value) || 15);
        if (now - lastDrawTime < interval) return;
        lastDrawTime = now;
        drawSplit();
    })(performance.now());
}
function stopPreviewLoop() { if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; } }

function drawSplit() {
    if (!sourceEl) return;
    const srcW = sourceEl.videoWidth || sourceEl.naturalWidth || 0;
    const srcH = sourceEl.videoHeight || sourceEl.naturalHeight || 0;
    if (!srcW || !srcH) return;

    const pw = parseInt(panelW.value) || 122;
    const ph = parseInt(panelH.value) || 300;
    const colors = parseInt(colorsSldr.value) || 256;
    const totalW = pw * PANELS, totalH = ph;
    const cW = totalW + (PANELS - 1) * STEAM_GAP, cH = totalH;
    canvas.width = cW; canvas.height = cH;

    // Source crop region (based on crop box)
    const sx = cropX * srcW;
    const sy = cropY * srcH;
    const sw = cropW * srcW;
    const sh = cropH * srcH;

    // Cover-fit the cropped region into totalW x totalH
    const scale = Math.max(totalW / sw, totalH / sh);
    const dW = sw * scale, dH = sh * scale;
    const ox = (totalW - dW) / 2;
    const oy = (totalH - dH) / 2;

    ctx.fillStyle = '#1b2838';
    ctx.fillRect(0, 0, cW, cH);

    for (let i = 0; i < PANELS; i++) {
        const panelX = i * (pw + STEAM_GAP);
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(panelX, 0, pw, cH, 2);
        ctx.clip();
        ctx.fillStyle = '#000';
        ctx.fillRect(panelX, 0, pw, cH);
        // drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh)
        ctx.drawImage(sourceEl, sx, sy, sw, sh,
            ox - (i * pw) + panelX, oy, dW, dH);
        ctx.restore();
    }

    if (colors < 256) {
        const levels = Math.max(2, Math.round(Math.pow(colors, 1 / 3)));
        const step = 255 / (levels - 1);
        const imgData = ctx.getImageData(0, 0, cW, cH);
        const d = imgData.data;
        for (let j = 0; j < d.length; j += 4) {
            d[j] = Math.round(d[j] / step) * step;
            d[j+1] = Math.round(d[j+1] / step) * step;
            d[j+2] = Math.round(d[j+2] / step) * step;
        }
        ctx.putImageData(imgData, 0, 0);
    }
}

// ══════════════════════════════════════════════════════════════
//  ESTIMATE
// ══════════════════════════════════════════════════════════════
function currentTiming() {
    if (!uploadedFile) return { start: 0, end: 0, duration: 0 };
    let start, end;
    if (uploadedFile.is_video) {
        end = trimEnd || uploadedFile.duration || 0;
        start = trimStart;
    } else {
        start = parseFloat($('start-time')?.value) || 0;
        end = parseFloat($('end-time')?.value) || uploadedFile.duration || 0;
    }
    // Subtract overlapping skip zone durations
    let skipDur = 0;
    for (const z of skipZones) {
        const os = Math.max(z.start, start);
        const oe = Math.min(z.end, end);
        if (oe > os) skipDur += oe - os;
    }
    return { start, end, duration: Math.max(0.1, end - start - skipDur) };
}

function currentProcessSettings() {
    if (!uploadedFile) return null;
    const timing = currentTiming();
    return {
        file_id: uploadedFile.file_id,
        saved_filename: uploadedFile.saved_filename,
        start_time: timing.start,
        end_time: timing.end,
        fps: parseInt(fpsSlider.value) || 15,
        colors: parseInt(colorsSldr.value) || 256,
        panel_width: parseInt(panelW.value) || 122,
        panel_height: parseInt(panelH.value) || 300,
        max_file_size: parseInt(maxSizeEl.value) || 5242880,
        speed: parseFloat(speedSldr.value) || 1,
        crop_x: cropX,
        crop_y: cropY,
        crop_w: cropW,
        crop_h: cropH,
        skip_ranges: skipZones.map(z => [z.start, z.end]),
    };
}

function estimateKey(settings) {
    return [
        settings.saved_filename,
        settings.start_time.toFixed(2),
        settings.end_time.toFixed(2),
        settings.fps,
        settings.speed,
        settings.colors,
        settings.panel_width,
        settings.panel_height,
        settings.max_file_size,
        settings.crop_x.toFixed(4),
        settings.crop_y.toFixed(4),
        settings.crop_w.toFixed(4),
        settings.crop_h.toFixed(4),
        JSON.stringify(settings.skip_ranges),
    ].join('|');
}

function estimatedFrameCount(duration, fps) {
    if (!uploadedFile) return Math.max(1, Math.floor(duration * fps));
    if (uploadedFile.is_video) return Math.max(1, Math.floor(duration * fps));

    const totalDuration = Math.max(0.1, uploadedFile.duration || duration);
    const sourceFrames = Math.max(1, uploadedFile.frame_count || Math.round(totalDuration * (uploadedFile.fps || fps)));
    const sourceFps = uploadedFile.fps || (sourceFrames / totalDuration) || fps;
    let frames = Math.max(1, Math.round(sourceFrames * Math.min(1, duration / totalDuration)));

    // The backend only drops GIF frames when the requested FPS is lower than
    // the source FPS. It does not duplicate GIF frames for higher FPS values.
    if (fps < sourceFps) {
        const step = Math.max(1, Math.round(sourceFps / fps));
        frames = Math.max(1, Math.ceil(frames / step));
    }
    return frames;
}

function roughPanelEstimate(pw, ph, colors, numFrames) {
    const bpp = Math.log2(Math.max(2, colors));
    const rawFrame = (pw * ph * bpp) / 8;
    const comp = 0.20 + (colors / 256) * 0.20;
    return (rawFrame * comp + 30) * numFrames + colors * 3 + 800;
}

function resetExactMetrics() {
    exactEstimateCache = new Map();
    estimateCalibration = null;
    if (estimateDebounce) clearTimeout(estimateDebounce);
    estimateDebounce = null;
    estimateRequestSeq++;
}

function roughEstimateForSettings(settings, duration) {
    const speed = settings.speed || 1;
    const frames = estimatedFrameCount(duration / speed, settings.fps);
    return {
        frames,
        bytes: roughPanelEstimate(settings.panel_width, settings.panel_height, settings.colors, frames),
    };
}

function cacheExactEstimate(key, data, settings) {
    exactEstimateCache.set(key, data);

    const duration = data.duration || currentTiming().duration;
    const rough = roughEstimateForSettings(settings, duration);
    if (rough.bytes > 0 && data.estimate_bytes > 0) {
        estimateCalibration = {
            file: settings.saved_filename,
            ratio: clamp(data.estimate_bytes / rough.bytes, 0.15, 8),
        };
    }
}

function calibratedEstimate(settings, roughBytes) {
    if (!estimateCalibration || estimateCalibration.file !== settings.saved_filename) return null;
    return Math.round(roughBytes * estimateCalibration.ratio);
}

function scheduleExactEstimate(settings, key) {
    if (!estimateCalibration || activePreprocessId || exactEstimateCache.has(key)) return;
    if (estimateDebounce) clearTimeout(estimateDebounce);
    setPreprocessStatus('Exact metrics queued...');
    estimateDebounce = setTimeout(() => requestExactEstimate(settings, key), 750);
}

async function requestExactEstimate(settings, key) {
    const seq = ++estimateRequestSeq;
    setPreprocessStatus('Calculating exact metrics...');

    try {
        const res = await fetch('/estimate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Exact metrics failed');

        cacheExactEstimate(key, data, settings);
        const current = currentProcessSettings();
        if (seq !== estimateRequestSeq || !current || estimateKey(current) !== key) return;

        updateEstimate();
        setPreprocessStatus(data.cached ? 'Exact metrics ready (cached)' : 'Exact metrics ready');
    } catch (e) {
        if (seq !== estimateRequestSeq) return;
        setPreprocessStatus(e.message, true);
    }
}

function setPreprocessStatus(text, isError = false) {
    if (!preprocessStatus) return;
    preprocessStatus.textContent = text;
    preprocessStatus.style.color = isError ? 'var(--red)' : '';
}

function stopPreprocessPolling() {
    if (preprocessPollInterval) clearInterval(preprocessPollInterval);
    preprocessPollInterval = null;
    activePreprocessId = null;
}

function exactMetricsLabel(data, settings) {
    const labels = [data.cached ? 'cached exact' : 'exact'];
    if (data.largest_panel) labels.push(`P${data.largest_panel} largest`);
    return labels.join(' · ');
}

async function startPreprocessMetrics() {
    if (!uploadedFile || !preprocessBtn) return;

    const settings = currentProcessSettings();
    const key = estimateKey(settings);
    stopPreprocessPolling();
    if (estimateDebounce) clearTimeout(estimateDebounce);
    estimateDebounce = null;
    estimateRequestSeq++;
    preprocessBtn.disabled = true;
    preprocessBtn.textContent = 'Preprocessing...';
    setPreprocessStatus('Starting full pass...');

    try {
        const res = await fetch('/preprocess', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Preprocess failed');
        activePreprocessId = data.preprocess_id;
        preprocessPollInterval = setInterval(() => pollPreprocessMetrics(key, settings), 1000);
        pollPreprocessMetrics(key, settings);
    } catch (e) {
        preprocessBtn.disabled = false;
        preprocessBtn.textContent = 'Preprocess metrics';
        setPreprocessStatus(e.message, true);
    }
}

async function pollPreprocessMetrics(key, settings) {
    if (!activePreprocessId) return;

    try {
        const res = await fetch(`/preprocess-status/${activePreprocessId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Preprocess failed');

        setPreprocessStatus(data.step || 'Preprocessing...');

        if (data.status === 'complete') {
            stopPreprocessPolling();
            preprocessBtn.disabled = false;
            preprocessBtn.textContent = 'Reprocess metrics';

            const current = currentProcessSettings();
            if (current && estimateKey(current) === key) {
                cacheExactEstimate(key, data.result, current);
                updateEstimate();
                setPreprocessStatus('Exact metrics ready');
            } else {
                cacheExactEstimate(key, data.result, settings);
                setPreprocessStatus('Settings changed. Run metrics again.');
            }
        } else if (data.status === 'error') {
            stopPreprocessPolling();
            preprocessBtn.disabled = false;
            preprocessBtn.textContent = 'Preprocess metrics';
            setPreprocessStatus(data.error || 'Preprocess failed', true);
        }
    } catch (e) {
        stopPreprocessPolling();
        preprocessBtn.disabled = false;
        preprocessBtn.textContent = 'Preprocess metrics';
        setPreprocessStatus(e.message, true);
    }
}

function renderEstimate(duration, numFrames, est, limit, sourceLabel, sizeLabel = 'Est. per panel', exactData = null) {
    const el = $('estimate-display');
    const pct = Math.min(100, (est / limit) * 100);
    const ok = est <= limit;
    const bar = pct < 60 ? 'var(--green)' : pct < 90 ? 'var(--yellow)' : 'var(--red)';
    const avgRow = exactData && exactData.average_bytes
        ? `<div class="est-row"><span class="est-label">Avg. panel</span><span class="est-val">${fmt(exactData.average_bytes)}</span></div>`
        : '';
    const panelList = exactData && Array.isArray(exactData.panel_sizes_human)
        ? `<div class="est-panel-list">${exactData.panel_sizes_human.map((size, i) => `<span>P${i + 1} ${size}</span>`).join('')}</div>`
        : '';
    const warnNote = !exactData && est > 0
        ? `<div class="est-warn">Projections typically overshoot actual size — hit <strong>Preprocess metrics</strong> for accurate numbers</div>`
        : '';
    el.innerHTML = `
        <div class="est-row"><span class="est-label">Duration</span><span class="est-val">${duration.toFixed(1)}s</span></div>
        <div class="est-row"><span class="est-label">Frames</span><span class="est-val">${numFrames}</span></div>
        <div class="est-row"><span class="est-label">${sizeLabel}</span><span class="est-val" style="color:${ok?'var(--green)':'var(--red)'}">${fmt(est)}</span></div>
        ${avgRow}
        <div class="est-bar-wrap"><div class="est-bar-track"><div class="est-bar-fill" style="width:${Math.min(pct,100)}%;background:${bar}"></div></div>
        <span class="est-bar-label" style="color:${ok?'':'var(--red)'}">${fmt(est)} / ${fmt(limit)} largest panel · ${sourceLabel}</span></div>
        ${panelList}
        ${warnNote}`;
}

function updateEstimate() {
    const el = $('estimate-display');
    if (!el || !uploadedFile) return;

    const settings = currentProcessSettings();
    const key = estimateKey(settings);
    const timing = currentTiming();
    const rough = roughEstimateForSettings(settings, timing.duration);
    let numFrames = rough.frames;
    let est = rough.bytes;
    let sourceLabel = 'rough';
    let sizeLabel = 'Est. per panel';
    let exactData = null;

    if (exactEstimateCache.has(key)) {
        exactData = exactEstimateCache.get(key);
        numFrames = exactData.frame_count || numFrames;
        est = exactData.estimate_bytes || est;
        sourceLabel = exactMetricsLabel(exactData, settings);
        sizeLabel = 'Largest panel';
    } else {
        const calibrated = calibratedEstimate(settings, rough.bytes);
        if (calibrated) {
            est = calibrated;
            sourceLabel = 'calibrated · exact pending';
            sizeLabel = 'Projected largest';
            scheduleExactEstimate(settings, key);
        }
    }

    const outputDuration = timing.duration / (settings.speed || 1);
    renderEstimate(outputDuration, numFrames, est, settings.max_file_size, sourceLabel, sizeLabel, exactData);
}

// ══════════════════════════════════════════════════════════════
//  FRAME-BY-FRAME & MARK POINTS
// ══════════════════════════════════════════════════════════════
function stepFrame(dir) {
    if (!sourceEl || !sourceEl.duration) return;
    if (!sourceEl.paused) sourceEl.pause();
    const fps = parseInt(fpsSlider.value) || 15;
    const step = 1.0 / fps;
    sourceEl.currentTime = clamp(sourceEl.currentTime + dir * step, 0, sourceEl.duration);
    updatePlayhead();
}

function frameDur() { return 1.0 / (parseInt(fpsSlider.value) || 15); }

function markTrimIn() {
    // "trim in" — exclude this frame, start keeping from the next one
    if (!sourceEl) return;
    trimStart = clamp(sourceEl.currentTime + frameDur(), 0, trimEnd - 0.1);
    clampSkipZones(); updateTrimUI(); updateEstimate();
}
function markTrimOut() {
    // "trim out" — exclude this frame, stop keeping before it
    if (!sourceEl) return;
    trimEnd = clamp(sourceEl.currentTime, trimStart + 0.1, videoDuration);
    clampSkipZones(); updateTrimUI(); updateEstimate();
}
function markSkipIn() {
    // "skip in" — start ignoring from this frame
    if (!sourceEl) return;
    if (!skipZones.length) { addSkipZone(); return; }
    const zone = getActiveSkipZone();
    if (!zone) return;
    zone.start = clamp(sourceEl.currentTime, trimStart, zone.end - 0.05);
    renderSkipZones(); updateEstimate();
}
function markSkipOut() {
    // "skip out" — this is the last frame to ignore
    if (!sourceEl) return;
    if (!skipZones.length) { addSkipZone(); return; }
    const zone = getActiveSkipZone();
    if (!zone) return;
    zone.end = clamp(sourceEl.currentTime + frameDur(), zone.start + 0.05, trimEnd);
    renderSkipZones(); updateEstimate();
}

// Keyboard shortcuts (only when not focused on inputs)
document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (!sourceEl || !sourceEl.duration) return;

    if (e.key === 'ArrowLeft') { e.preventDefault(); stepFrame(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepFrame(1); }
    else if (e.key === ' ') {
        e.preventDefault();
        if (sourceEl.paused) sourceEl.play(); else sourceEl.pause();
    }
    else if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        if (e.shiftKey) markSkipIn(); else markTrimIn();
    }
    else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        if (e.shiftKey) markSkipOut(); else markTrimOut();
    }
    else if (e.key === 'Escape') {
        if (activeSkipZoneId !== null) { activeSkipZoneId = null; renderSkipZones(); }
    }
});

// ══════════════════════════════════════════════════════════════
//  CONTROLS
// ══════════════════════════════════════════════════════════════
if (preprocessBtn) preprocessBtn.addEventListener('click', startPreprocessMetrics);
$('frame-back-btn').addEventListener('click', () => stepFrame(-1));
$('frame-fwd-btn').addEventListener('click', () => stepFrame(1));
$('play-pause-btn').addEventListener('click', () => {
    if (!sourceEl || !sourceEl.play) return;
    if (sourceEl.paused) sourceEl.play(); else sourceEl.pause();
});
$('mark-trim-in').addEventListener('click', markTrimIn);
$('mark-trim-out').addEventListener('click', markTrimOut);
$('mark-skip-in').addEventListener('click', markSkipIn);
$('mark-skip-out').addEventListener('click', markSkipOut);
$('add-skip-btn').addEventListener('click', addSkipZone);
$('auto-skip-black').addEventListener('click', autoSkipBlack);

async function autoSkipBlack() {
    if (!uploadedFile || !uploadedFile.is_video) return;
    const btn = $('auto-skip-black');
    btn.disabled = true;
    btn.textContent = 'scanning...';

    try {
        const res = await fetch('/detect-black', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ saved_filename: uploadedFile.saved_filename }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        if (!data.ranges || data.ranges.length === 0) {
            btn.textContent = 'none found';
            setTimeout(() => { btn.disabled = false; btn.textContent = 'auto-skip black'; }, 2000);
            return;
        }

        // Add each detected black range as a skip zone
        for (const [start, end] of data.ranges) {
            const newId = skipZoneId++;
            skipZones.push({ id: newId, start, end });
        }
        activeSkipZoneId = skipZones[skipZones.length - 1].id;
        clampSkipZones();
        renderSkipZones();
        updateEstimate();

        btn.textContent = data.ranges.length + ' found';
        setTimeout(() => { btn.disabled = false; btn.textContent = 'auto-skip black'; }, 2000);
    } catch (e) {
        btn.textContent = 'failed';
        console.error('auto-skip black:', e);
        setTimeout(() => { btn.disabled = false; btn.textContent = 'auto-skip black'; }, 2000);
    }
}
fpsSlider.addEventListener('input', () => { fpsVal.textContent = fpsSlider.value; updateEstimate(); lastDrawTime = 0; });

function fmtSpeed(v) {
    return parseFloat(v.toFixed(2)) + 'x';
}

speedSldr.addEventListener('input', () => {
    const v = parseFloat(speedSldr.value) || 1;
    speedVal.textContent = fmtSpeed(v);
    const hint = $('speed-hint');
    if (hint) {
        const pct = Math.round(Math.abs(1 - 1/v) * 100);
        if (v > 1) hint.textContent = fmtSpeed(v) + ' \u2014 ' + pct + '% fewer frames';
        else if (v < 1) hint.textContent = fmtSpeed(v) + ' \u2014 ' + Math.round((1/v - 1) * 100) + '% more frames';
        else hint.textContent = '1x \u2014 original speed';
    }
    // Preview at matching speed
    if (sourceEl && sourceEl.playbackRate !== undefined) sourceEl.playbackRate = v;
    updateEstimate();
});
colorsSldr.addEventListener('input', () => { colorsVal.textContent = colorsSldr.value; updateEstimate(); });

function updateDims() {
    const w = parseInt(panelW.value) || 122, h = parseInt(panelH.value) || 300;
    totalDim.textContent = `${w * 5} x ${h}`;
    updateEstimate(); updateCropBox();
}
panelW.addEventListener('input', updateDims);
panelH.addEventListener('input', updateDims);
if ($('start-time')) $('start-time').addEventListener('input', updateEstimate);
if ($('end-time')) $('end-time').addEventListener('input', updateEstimate);

$('match-ratio-btn').addEventListener('click', () => {
    if (!uploadedFile) return;
    cropX = 0; cropY = 0; cropW = 1; cropH = 1;
    autoMatchRatio(uploadedFile.width, uploadedFile.height);
    updateCropBox();
});

// ══════════════════════════════════════════════════════════════
//  PROCESS
// ══════════════════════════════════════════════════════════════
processBtn.addEventListener('click', startProcessing);

async function startProcessing() {
    if (!uploadedFile) return;
    processBtn.disabled = true;
    processBtn.innerHTML = '<span class="spinner"></span> Processing...';
    const body = currentProcessSettings();

    try {
        const res = await fetch('/process', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        currentJobId = data.job_id;
        showProcessing(); startPolling();
    } catch (e) { alert('Error: ' + e.message); resetBtn(); }
}

function resetBtn() { processBtn.disabled = false; processBtn.innerHTML = 'Split into 5 panels'; }
function showProcessing() {
    $('processing-section').style.display = '';
    $('progress-fill').style.width = '0';
    $('progress-text').textContent = 'Starting...';
    $('progress-percent').textContent = '0%';
    $('processing-section').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Polling
function startPolling() { pollInterval = setInterval(poll, 500); }
function stopPolling() { clearInterval(pollInterval); pollInterval = null; }
async function poll() {
    if (!currentJobId) return;
    try {
        const res = await fetch(`/status/${currentJobId}`);
        const d = await res.json();
        $('progress-fill').style.width = d.progress + '%';
        $('progress-text').textContent = d.step || '';
        $('progress-percent').textContent = d.progress + '%';
        if (d.status === 'complete') { stopPolling(); showResults(d.result); }
        else if (d.status === 'error') { stopPolling(); alert('Error: ' + d.error);
            $('processing-section').style.display = 'none'; resetBtn(); }
    } catch (e) { console.error(e); }
}

// ══════════════════════════════════════════════════════════════
//  RESULTS
// ══════════════════════════════════════════════════════════════
function showResults(result) {
    $('processing-section').style.display = 'none';
    resetBtn();
    const sec = $('results-section');
    sec.style.display = '';
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const total = result.panels.reduce((s, p) => s + p.size_bytes, 0);
    const ok = result.panels.every(p => p.within_limit);

    $('result-stats').innerHTML = `
        <span>Panels <strong>${result.panels.length}</strong></span>
        <span>Frames <strong>${result.total_frames}</strong></span>
        <span>Duration <strong>${result.duration}s</strong></span>
        <span>Total <strong>${fmt(total)}</strong></span>
        <span>Limit <strong style="color:${ok?'var(--green)':'var(--red)'}">${ok?'ok':'over'}</strong></span>`;

    const pw = parseInt(panelW.value) || 122, ph = parseInt(panelH.value) || 300;
    const sc = Math.min(1, 700 / (pw * 5 + 4 * STEAM_GAP));
    const t = Date.now();

    $('showcase-panels').innerHTML = result.panels.map(p =>
        `<div class="rp" style="width:${Math.round(pw*sc)}px;height:${Math.round(ph*sc)}px">
            <img class="panel-gif" data-src="/panel/${currentJobId}/${p.index}" src="/panel/${currentJobId}/${p.index}?t=${t}">
            <div class="rp-overlay">
                <span class="${p.within_limit?'sz-ok':'sz-over'}">${p.size_human}</span>
                <a href="/download-panel/${currentJobId}/${p.index}" download>download</a>
            </div>
        </div>`).join('');

    const resync = () => {
        const now = Date.now();
        document.querySelectorAll('.panel-gif').forEach(img => { img.src = img.dataset.src + '?t=' + now; });
    };
    $('resync-btn').onclick = resync;
    $('download-all-btn').onclick = () => { window.location.href = `/download/${currentJobId}`; };

    // Upload
    $('upload-result').style.display = 'none';
    $('upload-progress').style.display = 'none';
    const uploadBtn = $('upload-steam-btn');
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload to Steam';
    uploadBtn.onclick = async () => {
        uploadBtn.disabled = true; uploadBtn.textContent = 'Starting...';
        $('upload-progress').style.display = ''; $('upload-result').style.display = 'none';
        try {
            const res = await fetch(`/upload-to-steam/${currentJobId}`, { method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title_prefix: $('title-prefix').value || 'showcase' }) });
            const d = await res.json();
            if (!res.ok) throw new Error(d.error);
            const uid = d.upload_id;
            const pi = setInterval(async () => {
                try {
                    const sr = await fetch(`/upload-status/${uid}`);
                    const sd = await sr.json();
                    $('upload-progress-fill').style.width = (sd.progress || 0) + '%';
                    $('upload-step').textContent = sd.step || '';
                    if (sd.status === 'login') $('upload-step').style.color = 'var(--yellow)';
                    else if (sd.status === 'running') $('upload-step').style.color = '';
                    if (sd.status === 'complete') {
                        clearInterval(pi); $('upload-progress').style.display = 'none';
                        $('upload-result').style.display = '';
                        $('upload-result-text').innerHTML = `<span style="color:var(--green)">All panels uploaded.</span> Go to Edit Profile → Showcases → Workshop Showcase and add them in order.`;
                        uploadBtn.textContent = 'Upload Again'; uploadBtn.disabled = false;
                    } else if (sd.status === 'error') {
                        clearInterval(pi); $('upload-progress').style.display = 'none';
                        $('upload-result').style.display = '';
                        $('upload-result-text').innerHTML = `<span style="color:var(--red)">Failed:</span> ${sd.error}`;
                        uploadBtn.textContent = 'Retry'; uploadBtn.disabled = false;
                    }
                } catch (e) { console.error(e); }
            }, 1000);
        } catch (e) {
            alert('Error: ' + e.message);
            $('upload-progress').style.display = 'none';
            uploadBtn.textContent = 'Upload to Steam'; uploadBtn.disabled = false;
        }
    };
}

function fmt(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(2) + ' MB';
}
