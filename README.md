# Image-to-Image Library Manager

A local desktop-style app for managing, generating, and reviewing bulk image-to-image edits using xAI's **Grok Imagine API** (`grok-imagine-image-quality`). Built for working through a large backlog of source images across one or more projects, with a persistent library, a reusable prompt palette, and an A/B slider for reviewing results.

---

## Features

- **Multi-Project Library:** Organize source images and results into separate projects (e.g. one big backlog + several smaller side projects), switchable from the project menu in the top bar, which lists every project with its source/result/reference counts, keeps the 4 most recently opened at the top, and lets you rename or trash a project in place.
- **Global Prompt Palette:** Save, edit, and reuse prompt text across every project.
- **Bulk Ingestion:** Drag-and-drop or file-browser upload of source images into the current project.
- **Review Workflow:** Three-tier evaluation (YES / MAYBE / NO) with hotkeys (`y` / `m` / `n`, arrow keys to move between images), and a draggable **A/B comparison slider** (source vs. result).
- **Crop / Pre-process Source:** The crop button in the viewer's mode bar opens an editor to rotate the source in 90° steps and crop it to a region that can extend past the image edges (padded with a solid color or a blurred copy of the image). Works with every engine. Only the settings are stored — the original source file is never modified — and the processed image (cached) is what gets sent to the service.
- **Multiple Results per Image:** Generate several variants per source image and toggle which one is "active" for review/export.
- **Batch Export:** Export approved (or any status) results as a zip — either clean result images, or side-by-side A/B composites.
- **Local & Persistent:** Everything lives in a single `workspace/` folder (SQLite DB + image files + config), portable and gitignored.

---

## Setup & Installation

### 1. Create a Python Virtual Environment (Recommended)

```powershell
cd "F:\code\krets\grok_img2img"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### 2. Install Dependencies

```powershell
pip install -r requirements.txt
```

---

## Configuration

Provide your xAI API Key one of these ways:

1. **In-app Settings dialog** (recommended) — click **Settings** in the top bar; the key is saved to `workspace/config.json`.
2. **Environment Variable:** `XAI_API_KEY`.
3. **`.env` File:** create a `.env` file in the project folder:
   ```env
   XAI_API_KEY=your_xai_api_key_here
   ```

`workspace/` (created on first run) holds `config.json`, `library.db`, `source_images/`, `result_images/`, and `exports/` — it's gitignored since it contains your API key and image library.

---

## Running the App

```powershell
python server.py
```

This starts a local FastAPI server on `http://127.0.0.1:8765`. Set `OPEN_BROWSER=1` (env var) if you want it to also open your default browser on startup — off by default so restarts don't keep popping new windows/tabs.

### Usage

1. Create a project (or use the default one) from the top bar.
2. Upload source images via drag-and-drop or the sidebar's "+ Upload images" control.
3. Select an image, pick or write a prompt, and click **Generate**.
4. Use the A/B slider to compare source vs. result; mark it YES / MAYBE / NO with buttons or hotkeys.
5. Generate additional variants for the same image if needed — switch the active one from the Results dropdown.
6. When ready, use **Export** to pull out approved results (clean or side-by-side) as a zip.

---

## Standalone CLI

`grok_img2img.py` also still works as a one-off CLI tool (no library/project tracking), useful for quick single edits without the app:

```powershell
python grok_img2img.py -i input.jpg -p "Convert this scene into a cyberpunk cityscape at night" -o output.png
```

Run `python grok_img2img.py --help` for all options (aspect ratio, max dimension, image-to-video mode, etc).
