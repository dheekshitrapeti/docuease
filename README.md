# DocuEase — layout-preserving PDF editor

DocuEase is a real PDF editor rather than a PDF-to-text converter. It opens a PDF, keeps the original pages intact, and writes only your changes on top of them. Untouched fonts, images, tables and vector art stay exactly where they were.

Stack: React + TypeScript + Vite on the frontend, FastAPI + PyMuPDF on the backend.

## Features

- Open one PDF, or merge several PDFs into one document.
- Edit existing text in place: double-click a text run, change the words, size, color, weight, italics or alignment.
- Remove text runs (a white patch covers the original) and restore them later.
- Annotate with text boxes, images, highlights, rectangles, ellipses, lines, freehand ink, whiteout patches and sticky notes.
- Move and resize annotations, reorder their z-index, and change their styles.
- Rotate, reorder, duplicate, delete and insert blank pages.
- Undo/redo (up to 80 steps), zoom, page thumbnails and keyboard tool shortcuts.
- Export the edited document as PDF (layout preserved) or editable DOCX.

## Requirements

- Node.js 20+ and npm
- Python 3.10+

## Run locally

### 1. Start the API

```bash
cd backend
python -m venv .venv
# macOS/Linux
source .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

- Health check: http://localhost:8000/health
- Interactive API docs: http://localhost:8000/docs

### 2. Start the frontend in a second terminal

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. To point the frontend at another API address, create `frontend/.env.local` with `VITE_API_URL=http://localhost:8000`.

## Share it with your team

The production setup is a single service: FastAPI serves both the API and the built React app, so teammates only need one URL.

**Quick temporary link (no account):**

```bash
brew install cloudflared   # once
./scripts/share.sh
```

The script builds the app, starts it on port 8000, and prints a `https://...trycloudflare.com` URL. Your computer must stay awake.

**Persistent free deployment:** push the project to GitHub and deploy it with Render using the included `render.yaml` blueprint. The full walkthrough, Docker/self-host instructions, split frontend/backend setup, environment variables, and troubleshooting are in [DEPLOYMENT.md](DEPLOYMENT.md).

**Teammate contributions:** use the templates in `.github/ISSUE_TEMPLATE/` for feedback and follow [CONTRIBUTING.md](CONTRIBUTING.md) for local setup and pull requests. CI builds the frontend and compiles the backend on every push and pull request.

To test the single-service shape locally:

```bash
./scripts/run-local.sh
# open http://localhost:8000
```


## How it works

### Preview

`POST /extract` renders each page at 1.7x with PyMuPDF and returns:

- a background image for the page (the untouched original),
- every selectable text run with its bounding box, font, size, color and alignment in display coordinates,
- page size and rotation,
- flags for text and images.

The frontend draws the background image, overlays invisible hit areas for each text run, and lets you edit or annotate on top. The original page is never rebuilt from scratch.

### Export

`POST /export/pdf` accepts the original files plus a page-by-page payload:

- `source` is the source page index, or `null` for a blank page.
- `rotation` is the absolute display rotation.
- `textEdits` lists text runs that changed. Each one redacts the original run and inserts the replacement at the same location/style.
- `overlays` lists annotations to draw on top of the page.

The backend copies untouched pages with `insert_pdf`, applies redactions and inserts, then writes annotations in document order. Because of this, everything you did not edit remains byte-for-byte content from the source PDF.

### Coordinate model

PyMuPDF reports text boxes in unrotated page space. The API multiplies them by `page.rotation_matrix` so the frontend always works in display coordinates. On export, after `page.set_rotation(...)`, the backend multiplies boxes by `page.derotation_matrix` before redacting/inserting. The frontend rotates boxes clockwise for 90/180/270 degree page turns, matching PyMuPDF's own rotation math.

Edited runs keep the original font: the backend re-embeds the exact font when the PDF carries a full copy, finds the same family on the system when the PDF only has a subset, and only then falls back to a Base-14 font. Replacement text is anchored to the original baseline and line spacing, and characters the primary font does not cover (symbols, CJK, emoji) are drawn with a fallback font.

## API summary

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Service status |
| `POST` | `/extract` | Multipart PDF upload → page backgrounds plus text blocks |
| `POST` | `/export/pdf` | Multipart `files` + JSON `payload` → edited PDF |
| `POST` | `/export/docx` | JSON page text → editable Word document |
| `POST` | `/export/html/pdf` | Legacy text-only HTML → PDF export |

Limits: 25 MB per file, 300 pages, 12 files, 500 annotations.

## Project layout

```
backend/main.py                     FastAPI app: extraction, PDF/DOCX export
frontend/src/App.tsx                App shell, history, sources, export, editor layout
frontend/src/components/PageView.tsx  Page rendering, text editing, annotation creation
frontend/src/components/Inspector.tsx Right-hand properties panel
frontend/src/api.ts                 API client and extraction → editor-page mapping
frontend/src/types.ts               Shared types
frontend/src/utils.ts               Rotation math, colors, font mapping, ids
frontend/src/styles.css             Landing page and editor styles
```

## Current limitations

- Scanned/image-only PDFs have no selectable text. You can still annotate them, rotate/reorder pages and export, but there are no real text runs to edit.
- Replaced text reuses the original embedded font when it is fully embedded. When the PDF only embeds a subset, the backend matches the family against fonts installed on the server; custom fonts that are not installed will use the closest fallback. Text that grows wider can extend past its original box.
- Edited text is covered by a white patch in the preview; the export redacts the original glyphs properly. On colored backgrounds the preview patch may not match perfectly.
- DOCX export is a text-and-style export, not a pixel-perfect conversion of the PDF layout.
- Files are processed in memory and are not written to disk by the server.
- The PDF signature is validated as a file-format check, not as a security boundary. For production, add authentication, rate limits, request timeouts, malware scanning, strict CORS and a clear retention policy.
