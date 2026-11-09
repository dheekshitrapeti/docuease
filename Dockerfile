# syntax=docker/dockerfile:1

# ---- Build the React app -------------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
# Leave empty for same-origin deployments. Override with
# --build-arg VITE_API_URL=https://your-api.example.com for split deployments.
ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

# ---- Runtime -------------------------------------------------------------
FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    FRONTEND_DIR=/app/frontend/dist \
    PORT=8000

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        fontconfig \
        fonts-dejavu-core \
        fonts-dejavu-extra \
        fonts-liberation \
        fonts-crosextra-carlito \
        fonts-crosextra-caladea \
        fonts-lato \
        fonts-roboto \
        fonts-open-sans \
        fonts-inter \
        fonts-montserrat \
        fonts-nunito \
        fonts-ibm-plex \
        fonts-noto-core \
        fonts-noto-color-emoji \
        fonts-urw-base35 \
        fonts-ebgaramond \
        fonts-texgyre \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

COPY backend/ /app/backend/
COPY --from=frontend /app/frontend/dist /app/frontend/dist

WORKDIR /app/backend
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-8000}/health" || exit 1

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
