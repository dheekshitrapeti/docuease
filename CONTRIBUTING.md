# Contributing to DocuEase

Thanks for helping improve DocuEase. This guide covers local setup, checks, and how to send a change.

## Setup

Requirements: Node.js 20+, npm, Python 3.10+.

```bash
# Backend
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Frontend (second terminal)
cd frontend
npm install
npm run dev
```

The frontend runs at http://localhost:5173 and expects the API at http://localhost:8000.

## Single-service mode

To test the production shape (FastAPI serving the built frontend):

```bash
./scripts/run-local.sh
# open http://localhost:8000
```

Or with Docker:

```bash
docker compose up --build
```

## Before opening a pull request

Run both checks:

```bash
cd frontend && npm run build
cd ../backend && .venv/bin/python -m py_compile main.py
```

The same checks run in CI for every push and pull request.

## Project layout

- `backend/main.py`: extraction, validation, PDF export, DOCX export, optional static frontend serving.
- `frontend/src/App.tsx`: app shell, history, sources, export, editor layout.
- `frontend/src/components/PageView.tsx`: page rendering, text editing, annotation creation.
- `frontend/src/components/Inspector.tsx`: properties panel.
- `frontend/src/api.ts`, `types.ts`, `utils.ts`: shared client code.
- `DEPLOYMENT.md`: hosting and team-access instructions.

## Guidelines

- Keep changes focused; one feature or fix per pull request.
- Follow the existing TypeScript/React and Python style. Do not add comments unless they explain non-obvious behavior.
- Do not commit secrets, `.env` files, uploaded PDFs, or generated build output.
- Add or update documentation when behavior changes.
- Test the affected flow manually: upload, edit text, add an annotation, export PDF, and export DOCX when relevant.
- Coordinate larger changes in an issue first.

## Reporting bugs and requesting features

Use the GitHub issue templates:

- Bug report: include the browser, steps to reproduce, expected/actual behavior, and a screenshot if possible.
- Feature request: describe the use case and the simplest version of the feature.

Do not attach confidential PDFs. Use a minimal, non-sensitive sample.

## Pull requests

1. Fork the repository and create a branch: `feat/description` or `fix/description`.
2. Make the change and run the checks above.
3. Open a pull request with a short description, screenshots for UI changes, and any limitations.
4. Link the related issue if there is one.

By contributing, you agree that your changes can be distributed under the project's license.
