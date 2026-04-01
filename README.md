# YOLO Deck

A self-hosted web platform that orchestrates **Claude Code** in isolated Docker containers. Select a project, enter a prompt, and YOLO Deck spins up a container that runs the `claude` CLI against your codebase — with live output streaming back to your browser or Telegram.

## Architecture

```
┌─────────────┐     WebSocket / REST      ┌──────────────┐
│   Web UI    │◄────────────────────────►  │   Backend    │
│  (Next.js)  │                            │  (FastAPI)   │
└─────────────┘                            └──────┬───────┘
                                                  │
┌─────────────┐     HTTP (Long Polling)           │ Docker SDK
│  Telegram   │◄──────────────────────────────────┤
│    Bot      │                                   │
└─────────────┘                            ┌──────▼───────┐
                                           │  Container    │
                                           │  Orchestrator │
                                           └──────┬───────┘
                                                  │
                              ┌────────────┬──────┴──────┬────────────┐
                              ▼            ▼             ▼            ▼
                         ┌─────────┐ ┌─────────┐  ┌─────────┐ ┌─────────┐
                         │Project A│ │Project B│  │Project C│ │Project N│
                         │Container│ │Container│  │Container│ │Container│
                         └─────────┘ └─────────┘  └─────────┘ └─────────┘
```

**Three tiers:** Next.js frontend (port 3000) → FastAPI backend (port 8000) → Docker containers (one per run).

Each container:
- Runs the `claude-code` Docker image with the `claude` CLI
- Gets the project directory mounted at `/workspace`
- Executes Claude Code headless with `--dangerously-skip-permissions`
- Streams output via stdout back to the backend → WebSocket → UI

**Two frontends:**
- **Web UI** — full dashboard with project browser, model selection, multi-session support
- **Telegram Bot** — mobile-friendly, same backend API, live output streaming

## Prerequisites

- Docker Engine ≥ 24.0 (with Compose v2)
- Node.js ≥ 20
- Python ≥ 3.11
- Git
- Claude Code subscription auth (`~/.claude`) or Anthropic API key
- Linux host recommended (macOS works, volumes are slower)

## Quick Start

### 1. Clone and configure

```bash
git clone <repo-url> yolo-deck && cd yolo-deck
cp .env.example .env
# Edit .env if needed (see Configuration below)
```

### 2. Build the Claude Code container image

```bash
docker build -t claude-code:latest -f docker/Dockerfile docker/
```

### 3. Start via Docker Compose

```bash
docker compose up --build -d
open http://localhost:3000
```

### 4. Add projects

Add projects via the Web UI directory browser, or manually:

```bash
ln -s /path/to/your/repo projects/my-app
```

## Local Development

```bash
# Backend
cd backend && pip install -e . && uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Frontend (separate terminal)
cd frontend && npm install && npm run dev

# Telegram Bot (separate terminal, requires running backend)
cd backend && python run_telegram.py
```

## Telegram Bot

The Telegram bot provides mobile access to YOLO Deck. It calls the FastAPI backend, so all runs are visible in both the Web UI and Telegram.

### Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) on Telegram
2. Get your user ID via [@userinfobot](https://t.me/userinfobot)
3. Add to `.env`:

```bash
YOLO_TELEGRAM_BOT_TOKEN=7123456789:AAF...
YOLO_TELEGRAM_ALLOWED_USERS=[123456789]
```

### Commands

| Command | Description |
|---|---|
| `/run` | Select a project, then send your prompt as a message |
| `/projects` | List available projects |
| `/status` | Show active runs |
| `/stop` | Stop a running container |

## Configuration

All backend settings use the `YOLO_` env prefix (via pydantic-settings):

| Variable | Description | Default |
|---|---|---|
| `YOLO_ANTHROPIC_API_KEY` | API key (only if not using subscription auth) | — |
| `YOLO_CLAUDE_HOME` | Path to subscription credentials | `~/.claude` |
| `YOLO_CLAUDE_JSON` | Path to claude.json | `~/.claude.json` |
| `YOLO_PROJECTS_DIR` | Directory containing projects | `/app/projects` |
| `YOLO_WORKSPACES_DIR` | Directory for ephemeral workspace clones | `/app/workspaces` |
| `YOLO_DOCKER_IMAGE` | Docker image for runs | `claude-code` |
| `YOLO_DEFAULT_MODEL` | Default Claude model | `claude-sonnet-4-20250514` |
| `YOLO_TELEGRAM_BOT_TOKEN` | Telegram bot token | — |
| `YOLO_TELEGRAM_ALLOWED_USERS` | Whitelisted Telegram user IDs | `[]` |

Frontend: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`.

## Project Structure

```
yolo-deck/
├── docker/
│   └── Dockerfile              # Claude Code container image
├── backend/
│   ├── pyproject.toml
│   ├── Dockerfile.backend      # Backend container image
│   ├── run_telegram.py         # Telegram bot entrypoint
│   └── app/
│       ├── main.py             # FastAPI application
│       ├── config.py           # Settings (pydantic-settings)
│       ├── docker_manager.py   # Container orchestration
│       ├── project_manager.py  # Project management (Git)
│       ├── models.py           # Pydantic models
│       ├── telegram_bot.py     # Telegram bot
│       └── log_parser.py       # Claude stream-json parser
├── frontend/
│   ├── package.json
│   └── src/
│       ├── app/                # Next.js App Router
│       ├── components/         # React components
│       └── lib/                # API client, types, log parser
├── projects/                   # Symlinked project repos
├── docker-compose.yml
└── .env.example
```

## Security

| Measure | Description |
|---|---|
| Non-root containers | `USER claude` in Dockerfile for least privilege |
| API key isolation | Keys only in backend, never exposed to frontend |
| Telegram whitelist | `YOLO_TELEGRAM_ALLOWED_USERS` restricts bot access by user ID |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects` | List all projects |
| `GET` | `/api/projects/{id}` | Get project details |
| `POST` | `/api/projects` | Add project by path |
| `DELETE` | `/api/projects/{id}` | Remove project |
| `POST` | `/api/run` | Start a new run |
| `GET` | `/api/run/{id}` | Get run status and logs |
| `POST` | `/api/run/{id}/stop` | Stop a running container |
| `GET` | `/api/runs` | List active runs |
| `GET` | `/api/browse?path=~` | Browse host directories |

## License

MIT
