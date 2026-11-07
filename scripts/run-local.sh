#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Building the frontend"
(cd frontend && npm ci && npm run build)

echo "==> Preparing the backend"
cd backend
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
.venv/bin/python -m pip install --upgrade pip >/dev/null
.venv/bin/pip install -r requirements.txt

echo "==> Starting DocuEase on http://localhost:${PORT:-8000}"
exec .venv/bin/uvicorn main:app --host 0.0.0.0 --port "${PORT:-8000}"
