#!/usr/bin/env bash
# Build the app, serve it on one port, and expose it through a temporary
# Cloudflare quick tunnel. Great for a quick feedback round with teammates.
# The machine must stay awake while people use the link.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8000}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is required. Install it with:"
  echo "  brew install cloudflared"
  echo "or follow https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

"$ROOT/scripts/run-local.sh" &
APP_PID=$!
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT

echo "==> Waiting for DocuEase on port ${PORT}"
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "DocuEase did not start in time."
  exit 1
fi

echo "==> Creating a temporary public URL (Ctrl+C to stop)"
exec cloudflared tunnel --url "http://127.0.0.1:${PORT}"
