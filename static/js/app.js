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
// Crop state (normalized 0-1 relative to source)
let cropX = 0, cropY = 0, cropW = 1, cropH = 1;

// ── DOM ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const dropZone = $('drop-zone'), fileInput = $('file-input');
const workspace = $('workspace'), processBtn = $('process-btn');
const panelW = $('panel-width'), panelH = $('panel-height');
const fpsSlider = $('fps-slider'), colorsSldr = $('colors-slider');
const fpsVal = $('fps-value'), colorsVal = $('colors-value');
const totalDim = $('total-dimensions');
const maxSizeEl = $('max-size'), autoOptEl = $('auto-optimize');
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
    dropZone.style.display = 'none';
    workspace.style.display = '';

    $('fb-name').textContent = data.filename;
    const bits = [`${data.width}x${data.height}`, data.size_human, `${data.duration}s`];
    if (data.fps) bits.push(`${data.fps} FPS`);
    $('fb-meta').textContent = bits.join('  ·  ');

    $('change-file-btn').onclick = () => {
        stopPreviewLoop();
        workspace.style.display = 'none';
        dropZone.style.display = '';
        resetUpload();
        $('results-section').style.display = 'none';
        resetBtn();
    };

    const box = $('preview-media');
    if (data.is_video) {
        box.innerHTML = `<video id="src-el" muted loop playsinline
            src="/uploaded/${data.saved_filename}"></video>`;
        sourceEl = $('src-el');
        sourceEl.addEventListener('loadedmetadata', () => {
            videoDuration = sourceEl.duration;
            trimStart = 0; trimEnd = videoDuration;
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
    makeTrimHandle($('trim-handle-start'), pct => {
        trimStart = Math.max(0, Math.min(pct * videoDuration, trimEnd - 0.1));
        updateTrimUI(); updateEstimate();
        sourceEl.currentTime = trimStart;
    });
    makeTrimHandle($('trim-handle-end'), pct => {
        trimEnd = Math.min(videoDuration, Math.max(pct * videoDuration, trimStart + 0.1));
        updateTrimUI(); updateEstimate();
        sourceEl.currentTime = trimEnd;
    });
    $('trim-track').addEventListener('click', e => {
        if (e.target.classList.contains('trim-handle')) return;
        const rect = $('trim-track').getBoundingClientRect();
        sourceEl.currentTime = clamp((e.clientX - rect.left) / rect.width, 0, 1) * videoDuration;
    });
    sourceEl.addEventListener('timeupdate', () => {
        if (!isDraggingTrim && sourceEl.currentTime >= trimEnd) sourceEl.currentTime = trimStart;
        updatePlayhead();
    });
}

function makeTrimHandle(handle, onMove) {
    let dragging = false;
    const start = e => {
        e.preventDefault(); dragging = true; isDraggingTrim = true;
        handle.classList.add('dragging');
        if (sourceEl && !sourceEl.paused) sourceEl.pause();
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
        if (sourceEl && sourceEl.paused) { sourceEl.currentTime = trimStart; sourceEl.play(); }
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
    $('trim-playhead').style.left = (sourceEl.currentTime / videoDuration) * 100 + '%';
    $('trim-current-label').textContent = sourceEl.currentTime.toFixed(1) + 's';
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ══════════════════════════════════════════════════════════════
//  SPLIT PREVIEW (canvas, reads crop region from source)
// ══════════════════════════════════════════════════════════════
function startPreviewLoop() {
    stopPreviewLoop(); lastDrawTime = 0;
    (function loop(now) {
        animFrame = requestAnimationFrame(loop);
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
function updateEstimate() {
    const el = $('estimate-display');
    if (!el || !uploadedFile) return;
    const pw = parseInt(panelW.value) || 122, ph = parseInt(panelH.value) || 300;
    const fps = parseInt(fpsSlider.value) || 15, colors = parseInt(colorsSldr.value) || 256;
    const limit = parseInt(maxSizeEl.value) || 5242880;
    let dur = uploadedFile.is_video ? (trimEnd - trimStart)
        : ((parseFloat($('end-time')?.value) || uploadedFile.duration) - (parseFloat($('start-time')?.value) || 0));
    dur = Math.max(0.1, dur);
    const numFrames = Math.ceil(dur * fps);
    const bpp = Math.log2(Math.max(2, colors));
    const rawFrame = (pw * ph * bpp) / 8;
    const comp = 0.20 + (colors / 256) * 0.20;
    const est = (rawFrame * comp + 30) * numFrames + colors * 3 + 800;
    const pct = Math.min(100, (est / limit) * 100);
    const ok = est <= limit;
    const bar = pct < 60 ? 'var(--green)' : pct < 90 ? 'var(--yellow)' : 'var(--red)';
    el.innerHTML = `
        <div class="est-row"><span class="est-label">Duration</span><span class="est-val">${dur.toFixed(1)}s</span></div>
        <div class="est-row"><span class="est-label">Frames</span><span class="est-val">${numFrames}</span></div>
        <div class="est-row"><span class="est-label">Est. per panel</span><span class="est-val" style="color:${ok?'var(--green)':'var(--red)'}">${fmt(est)}</span></div>
        <div class="est-bar-wrap"><div class="est-bar-track"><div class="est-bar-fill" style="width:${Math.min(pct,100)}%;background:${bar}"></div></div>
        <span class="est-bar-label" style="color:${ok?'':'var(--red)'}">~${fmt(est)} / ${fmt(limit)} per panel</span></div>`;
}

// ══════════════════════════════════════════════════════════════
//  CONTROLS
// ══════════════════════════════════════════════════════════════
fpsSlider.addEventListener('input', () => { fpsVal.textContent = fpsSlider.value; updateEstimate(); lastDrawTime = 0; });
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
    let st, et;
    if (uploadedFile.is_video) { st = trimStart; et = trimEnd; }
    else { st = parseFloat($('start-time').value) || 0; et = parseFloat($('end-time').value) || 0; }

    const body = {
        file_id: uploadedFile.file_id, saved_filename: uploadedFile.saved_filename,
        start_time: st, end_time: et,
        fps: parseInt(fpsSlider.value), colors: parseInt(colorsSldr.value),
        panel_width: parseInt(panelW.value) || 122, panel_height: parseInt(panelH.value) || 300,
        auto_optimize: !!autoOptEl.value, max_file_size: parseInt(maxSizeEl.value),
        crop_y: 0.5,  // center crop — visual crop box handles the framing
    };

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
