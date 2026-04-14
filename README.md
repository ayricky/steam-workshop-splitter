# Workshop Splitter

Convert videos and GIFs into 5-panel animated showcases for your Steam profile's Workshop Showcase.

Takes a video or GIF, lets you crop and trim it, splits it into 5 synchronized panel GIFs, and optionally uploads them to Steam automatically.

![image](https://github.com/user-attachments/assets/placeholder)

## What it does

Steam profiles have a Workshop Showcase that displays 5 items in a row. People use this to show a continuous animated scene split across all 5 slots. This tool automates the whole process:

1. Upload a video or GIF
2. Visually crop the frame (drag edges, reposition)
3. Trim the timeline (drag start/end handles)
4. Adjust FPS and color count with live preview
5. Split into 5 perfectly synced panel GIFs
6. Upload to Steam Workshop with one click (via Selenium)

## Setup

Requires Python 3.10+ and Chrome (for auto-upload).

```bash
git clone https://github.com/ayricky/steam-workshop-splitter.git
cd steam-workshop-splitter
pip install -r requirements.txt
python app.py
```

Open `http://localhost:5000` in your browser.

### Dependencies

- **Flask** — web server
- **Pillow** — GIF processing and splitting
- **MoviePy** — video to frame conversion (bundles its own ffmpeg)
- **Selenium** — automated Steam Workshop upload (optional, needs Chrome)

## Usage

### Crop & Trim

After uploading a file, the editor shows your source with a draggable crop box:

- **Drag the box body** to reposition
- **Drag any edge** to resize the crop region
- **Drag the timeline handles** below to set start/end times (video pauses to show the exact frame)
- The split preview updates live as you adjust everything

### Settings

- **Width / Height** — panel dimensions. Default 122px wide (Steam's native display width). Height is auto-calculated from the crop
- **FPS** — frame rate. Lower = smaller files, higher = smoother. The preview throttles to match
- **Colors** — GIF palette size. 256 is max quality, lower = smaller files. The preview shows the color reduction live
- **Estimated Output** — live file size estimate per panel, updates as you change any setting

### Processing

Click **Split into 5 panels**. The tool:

- Extracts frames from the cropped/trimmed region
- Splits each frame into 5 vertical strips
- Generates synced GIF files (uniform frame count and timing across all panels)
- Auto-optimizes to fit within the 5MB Steam limit (reduces colors/frames uniformly so panels stay synced)
- Hex-edits the last byte of each GIF (`0x3B` → `0x21`) so Steam displays them at full height instead of cropping to square

### Upload to Steam

Two options:

**Automatic (recommended):**

1. Click **Upload to Steam** in the results
2. A Chrome window opens to Steam's login page
3. Log in (handle Steam Guard there)
4. The tool uploads all 5 panels automatically — injects the console commands, sets titles, uploads files, submits
5. Go to **Edit Profile → Showcases → Workshop Showcase** and add all 5 items in order

**Manual:**

1. Go to [Steam Workshop Upload](https://steamcommunity.com/sharedfiles/edititem/767/3/)
2. Open DevTools console, paste: `$J('#ConsumerAppID').val(480),$J('[name=file_type]').val(0),$J('[name=visibility]').val(0);`
3. After selecting the file, paste: `$J('#image_width').val(1000).attr('id',''),$J('#image_height').val(1).attr('id','');`
4. Fill title, check agreement, save
5. Repeat for all 5 panels

## Technical Details

### Panel sync

GIF animations on Steam play independently — each starts when it finishes loading. This tool ensures they stay in sync by:

- All 5 panels have identical frame counts
- All frames have uniform timing (snapped to GIF's centisecond resolution)
- Auto-optimization reduces colors/frames uniformly across all panels (never per-panel)
- A corner pixel is toggled per frame to prevent Pillow from merging duplicate frames (which would desync the panels)

### Steam "long" showcase

Steam normally displays Workshop items as 122×122 squares. To make them display at full height (the "long" look), two things are needed:

1. The last byte of the GIF is changed from `0x3B` (standard GIF trailer) to `0x21` — this bypasses Steam's dimension validation
2. During upload, `image_width` and `image_height` form fields are overridden via console injection

Both are handled automatically by this tool.

### Steam dimensions

- Workshop showcase renders items at **122px wide**
- Height can be anything — Steam preserves the aspect ratio
- Default output: **122 × 300** per panel (tall portrait)
- File size limit: **~5MB** per panel via the browser upload method

## License

MIT
