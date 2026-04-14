# Workshop Splitter

Turn any video or GIF into an animated 5-panel showcase for your Steam profile.

You know those Steam profiles with anime scenes or cool clips playing across 5 workshop items? This tool does that — crop, trim, split, and upload, all from your browser.

---

## Download & Install

### 1. Install Python

If you don't have Python yet, download it from [python.org](https://www.python.org/downloads/) (3.10 or newer). During install, **check "Add Python to PATH"**.

### 2. Download this tool

**[Download ZIP](https://github.com/ayricky/steam-workshop-splitter/archive/refs/heads/main.zip)** and extract it anywhere, or clone with git:

```
git clone https://github.com/ayricky/steam-workshop-splitter.git
```

### 3. Install dependencies

Open a terminal in the extracted folder and run:

```
pip install -r requirements.txt
```

### 4. Run it

```
python app.py
```

Then open **http://localhost:5000** in your browser. That's it.

On Windows you can also just double-click `start.bat`.

---

## How to use

### Step 1 — Pick your clip

Drop a video (MP4, MOV, WebM, AVI, MKV) or GIF into the upload area.

### Step 2 — Crop & trim

Once your file loads, you'll see two things:

- **Your source video** with a blue crop box on it — drag the box to move it, drag any edge to resize. This controls what part of the frame becomes your showcase.
- **A timeline bar** underneath (for videos) — drag the start and end handles to pick the exact clip. The video pauses on the frame you're dragging to so you can see exactly where you're cutting.

The **split preview** below shows a live view of how your 5 panels will look, updating in real time as you adjust the crop.

### Step 3 — Tune quality

On the right side:

- **FPS** — how smooth the animation is. Lower FPS = smaller file size. 15-20 is a good balance.
- **Colors** — GIF color palette. 256 is best quality, lower = smaller files. The preview shows you what it'll look like.
- **Estimated Output** — shows the estimated file size per panel. Keep it under 5 MB (the bar turns red if you're over).

### Step 4 — Split

Click **Split into 5 panels**. The tool processes your clip and shows the result — hover any panel to see its file size and download it individually, or download all 5 as a ZIP.

If panels are out of sync in the preview, click **resync** — this reloads all 5 GIFs at the same time so they start together.

### Step 5 — Upload to Steam

**Option A — Automatic upload:**

1. Type a name prefix (like `naruto` — items will be named `naruto-1` through `naruto-5`)
2. Click **Upload to Steam**
3. A Chrome window opens to Steam's login page — log in there
4. Once you're in, the tool uploads all 5 panels automatically
5. When it's done, go to your Steam profile → **Edit Profile** → **Showcases** → pick **Workshop Showcase** → add your 5 items in order (1 through 5, left to right)

**Option B — Manual upload:**

1. Download the ZIP and extract the 5 GIFs
2. Go to the [Steam Workshop Upload Page](https://steamcommunity.com/sharedfiles/edititem/767/3/)
3. Open your browser's DevTools console (F12 → Console tab) and paste:
   ```
   $J('#ConsumerAppID').val(480),$J('[name=file_type]').val(0),$J('[name=visibility]').val(0);
   ```
4. Set a title, upload panel 1 as the preview image, check the agreement, save
5. After selecting the file, also paste this in the console:
   ```
   $J('#image_width').val(1000).attr('id',''),$J('#image_height').val(1).attr('id','');
   ```
6. Repeat steps 2-5 for all 5 panels
7. Go to **Edit Profile** → **Showcases** → **Workshop Showcase** and add them in order

---

## FAQ

**Why do my panels look squished / have black bars on Steam?**

The default panel width is 122px because that's what Steam displays Workshop items at. If you upload at a different width, Steam scales and letterboxes them. Stick to 122px wide.

**Why are my panels out of sync on my profile?**

This is normal — Steam loads each GIF separately, so they start at slightly different times on the first page load. Refreshing the page (once they're cached) syncs them up. This tool ensures all panels have identical frame counts and timing to minimize drift.

**What's the file size limit?**

About 5 MB per panel when uploading through the browser. The tool auto-optimizes to fit — it reduces colors and FPS uniformly across all panels if any panel is over the limit.

**Do I need Chrome for the auto-upload?**

Yes, the auto-upload uses Selenium to control Chrome. If you don't have Chrome or don't want to use it, just download the panels and upload them manually.

**Can I use this for the Artwork Showcase too?**

This is specifically for the Workshop Showcase (5 items in a row). The Artwork Showcase has different dimensions and a different upload process.

---

## License

MIT — do whatever you want with it.
