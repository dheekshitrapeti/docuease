# Deploying DocuEase

DocuEase is set up as a **single service**: FastAPI serves the API and the built React app from the same origin. That means one URL for your teammates, no CORS setup, and no separate frontend host.

```
Browser ──► https://your-docuease-url
              ├── /            React app (frontend/dist)
              ├── /extract     PDF upload + extraction
              ├── /export/pdf  PDF export
              └── /export/docx Word export
```

## Option 1 — Temporary URL in 2 minutes (no account)

Best for a quick feedback round. Your computer must stay awake, and the URL changes each time.

```bash
brew install cloudflared   # once
./scripts/share.sh
```

The script builds the frontend, starts the app on port 8000, and prints a `https://...trycloudflare.com` URL. Share that URL. Press `Ctrl+C` to stop.

If you already have the app running on port 8000, you can skip the script:

```bash
cloudflared tunnel --url http://localhost:8000
```

## Option 2 — Persistent free deployment on Render (recommended)

This gives the team a stable URL, deploys automatically on every push, and supports contributions.

### 1. Put the project in its own GitHub repository

The project is currently inside your home directory. Create a separate repository for it:

```bash
cd /Users/dheekshitrapeti/Downloads/docuease-project
git init
git add .
git commit -m "DocuEase PDF editor"
gh repo create docuease --public --source=. --push
```

If you do not have `gh`, create an empty repository on https://github.com/new, then:

```bash
git remote add origin https://github.com/<your-username>/docuease.git
git branch -M main
git push -u origin main
```

### 2. Deploy with the Render Blueprint

1. Create a free account at https://render.com.
2. Click **New +** → **Blueprint**.
3. Connect your GitHub account and select the `docuease` repository.
4. Render reads `render.yaml` and creates one Docker web service.
5. Click **Apply**. The first build takes a few minutes.
6. Share the URL Render gives you, for example `https://docuease-xxxx.onrender.com`.

Every push to the connected branch redeploys automatically. Pull requests can also get preview environments if you enable them in Render.

### Free-tier notes

- The free service sleeps after about 15 minutes without traffic. The first request after sleeping can take 30–60 seconds.
- The free instance has limited memory. Uploads are capped at 25 MB and 300 pages. For heavy use, upgrade the plan.
- No files are stored on the server; PDFs are processed in memory.

## Option 3 — Self-host with Docker

```bash
docker compose up --build
# open http://localhost:8000
```

Or without Compose:

```bash
docker build -t docuease .
docker run --rm -p 8000:8000 -e PORT=8000 docuease
```

The container serves the built frontend and the API together.

## Option 4 — Split frontend and backend

Use this if you want the frontend on Vercel/Netlify and the API elsewhere.

1. Build the frontend with the API URL baked in:

   ```bash
   cd frontend
   VITE_API_URL=https://your-api.example.com npm run build
   ```

2. On the API host, set `CORS_ORIGINS` to the frontend origin:

   ```bash
   CORS_ORIGINS=https://your-frontend.example.com uvicorn main:app --host 0.0.0.0 --port 8000
   ```

3. Deploy `frontend/dist` to Vercel/Netlify/Cloudflare Pages. For Render, set the API service's environment variable `CORS_ORIGINS=https://your-frontend.vercel.app`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8000` | Port the API listens on |
| `FRONTEND_DIR` | `../frontend/dist` | Folder containing the built React app |
| `CORS_ORIGINS` | localhost dev origins | Comma-separated allowed origins for split deployments |
| `VITE_API_URL` | dev: `http://localhost:8000`; prod: same origin | API base URL baked into the frontend at build time |

`VITE_API_URL` is a **build-time** variable. Rebuild the frontend after changing it.

## Shared feedback and contributions

1. Keep the GitHub repository public (or add teammates as collaborators).
2. Ask the team to open issues with the templates in `.github/ISSUE_TEMPLATE/`.
3. Contributions follow `CONTRIBUTING.md`.
4. The GitHub Actions workflow in `.github/workflows/ci.yml` builds the frontend and compiles the backend on every push and pull request.
5. For a quick feedback loop, pin the deployed URL in the repository description and README.

## Security and abuse

A public URL means anyone with the link can upload files. DocuEase processes everything in memory and does not persist uploads, but for a public production deployment consider:

- a reverse proxy or hosting-level rate limits,
- file-size and page limits (already enforced),
- authentication if the documents are sensitive,
- restricting `CORS_ORIGINS` if you split frontend and backend,
- a retention/privacy note for your team.

PDF signature validation is a file-format check, not a security boundary. Do not treat this demo as a hardened document service.

## Troubleshooting

- **Frontend shows "Check that the FastAPI backend is running"**: open the deployed URL's `/health`. If it fails, check the host logs. In split deployments, confirm `VITE_API_URL` and `CORS_ORIGINS`.
- **`/` shows JSON instead of the app**: the frontend was not built. Run `cd frontend && npm run build` or use the Docker image, which builds it.
- **Docker build fails on `npm ci`**: make sure `frontend/package-lock.json` is committed.
- **Free instance is slow after idle**: wait for the cold start, or use a paid instance.
