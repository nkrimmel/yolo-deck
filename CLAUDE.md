# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**YOLO Deck** is a self-hosted web platform that orchestrates Claude Code (`claude` CLI) in isolated Docker containers. Users select a project, enter a prompt, and the platform spins up a container running Claude Code against a Git clone of that project, streaming output back to the browser or Telegram.

The full specification is in `SPEC.md` (German).

## Architecture

Three-tier system: **Next.js frontend** (port 3000) → **FastAPI backend** (port 8000) → **Docker containers** (one per run). A **Telegram bot** provides a second frontend using the same backend API.

- **Frontend** (`frontend/`): Next.js 15, React 19, TypeScript, Tailwind CSS v4, App Router with `src/` directory. Single-page dashboard — no sub-routes. Communicates via REST polling (every 2s) to `/api/*` endpoints. A WebSocket endpoint exists at `/ws/run/{run_id}` but the frontend uses HTTP polling instead.
- **Backend** (`backend/`): FastAPI (Python 3.11+). Manages projects (symlinked repos in `projects/`), creates ephemeral workspace clones in `workspaces/`, launches Docker containers via Docker SDK, and streams container logs.
- **Telegram Bot** (`backend/app/telegram_bot.py`): Separate async process using `python-telegram-bot`. Calls the backend API via `httpx` — does not import backend managers directly. Entrypoint: `backend/run_telegram.py`.
- **Container image**: Built from `docker/Dockerfile` (Node 20, Claude Code via npm). The backend launches containers with `claude -p <prompt> --output-format stream-json --dangerously-skip-permissions --verbose`. Auth works via subscription credentials (`~/.claude` mounted into container).

### Data Flow

`POST /api/run` → `git clone --local` project to `workspaces/` → create `claude-yolo/<timestamp>` branch → start Docker container → frontend polls `GET /api/run/{id}` every 2s → backend reads container logs → container finishes → sync branch back to project.

## Build & Run Commands

```bash
# Build the claude-code container image (required first time)
docker build -t claude-code:latest -f docker/Dockerfile docker/

# Start everything via Docker Compose (backend + frontend + telegram-bot)
docker compose up --build -d

# Or use the helper script (validates auth, builds image, starts compose)
./run.sh

# Backend only (local dev)
cd backend && pip install -e . && uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Frontend only (local dev)
cd frontend && npm install && npm run dev

# Telegram bot only (requires running backend)
cd backend && python run_telegram.py
```

No tests or linting tools are configured.

## Configuration

All backend settings use the `YOLO_` env prefix (via pydantic-settings). Config loads from `.env` in both `backend/` and repo root. Auto-detects local dev vs Docker paths (checks if `/app/projects` exists).

Key vars:
- `YOLO_ANTHROPIC_API_KEY` — optional, only needed if not using subscription auth
- `YOLO_CLAUDE_HOME`, `YOLO_CLAUDE_JSON` — paths to subscription credentials (default: `~/.claude`, `~/.claude.json`)
- `YOLO_CLAUDE_HOME_HOST`, `YOLO_CLAUDE_JSON_HOST` — host paths for Docker volume mounts (needed when backend runs in Docker)
- `YOLO_PROJECTS_DIR`, `YOLO_WORKSPACES_DIR` — default to `/app/projects`, `/app/workspaces` (Docker) or `<repo>/projects`, `<repo>/workspaces` (local)
- `YOLO_DOCKER_IMAGE` — defaults to `claude-code`
- `YOLO_DEFAULT_MODEL` — defaults to `claude-sonnet-4-20250514`
- `YOLO_BROWSE_ROOT`, `YOLO_HOST_HOME_PATH` — directory browser root path and host path translation
- `YOLO_TELEGRAM_BOT_TOKEN`, `YOLO_TELEGRAM_ALLOWED_USERS` — Telegram bot config

Frontend uses `NEXT_PUBLIC_API_URL` (default `http://localhost:8000`) and `NEXT_PUBLIC_WS_URL`.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects` | List all projects |
| `GET` | `/api/projects/{id}` | Get project details |
| `POST` | `/api/projects` | Add project by path (creates symlink) |
| `DELETE` | `/api/projects/{id}` | Remove project symlink |
| `POST` | `/api/run` | Start a new run → returns `run_id` |
| `GET` | `/api/run/{id}` | Get run status, logs, exit_code |
| `POST` | `/api/run/{id}/stop` | Stop a running container |
| `GET` | `/api/runs` | List active runs |
| `GET` | `/api/browse?path=~` | Browse host directories |
| `WebSocket` | `/ws/run/{run_id}` | Stream `StreamMessage` JSON (exists but web UI uses polling) |

## Key Design Decisions

- **Polling over WebSocket**: Frontend and Telegram bot both poll `GET /api/run/{id}` instead of maintaining WebSocket connections. The WebSocket endpoint exists but is unused by current clients.
- **Ephemeral workspaces**: Each run gets a `git clone --local` (fast, uses hardlinks) so the original project repo is never modified. Workspace is `workspaces/<project>-<timestamp>`.
- **Feature branches**: `ProjectManager` creates a `claude-yolo/<timestamp>` branch in the workspace. After container exits, branch is pushed back to the original repo.
- **Non-root containers**: The Dockerfile creates a `claude` user. Containers also get `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` for multi-agent support.
- **In-memory run tracking**: `DockerManager.active_runs` is a dict — no database. Run history is lost on restart.
- **Log parsing**: Both frontend (`lib/logParser.ts`) and backend (`app/log_parser.py`) parse Claude's `stream-json` output format into readable lines. The parsers handle assistant messages, tool_use blocks, stream_events, and result messages.
- **Project symlinks**: Projects are added via symlink into `projects/` dir, originals are never touched.

## Language

The spec (`SPEC.md`) and UI strings are in German. Maintain German for user-facing strings (UI labels, button text, status messages). Code comments and variable names use English.
