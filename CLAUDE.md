# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**YOLO Deck** is a self-hosted web platform that orchestrates `claude-yolo` (Claude Code running headless) in isolated Docker containers. Users select a project, enter a prompt, and the platform spins up a container that runs Claude Code against a Git worktree copy of that project, streaming output back via WebSocket.

The full specification is in `SPEC.md` (German). All code should follow the architecture and patterns described there.

## Architecture

Three-tier system: **Next.js frontend** (port 3000) → **FastAPI backend** (port 8000) → **Docker containers** (one per run).

- **Frontend** (`frontend/`): Next.js with TypeScript, Tailwind CSS, App Router, `src/` directory. Communicates via REST (`/api/*`) for actions and WebSocket (`/ws/run/{run_id}`) for live streaming.
- **Backend** (`backend/`): FastAPI (Python 3.11+). Manages projects (Git repos in `projects/`), creates ephemeral workspace clones in `workspaces/`, launches Docker containers via the Docker SDK, and streams container logs over WebSocket.
- **Container image**: Built from `docker/Dockerfile` (Node 20, Claude Code via npm). The backend invokes `claude -p` directly with the user's prompt. Auth works via subscription credentials (`~/.claude` mounted into container).

Key data flow: `POST /api/run` → clone project to workspace → start container → client connects `ws://…/ws/run/{run_id}` → backend streams container stdout → container finishes → cleanup.

## Build & Run Commands

```bash
# Build the claude-code container image
docker build -t claude-code:latest -f docker/Dockerfile docker/

# Start everything via Docker Compose
docker compose up --build -d

# Backend only (local dev)
cd backend && pip install -e . && uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Frontend only (local dev)
cd frontend && npm install && npm run dev
```

## Configuration

All backend settings use the `YOLO_` env prefix (via pydantic-settings). Key vars:
- `YOLO_ANTHROPIC_API_KEY` — optional, only needed if not using subscription auth
- `YOLO_CLAUDE_HOME`, `YOLO_CLAUDE_JSON` — paths to subscription credentials (default: `~/.claude`, `~/.claude.json`)
- `YOLO_PROJECTS_DIR`, `YOLO_WORKSPACES_DIR` — default to `/app/projects`, `/app/workspaces`
- `YOLO_DOCKER_IMAGE` — defaults to `claude-code`
- `YOLO_CONTAINER_NETWORK_MODE` — defaults to `none` (network isolation)

Frontend uses `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL`.

## Key Design Decisions

- **Network isolation**: Containers run with `network_mode: none` by default — no internet access.
- **Ephemeral workspaces**: Each run gets a local Git clone so the original project repo is never modified directly.
- **Feature branches**: The backend's `ProjectManager` creates a `claude-yolo/<timestamp>` branch in the workspace before starting the container.
- **Non-root containers**: The Dockerfile creates a `claude` user for least-privilege execution.
- **In-memory run tracking**: `DockerManager.active_runs` is a dict — no database yet. Run history is lost on restart.

## Language

The spec and UI strings are in German. Maintain German for user-facing strings (UI labels). Code comments and variable names use English.
