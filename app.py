"""
Steam Workshop GIF Splitter
Converts videos/GIFs into 5-panel animated GIFs for Steam Workshop Showcase.
"""

import os
import io
import uuid
import shutil
import zipfile
import threading
from pathlib import Path

from flask import (
    Flask, render_template, request, jsonify,
    send_file, send_from_directory
)
from PIL import Image, ImageSequence
from moviepy.video.io.VideoFileClip import VideoFileClip

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 200 * 1024 * 1024  # 200MB upload limit
app.config['UPLOAD_FOLDER'] = os.path.join(os.path.dirname(__file__), 'uploads')
app.config['OUTPUT_FOLDER'] = os.path.join(os.path.dirname(__file__), 'output')

os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
os.makedirs(app.config['OUTPUT_FOLDER'], exist_ok=True)

# Store processing jobs
jobs = {}
estimate_cache = {}
preprocess_jobs = {}

# ─── Constants ───────────────────────────────────────────────────────
STEAM_MAX_FILE_SIZE = 5 * 1024 * 1024  # 5MB per panel
PANEL_COUNT = 5
DEFAULT_PANEL_WIDTH = 122    # Steam workshop showcase native display width
DEFAULT_PANEL_HEIGHT = 300   # Tall panels for "long" showcase look
ALLOWED_VIDEO_EXT = {'.mp4', '.webm', '.avi', '.mov', '.mkv', '.flv', '.wmv'}
ALLOWED_IMAGE_EXT = {'.gif'}
ALLOWED_EXT = ALLOWED_VIDEO_EXT | ALLOWED_IMAGE_EXT


def allowed_file(filename):
    return Path(filename).suffix.lower() in ALLOWED_EXT


def is_video(filename):
    return Path(filename).suffix.lower() in ALLOWED_VIDEO_EXT


def cover_crop_frame(frame, target_w, target_h):
    """
    Resize a PIL Image to cover target_w x target_h (maintaining aspect ratio),
    then center-crop to exact dimensions.
    """
    src_w, src_h = frame.size
    scale = max(target_w / src_w, target_h / src_h)
    new_w = max(target_w, int(round(src_w * scale)))
    new_h = max(target_h, int(round(src_h * scale)))
    frame = frame.resize((new_w, new_h), Image.LANCZOS)

    # Center-crop to exact target
    left = (new_w - target_w) // 2
    top  = (new_h - target_h) // 2
    return frame.crop((left, top, left + target_w, top + target_h))


def video_to_gif_frames(video_path, start_time=0, end_time=None, fps=15,
                         target_width=750, target_height=150,
                         crop_x=0, crop_y=0, crop_w=1, crop_h=1,
                         skip_ranges=None, speed=1.0):
    """Convert a video file to a list of PIL Image frames, honouring the crop box.

    speed > 1 fast-forwards: the source is sampled at wider intervals so
    the output GIF has fewer frames (and a smaller file size).
    speed < 1 slows down: more frames are sampled.
    The *output* frame timing stays at 1/fps — only the source sampling
    stride changes.
    """
    clip = VideoFileClip(video_path)
    skip_ranges = skip_ranges or []
    speed = max(0.25, min(4.0, speed))

    # Trim
    if end_time is None or end_time > clip.duration:
        end_time = clip.duration
    if start_time > 0 or end_time < clip.duration:
        clip = clip.subclipped(start_time, end_time)

    src_w, src_h = clip.w, clip.h

    # Pre-scale if source is much larger than the crop region needs
    needed_w = int(target_width / max(0.01, crop_w))
    needed_h = int(target_height / max(0.01, crop_h))
    if src_w > needed_w * 1.5 or src_h > needed_h * 1.5:
        pre_scale = max(needed_w / src_w, needed_h / src_h)
        new_w = max(needed_w, int(round(src_w * pre_scale)))
        new_h = max(needed_h, int(round(src_h * pre_scale)))
        clip = clip.resized(new_size=(new_w, new_h))
        src_w, src_h = new_w, new_h

    # Extract frames — source_step controls how fast we walk the source
    frames = []
    frame_duration = 1.0 / fps
    source_step = frame_duration * speed  # e.g. 2x → skip twice as far each output frame
    num_frames = int(clip.duration / source_step)
    for t_idx in range(num_frames):
        t = t_idx * source_step
        if t >= clip.duration:
            break
        # Check if this frame's absolute time falls in a skip zone
        abs_t = start_time + t
        if any(s <= abs_t < e for s, e in skip_ranges):
            continue

        arr = clip.get_frame(t)
        img = Image.fromarray(arr)

        # Crop to the user's crop box
        cx = int(crop_x * src_w)
        cy = int(crop_y * src_h)
        cw = max(1, int(crop_w * src_w))
        ch = max(1, int(crop_h * src_h))
        img = img.crop((cx, cy, cx + cw, cy + ch))

        # Scale the cropped region to cover target dimensions exactly
        img = cover_crop_frame(img, target_width, target_height)
        frames.append(img)

    actual_duration = clip.duration
    clip.close()
    return frames, frame_duration, actual_duration


def load_gif_frames(gif_path, start_time=0, end_time=None, fps=None,
                     target_width=750, target_height=150,
                     crop_x=0, crop_y=0, crop_w=1, crop_h=1,
                     skip_ranges=None, speed=1.0):
    """Load a GIF and return cropped+scaled frames honouring the crop box."""
    img = Image.open(gif_path)

    original_frames = []
    original_durations = []
    try:
        for frame in ImageSequence.Iterator(img):
            frame = frame.copy()
            duration_ms = frame.info.get('duration', 100)
            if duration_ms == 0:
                duration_ms = 100
            original_durations.append(duration_ms)
            original_frames.append(frame.convert('RGBA'))
    except EOFError:
        pass

    if not original_frames:
        return [], 0.1, 0

    # Calculate total duration and trim
    cumulative_times = []
    total_ms = 0
    for d in original_durations:
        cumulative_times.append(total_ms)
        total_ms += d
    total_duration = total_ms / 1000.0

    if end_time is None or end_time > total_duration:
        end_time = total_duration

    # Filter frames by time range and skip zones
    skip_ranges = skip_ranges or []
    trimmed_frames = []
    trimmed_durations = []
    for i, (frame, dur) in enumerate(zip(original_frames, original_durations)):
        frame_start = cumulative_times[i] / 1000.0
        frame_end = frame_start + dur / 1000.0
        if frame_end > start_time and frame_start < end_time:
            # Skip frames that fall inside a skip zone
            if any(s <= frame_start < e for s, e in skip_ranges):
                continue
            trimmed_frames.append(frame)
            trimmed_durations.append(dur)

    if not trimmed_frames:
        trimmed_frames = original_frames
        trimmed_durations = original_durations

    # Resample to target FPS if specified
    if fps and fps > 0:
        avg_original_fps = 1000.0 / (sum(trimmed_durations) / len(trimmed_durations))
        if fps < avg_original_fps:
            step = max(1, round(avg_original_fps / fps))
            trimmed_frames = trimmed_frames[::step]
            trimmed_durations = trimmed_durations[::step]

    # Apply speed: keep every Nth frame where N ≈ speed.
    # speed > 1 → fewer frames (fast-forward), speed < 1 → more kept (slow-mo clamp).
    speed = max(0.25, min(4.0, speed))
    if speed != 1.0 and len(trimmed_frames) > 1:
        step = max(1, round(speed))
        if step > 1:
            trimmed_frames = trimmed_frames[::step]
            trimmed_durations = trimmed_durations[::step]

    frame_duration_ms = sum(trimmed_durations) / len(trimmed_durations) if trimmed_durations else 100
    if fps:
        frame_duration_ms = 1000.0 / fps

    # Crop to user's crop box, then scale to target dimensions
    resized_frames = []
    for frame in trimmed_frames:
        fw, fh = frame.size
        cx = int(crop_x * fw)
        cy = int(crop_y * fh)
        cw = max(1, int(crop_w * fw))
        ch = max(1, int(crop_h * fh))
        cropped = frame.crop((cx, cy, cx + cw, cy + ch))
        resized_frames.append(cover_crop_frame(cropped, target_width, target_height))

    actual_duration = end_time - start_time
    return resized_frames, frame_duration_ms / 1000.0, actual_duration


def split_frames_into_panels(frames, panel_count=5):
    """Split each frame into N vertical strips."""
    if not frames:
        return [[] for _ in range(panel_count)]

    width = frames[0].width
    panel_width = width // panel_count

    panels = [[] for _ in range(panel_count)]
    for frame in frames:
        for i in range(panel_count):
            left = i * panel_width
            right = (left + panel_width) if i < panel_count - 1 else width
            panels[i].append(frame.crop((left, 0, right, frame.height)))

    return panels


def frames_to_gif_bytes(frames, frame_duration, colors=256):
    """Convert a list of PIL frames to GIF bytes.

    Uses the simplest possible GIF encoding — uniform duration, no
    frame-merging optimizations — to keep multi-panel showcases in sync.
    Matches the approach used by community tools (gif_divider, etc.).
    """
    if not frames:
        return b''

    # Snap to exact centiseconds (GIF timing resolution is 10ms)
    duration_ms = max(20, round(frame_duration * 100) * 10)

    # Convert all frames to paletted (P mode) for GIF.
    # IMPORTANT: toggle a pixel on each frame so Pillow can't merge
    # "identical" frames — merged frames cause panel desync.
    gif_frames = []
    for fi, frame in enumerate(frames):
        if frame.mode == 'RGBA':
            bg = Image.new('RGBA', frame.size, (0, 0, 0, 255))
            bg.paste(frame, mask=frame.split()[3])
            frame = bg.convert('RGB')
        elif frame.mode != 'RGB':
            frame = frame.convert('RGB')
        # Flip a corner pixel between 0 and 1 each frame — invisible but
        # guarantees every frame is unique, preventing Pillow from dropping it
        px = frame.load()
        r, g, b = px[0, 0]
        px[0, 0] = (r ^ (fi & 1), g, b)
        gif_frames.append(
            frame.quantize(colors=min(colors, 256), method=Image.MEDIANCUT)
        )

    buf = io.BytesIO()
    gif_frames[0].save(
        buf, format='GIF', save_all=True,
        append_images=gif_frames[1:],
        duration=duration_ms,
        loop=0,
    )
    return buf.getvalue()


def estimate_panel_sizes(filepath, settings):
    """Dry-run the full processing path and return exact final panel sizes."""
    filename = os.path.basename(filepath)
    start_time = settings.get('start_time', 0)
    end_time = settings.get('end_time', None)
    fps = settings.get('fps', 15)
    speed = settings.get('speed', 1.0)
    colors = settings.get('colors', 256)
    panel_width = settings.get('panel_width', DEFAULT_PANEL_WIDTH)
    panel_height = settings.get('panel_height', DEFAULT_PANEL_HEIGHT)
    target_width = panel_width * PANEL_COUNT
    crop_x = settings.get('crop_x', 0)
    crop_y = settings.get('crop_y', 0)
    crop_w = settings.get('crop_w', 1)
    crop_h = settings.get('crop_h', 1)
    skip_ranges = settings.get('skip_ranges', [])

    if is_video(filename):
        frames, frame_duration, actual_duration = video_to_gif_frames(
            filepath, start_time, end_time, fps, target_width, panel_height,
            crop_x, crop_y, crop_w, crop_h, skip_ranges, speed
        )
    else:
        frames, frame_duration, actual_duration = load_gif_frames(
            filepath, start_time, end_time, fps, target_width, panel_height,
            crop_x, crop_y, crop_w, crop_h, skip_ranges, speed
        )

    if not frames:
        return {
            'duration': 0,
            'frame_count': 0,
            'panel_sizes': [0 for _ in range(PANEL_COUNT)],
            'panel_sizes_human': [format_size(0) for _ in range(PANEL_COUNT)],
            'estimate_bytes': 0,
            'average_bytes': 0,
            'average_human': format_size(0),
            'smallest_bytes': 0,
            'smallest_human': format_size(0),
            'estimate_human': format_size(0),
            'largest_panel': None,
            'colors': colors,
            'fps': fps,
        }

    panels = split_frames_into_panels(frames, PANEL_COUNT)
    panel_sizes = [
        len(frames_to_gif_bytes(pf, frame_duration, colors))
        for pf in panels
    ]

    worst_size = max(panel_sizes) if panel_sizes else 0
    avg_size = int(round(sum(panel_sizes) / len(panel_sizes))) if panel_sizes else 0
    smallest_size = min(panel_sizes) if panel_sizes else 0

    return {
        'duration': round(actual_duration, 2),
        'frame_count': len(frames),
        'panel_sizes': panel_sizes,
        'panel_sizes_human': [format_size(size) for size in panel_sizes],
        'estimate_bytes': worst_size,
        'average_bytes': avg_size,
        'average_human': format_size(avg_size),
        'smallest_bytes': smallest_size,
        'smallest_human': format_size(smallest_size),
        'estimate_human': format_size(worst_size),
        'largest_panel': (panel_sizes.index(worst_size) + 1) if panel_sizes else None,
        'colors': colors,
        'fps': fps,
    }


def process_file(job_id, filepath, settings):
    """Main processing pipeline."""
    try:
        jobs[job_id]['status'] = 'processing'
        jobs[job_id]['progress'] = 10

        filename    = os.path.basename(filepath)
        start_time  = settings.get('start_time', 0)
        end_time    = settings.get('end_time', None)
        fps         = settings.get('fps', 15)
        speed       = settings.get('speed', 1.0)
        colors      = settings.get('colors', 256)
        panel_width = settings.get('panel_width', DEFAULT_PANEL_WIDTH)
        panel_height= settings.get('panel_height', DEFAULT_PANEL_HEIGHT)
        max_size    = settings.get('max_file_size', STEAM_MAX_FILE_SIZE)
        crop_x      = settings.get('crop_x', 0)
        crop_y      = settings.get('crop_y', 0)
        crop_w      = settings.get('crop_w', 1)
        crop_h      = settings.get('crop_h', 1)
        skip_ranges = settings.get('skip_ranges', [])

        total_width  = panel_width * PANEL_COUNT
        total_height = panel_height

        jobs[job_id]['progress'] = 20

        if is_video(filename):
            jobs[job_id]['step'] = 'Converting video to frames...'
            frames, frame_duration, actual_duration = video_to_gif_frames(
                filepath, start_time, end_time, fps, total_width, total_height,
                crop_x, crop_y, crop_w, crop_h, skip_ranges, speed
            )
        else:
            jobs[job_id]['step'] = 'Loading GIF frames...'
            frames, frame_duration, actual_duration = load_gif_frames(
                filepath, start_time, end_time, fps, total_width, total_height,
                crop_x, crop_y, crop_w, crop_h, skip_ranges, speed
            )

        if not frames:
            jobs[job_id]['status'] = 'error'
            jobs[job_id]['error'] = 'No frames extracted from file'
            return

        jobs[job_id]['progress'] = 50
        jobs[job_id]['step'] = 'Splitting into panels...'
        panels = split_frames_into_panels(frames, PANEL_COUNT)

        jobs[job_id]['progress'] = 60
        jobs[job_id]['step'] = 'Generating GIFs...'

        output_dir = os.path.join(app.config['OUTPUT_FOLDER'], job_id)
        os.makedirs(output_dir, exist_ok=True)

        # Write all panels with identical frame count and duration (keeps sync)
        panel_results = []
        for i, panel_frames in enumerate(panels):
            jobs[job_id]['step'] = f'Writing panel {i + 1}/{PANEL_COUNT}...'
            jobs[job_id]['progress'] = 60 + (i * 8)

            gif_bytes = frames_to_gif_bytes(panel_frames, frame_duration, colors=colors)

            # Hex-edit: change last byte to 0x21 for "long" workshop showcase
            if gif_bytes:
                gif_bytes = gif_bytes[:-1] + b'\x21'

            path = os.path.join(output_dir, f'panel_{i+1}.gif')
            with open(path, 'wb') as f:
                f.write(gif_bytes)

            sz = len(gif_bytes)
            panel_results.append({
                'index': i + 1, 'filename': f'panel_{i+1}.gif',
                'size_bytes': sz, 'size_human': format_size(sz),
                'within_limit': sz <= max_size,
                'colors': colors, 'fps': fps,
                'width': panel_frames[0].width if panel_frames else panel_width,
                'height': panel_frames[0].height if panel_frames else panel_height,
                'frame_count': len(panel_frames),
            })

        # Combined preview
        jobs[job_id]['step'] = 'Generating preview...'
        jobs[job_id]['progress'] = 95
        preview = frames_to_gif_bytes(frames, frame_duration, colors=colors)
        with open(os.path.join(output_dir, 'preview_combined.gif'), 'wb') as f:
            f.write(preview)

        # Zip
        zip_path = os.path.join(output_dir, 'steam_panels.zip')
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for r in panel_results:
                zf.write(os.path.join(output_dir, r['filename']), r['filename'])

        jobs[job_id]['status'] = 'complete'
        jobs[job_id]['progress'] = 100
        jobs[job_id]['step'] = 'Done!'
        jobs[job_id]['result'] = {
            'panels': panel_results,
            'total_frames': len(frames),
            'duration': round(actual_duration, 2),
        }

    except Exception as e:
        jobs[job_id]['status'] = 'error'
        jobs[job_id]['error'] = str(e)
        import traceback
        traceback.print_exc()


def format_size(size_bytes):
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    return f"{size_bytes / (1024 * 1024):.2f} MB"


def detect_black_ranges(filepath, threshold=10, sample_fps=10, min_duration=0.15):
    """Scan a video and return time ranges where frames are (near-)black.

    threshold  – average pixel brightness (0-255) below which a frame
                 counts as black.
    sample_fps – how many frames per second to sample for detection.
    min_duration – ignore black segments shorter than this many seconds.
    """
    import numpy as np
    clip = VideoFileClip(filepath)
    frame_dur = 1.0 / sample_fps
    num_samples = int(clip.duration * sample_fps)

    ranges = []
    in_black = False
    black_start = 0.0

    for idx in range(num_samples):
        t = idx * frame_dur
        if t >= clip.duration:
            break
        frame = clip.get_frame(t)
        avg = float(np.mean(frame))

        if avg < threshold:
            if not in_black:
                in_black = True
                black_start = t
        else:
            if in_black:
                in_black = False
                length = t - black_start
                if length >= min_duration:
                    ranges.append([round(black_start, 3), round(t, 3)])

    # Still in black at the end of the clip
    if in_black:
        length = clip.duration - black_start
        if length >= min_duration:
            ranges.append([round(black_start, 3), round(clip.duration, 3)])

    clip.close()
    return ranges


# ─── Routes ──────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/upload', methods=['POST'])
def upload():
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
    if not allowed_file(file.filename):
        return jsonify({'error': f'Invalid file type. Allowed: {", ".join(ALLOWED_EXT)}'}), 400

    file_id = str(uuid.uuid4())[:8]
    ext = Path(file.filename).suffix.lower()
    saved_filename = f'{file_id}{ext}'
    saved_path = os.path.join(app.config['UPLOAD_FOLDER'], saved_filename)
    file.save(saved_path)

    file_size = os.path.getsize(saved_path)
    info = {
        'file_id': file_id, 'filename': file.filename,
        'saved_filename': saved_filename,
        'size_bytes': file_size, 'size_human': format_size(file_size),
        'is_video': is_video(file.filename),
    }

    try:
        if is_video(file.filename):
            clip = VideoFileClip(saved_path)
            info['duration'] = round(clip.duration, 2)
            info['width'] = clip.w
            info['height'] = clip.h
            info['fps'] = round(clip.fps, 1)
            clip.close()
        else:
            im = Image.open(saved_path)
            info['width'] = im.width
            info['height'] = im.height
            fc, ms = 0, 0
            try:
                for frame in ImageSequence.Iterator(im):
                    fc += 1
                    ms += frame.info.get('duration', 100)
            except EOFError:
                pass
            info['frame_count'] = fc
            info['duration'] = round(ms / 1000.0, 2)
            info['fps'] = round(fc / (ms / 1000.0), 1) if ms > 0 else 10
            im.close()
    except Exception as e:
        info['error_info'] = str(e)

    return jsonify(info)


@app.route('/detect-black', methods=['POST'])
def detect_black():
    """Scan the uploaded video for black frames and return time ranges."""
    data = request.json
    if not data or 'saved_filename' not in data:
        return jsonify({'error': 'Missing saved_filename'}), 400

    filepath = os.path.join(app.config['UPLOAD_FOLDER'], data.get('saved_filename', ''))
    if not os.path.exists(filepath):
        return jsonify({'error': 'File not found'}), 404

    if not is_video(os.path.basename(filepath)):
        return jsonify({'error': 'Black-frame detection is only available for videos'}), 400

    try:
        threshold = max(1, min(80, int(data.get('threshold', 10))))
        min_duration = max(0.0, float(data.get('min_duration', 0.15)))
        ranges = detect_black_ranges(filepath, threshold=threshold,
                                      min_duration=min_duration)
        return jsonify({'ranges': ranges, 'count': len(ranges)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def parse_processing_settings(data):
    skip_ranges_raw = data.get('skip_ranges', [])
    skip_ranges = []
    for r in skip_ranges_raw:
        if isinstance(r, (list, tuple)) and len(r) >= 2:
            skip_ranges.append((float(r[0]), float(r[1])))
    return {
        'start_time':   float(data.get('start_time', 0)),
        'end_time':     float(data.get('end_time', 0)) or None,
        'fps':          int(data.get('fps', 15)),
        'speed':        max(0.25, min(4.0, float(data.get('speed', 1)))),
        'colors':       int(data.get('colors', 256)),
        'panel_width':  int(data.get('panel_width', DEFAULT_PANEL_WIDTH)),
        'panel_height': int(data.get('panel_height', DEFAULT_PANEL_HEIGHT)),
        'max_file_size':int(data.get('max_file_size', STEAM_MAX_FILE_SIZE)),
        'crop_x':       float(data.get('crop_x', 0)),
        'crop_y':       float(data.get('crop_y', 0)),
        'crop_w':       float(data.get('crop_w', 1)),
        'crop_h':       float(data.get('crop_h', 1)),
        'skip_ranges':  skip_ranges,
    }


def estimate_cache_key(filepath, settings):
    stat = os.stat(filepath)
    return (
        os.path.abspath(filepath),
        stat.st_mtime_ns,
        stat.st_size,
        settings.get('start_time'),
        settings.get('end_time'),
        settings.get('fps'),
        settings.get('speed'),
        settings.get('colors'),
        settings.get('panel_width'),
        settings.get('panel_height'),
        settings.get('max_file_size'),
        settings.get('crop_x'),
        settings.get('crop_y'),
        settings.get('crop_w'),
        settings.get('crop_h'),
        tuple(tuple(r) for r in (settings.get('skip_ranges') or [])),
    )


def get_exact_metrics(filepath, settings):
    cache_key = estimate_cache_key(filepath, settings)
    if cache_key in estimate_cache:
        result = dict(estimate_cache[cache_key])
        result['cached'] = True
        return result

    result = estimate_panel_sizes(filepath, settings)
    estimate_cache[cache_key] = dict(result)
    result['cached'] = False
    return result


def run_preprocess_job(preprocess_id, filepath, settings):
    try:
        preprocess_jobs[preprocess_id].update({
            'status': 'running',
            'progress': 10,
            'step': 'Preprocessing full video...',
        })
        result = get_exact_metrics(filepath, settings)
        max_size = settings.get('max_file_size', STEAM_MAX_FILE_SIZE)
        result['within_limit'] = result['estimate_bytes'] <= max_size
        preprocess_jobs[preprocess_id].update({
            'status': 'complete',
            'progress': 100,
            'step': 'Exact metrics ready',
            'result': result,
        })
    except Exception as e:
        preprocess_jobs[preprocess_id].update({
            'status': 'error',
            'progress': 100,
            'step': 'Preprocess failed',
            'error': str(e),
        })


@app.route('/preprocess', methods=['POST'])
def preprocess():
    data = request.json
    if not data or 'file_id' not in data:
        return jsonify({'error': 'Missing file_id'}), 400

    filepath = os.path.join(app.config['UPLOAD_FOLDER'], data.get('saved_filename', ''))
    if not os.path.exists(filepath):
        return jsonify({'error': 'File not found'}), 404

    settings = parse_processing_settings(data)
    preprocess_id = str(uuid.uuid4())[:8]
    preprocess_jobs[preprocess_id] = {
        'status': 'queued',
        'progress': 0,
        'step': 'Queued',
        'result': None,
        'error': None,
    }

    thread = threading.Thread(
        target=run_preprocess_job,
        args=(preprocess_id, filepath, settings),
        daemon=True,
    )
    thread.start()
    return jsonify({'preprocess_id': preprocess_id})


@app.route('/preprocess-status/<preprocess_id>')
def preprocess_status(preprocess_id):
    if preprocess_id not in preprocess_jobs:
        return jsonify({'error': 'Preprocess job not found'}), 404
    return jsonify(preprocess_jobs[preprocess_id])


@app.route('/estimate', methods=['POST'])
def estimate():
    data = request.json
    if not data or 'file_id' not in data:
        return jsonify({'error': 'Missing file_id'}), 400

    filepath = os.path.join(app.config['UPLOAD_FOLDER'], data.get('saved_filename', ''))
    if not os.path.exists(filepath):
        return jsonify({'error': 'File not found'}), 404

    try:
        settings = parse_processing_settings(data)
        result = get_exact_metrics(filepath, settings)
        max_size = settings.get('max_file_size', STEAM_MAX_FILE_SIZE)
        result['within_limit'] = result['estimate_bytes'] <= max_size
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/process', methods=['POST'])
def process():
    data = request.json
    if not data or 'file_id' not in data:
        return jsonify({'error': 'Missing file_id'}), 400

    filepath = os.path.join(app.config['UPLOAD_FOLDER'], data.get('saved_filename', ''))
    if not os.path.exists(filepath):
        return jsonify({'error': 'File not found'}), 404

    job_id = str(uuid.uuid4())[:8]

    settings = parse_processing_settings(data)

    jobs[job_id] = {'status':'queued','progress':0,'step':'Starting...','result':None,'error':None}
    thread = threading.Thread(target=process_file, args=(job_id, filepath, settings), daemon=True)
    thread.start()
    return jsonify({'job_id': job_id})


@app.route('/status/<job_id>')
def job_status(job_id):
    if job_id not in jobs:
        return jsonify({'error': 'Job not found'}), 404
    return jsonify(jobs[job_id])

@app.route('/preview/<job_id>')
def preview(job_id):
    return send_from_directory(os.path.join(app.config['OUTPUT_FOLDER'], job_id), 'preview_combined.gif')

@app.route('/panel/<job_id>/<int:panel_index>')
def get_panel(job_id, panel_index):
    return send_from_directory(os.path.join(app.config['OUTPUT_FOLDER'], job_id), f'panel_{panel_index}.gif')

@app.route('/download/<job_id>')
def download_all(job_id):
    zp = os.path.join(app.config['OUTPUT_FOLDER'], job_id, 'steam_panels.zip')
    if not os.path.exists(zp):
        return jsonify({'error': 'File not found'}), 404
    return send_file(zp, as_attachment=True, download_name='steam_workshop_panels.zip')

@app.route('/download-panel/<job_id>/<int:panel_index>')
def download_panel(job_id, panel_index):
    fp = os.path.join(app.config['OUTPUT_FOLDER'], job_id, f'panel_{panel_index}.gif')
    if not os.path.exists(fp):
        return jsonify({'error': 'File not found'}), 404
    return send_file(fp, as_attachment=True, download_name=f'panel_{panel_index}.gif')

@app.route('/uploaded/<filename>')
def serve_upload(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

# ─── Steam Upload via Selenium ───────────────────────────────────

upload_jobs = {}

def steam_upload_worker(upload_id, output_dir, title_prefix):
    """Automate the browser console upload method with Selenium.
    Tries Edge first (ships with Windows), falls back to Chrome."""
    driver = None
    try:
        import time
        from selenium import webdriver
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC

        upload_jobs[upload_id]['status'] = 'login'
        upload_jobs[upload_id]['step'] = 'Launching browser...'

        # Try Edge first (pre-installed on Windows), then Chrome
        for attempt in ['edge', 'chrome']:
            try:
                if attempt == 'edge':
                    from selenium.webdriver.edge.options import Options
                    opts = Options()
                    opts.add_argument('--no-first-run')
                    opts.add_argument('--no-default-browser-check')
                    opts.add_experimental_option('excludeSwitches', ['enable-automation'])
                    driver = webdriver.Edge(options=opts)
                else:
                    from selenium.webdriver.chrome.options import Options
                    opts = Options()
                    opts.add_argument('--no-first-run')
                    opts.add_argument('--no-default-browser-check')
                    opts.add_experimental_option('excludeSwitches', ['enable-automation'])
                    driver = webdriver.Chrome(options=opts)
                break
            except Exception:
                if attempt == 'chrome':
                    raise
                continue

        driver.set_window_size(1100, 850)
        upload_jobs[upload_id]['step'] = 'Log into Steam in the browser window...'

        # Navigate to login, which will redirect to the edit page after login
        edit_url = 'https://steamcommunity.com/sharedfiles/edititem/767/3/'
        driver.get(edit_url)
        time.sleep(2)

        # Wait for the user to log in (up to 3 minutes)
        upload_jobs[upload_id]['step'] = 'Waiting for you to log into Steam in the browser window...'
        logged_in = False
        for _ in range(180):  # 3 minutes
            url = driver.current_url
            if 'login' not in url and 'edititem' in url:
                logged_in = True
                break
            time.sleep(1)

        if not logged_in:
            upload_jobs[upload_id]['status'] = 'error'
            upload_jobs[upload_id]['error'] = 'Timed out waiting for Steam login. Try again.'
            driver.quit()
            return

        upload_jobs[upload_id]['status'] = 'running'
        upload_jobs[upload_id]['step'] = 'Logged in! Starting uploads...'
        time.sleep(2)

        published_ids = []

        for i in range(1, PANEL_COUNT + 1):
            gif_path = os.path.abspath(os.path.join(output_dir, f'panel_{i}.gif'))
            title = f'{title_prefix}-{i}'

            upload_jobs[upload_id]['step'] = f'Uploading panel {i}/{PANEL_COUNT}...'
            upload_jobs[upload_id]['progress'] = int((i - 1) / PANEL_COUNT * 100)

            # Navigate to the workshop upload page
            if i > 1:
                driver.get(edit_url)
                time.sleep(3)

            # Wait for the form to load
            wait = WebDriverWait(driver, 15)
            try:
                wait.until(EC.presence_of_element_located((By.NAME, 'title')))
            except Exception:
                upload_jobs[upload_id]['status'] = 'error'
                upload_jobs[upload_id]['error'] = f'Could not find upload form on panel {i}. Page: {driver.current_url}'
                driver.quit()
                return

            # Inject the console JS to set app ID, file type, visibility
            driver.execute_script("""
                var el = document.getElementById('ConsumerAppID');
                if (el) el.value = '480';
                el = document.querySelector('[name=file_type]');
                if (el) el.value = '0';
                el = document.querySelector('[name=visibility]');
                if (el) el.value = '0';
            """)
            time.sleep(0.5)

            # Fill in the title
            title_input = driver.find_element(By.NAME, 'title')
            title_input.clear()
            title_input.send_keys(title)

            # Upload the GIF file via the file input
            file_input = driver.find_element(By.NAME, 'file')
            file_input.send_keys(gif_path)

            # Wait for the file to be read (Steam JS populates image_width/height)
            time.sleep(2)

            # Override image dimensions — this is the key trick for "long" showcase
            # Setting image_width high and image_height to 1 bypasses square-crop
            # The .attr('id','') removes the id so Steam's JS can't reset the values
            driver.execute_script("""
                var iw = document.getElementById('image_width');
                if (iw) { iw.value = '1000'; iw.removeAttribute('id'); }
                var ih = document.getElementById('image_height');
                if (ih) { ih.value = '1'; ih.removeAttribute('id'); }
            """)

            # Check the agreement checkbox
            try:
                agree_cb = driver.find_element(By.ID, 'agree_terms')
                if not agree_cb.is_selected():
                    driver.execute_script("arguments[0].click();", agree_cb)
            except Exception:
                # Try other common checkbox selectors
                try:
                    driver.execute_script("""
                        var cbs = document.querySelectorAll('input[type=checkbox]');
                        cbs.forEach(function(cb) { cb.checked = true; });
                    """)
                except Exception:
                    pass

            time.sleep(0.5)

            # Submit the form
            driver.execute_script("""
                var form = document.querySelector('form[action*="edititem"]');
                if (!form) {
                    var forms = document.querySelectorAll('form');
                    for (var f of forms) {
                        if (f.querySelector('[name=title]')) { form = f; break; }
                    }
                }
                if (form) form.submit();
            """)

            # Wait for the page to change (redirect after save)
            time.sleep(5)

            # Try to get the published file ID from the resulting page
            current_url = driver.current_url
            if 'id=' in current_url:
                fid = current_url.split('id=')[-1].split('&')[0]
                published_ids.append(fid)
            else:
                published_ids.append(f'panel-{i}')

            upload_jobs[upload_id]['step'] = f'Panel {i}/{PANEL_COUNT} done!'
            time.sleep(1)

        upload_jobs[upload_id]['status'] = 'complete'
        upload_jobs[upload_id]['progress'] = 100
        upload_jobs[upload_id]['step'] = 'All panels uploaded!'
        upload_jobs[upload_id]['published_ids'] = published_ids

        # Keep browser open briefly so user can see the result
        time.sleep(3)
        driver.quit()

    except Exception as e:
        upload_jobs[upload_id]['status'] = 'error'
        upload_jobs[upload_id]['error'] = str(e)
        import traceback
        traceback.print_exc()
        try:
            if driver:
                driver.quit()
        except Exception:
            pass


@app.route('/upload-to-steam/<job_id>', methods=['POST'])
def upload_to_steam(job_id):
    """Start automated browser upload to Steam Workshop."""
    output_dir = os.path.join(app.config['OUTPUT_FOLDER'], job_id)
    if not os.path.exists(output_dir):
        return jsonify({'error': 'Job not found'}), 404

    data = request.json or {}
    title_prefix = data.get('title_prefix', 'showcase')

    upload_id = str(uuid.uuid4())[:8]
    upload_jobs[upload_id] = {
        'status': 'starting',
        'step': 'Preparing...',
        'progress': 0,
        'error': None,
        'published_ids': [],
    }

    thread = threading.Thread(
        target=steam_upload_worker,
        args=(upload_id, output_dir, title_prefix),
        daemon=True,
    )
    thread.start()

    return jsonify({'upload_id': upload_id})


@app.route('/upload-status/<upload_id>')
def upload_status(upload_id):
    if upload_id not in upload_jobs:
        return jsonify({'error': 'Upload not found'}), 404
    return jsonify(upload_jobs[upload_id])


@app.route('/cleanup', methods=['POST'])
def cleanup():
    try:
        estimate_cache.clear()
        preprocess_jobs.clear()
        for folder in [app.config['UPLOAD_FOLDER'], app.config['OUTPUT_FOLDER']]:
            for item in os.listdir(folder):
                p = os.path.join(folder, item)
                shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
        return jsonify({'status': 'cleaned'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    print("\n" + "=" * 60)
    print("  Steam Workshop GIF Splitter")
    print("  Open http://localhost:5000 in your browser")
    print("=" * 60 + "\n")
    app.run(debug=True, port=5000, host='127.0.0.1')
