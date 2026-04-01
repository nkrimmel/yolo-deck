# YOLO Deck

Eine selbst gehostete Web-Plattform, die **Claude Code** in isolierten Docker-Containern orchestriert. Projekt auswählen, Prompt eingeben, und YOLO Deck startet einen Container, der die `claude` CLI gegen eine Git-Worktree-Kopie des Projekts ausführt — mit Live-Streaming des Outputs über WebSocket.

## Architektur

```
┌─────────────┐     WebSocket / REST      ┌──────────────┐
│   Web UI    │◄────────────────────────►  │   Backend    │
│  (Next.js)  │                            │  (FastAPI)   │
└─────────────┘                            └──────┬───────┘
                                                  │ Docker SDK
                                           ┌──────▼───────┐
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

**Drei Schichten:** Next.js-Frontend (Port 3000) → FastAPI-Backend (Port 8000) → Docker-Container (einer pro Run).

Jeder Container:
- Wird aus dem `claude-code`-Image gestartet
- Bekommt eine Git-Worktree-Kopie des Projekts gemountet
- Führt Claude Code headless aus
- Streamt Output über stdout zurück ans Backend → WebSocket → UI

## Voraussetzungen

- Docker Engine ≥ 24.0 (mit Compose v2)
- Node.js ≥ 20
- Python ≥ 3.11
- Git
- Anthropic API Key mit Claude Code Zugang
- Linux-Host empfohlen (macOS funktioniert, Volumes sind langsamer)

## Schnellstart

### 1. Repository klonen und konfigurieren

```bash
git clone <repo-url> yolo-deck && cd yolo-deck
cp .env.example .env
# ANTHROPIC_API_KEY in .env eintragen
```

### 2. Projekte hinzufügen

Projekte als Git-Repos in den `projects/`-Ordner legen:

```bash
git clone https://github.com/user/my-app.git projects/my-app
```

### 3. Starten

```bash
# Claude Code Docker-Image bauen
docker build -t claude-code:latest -f docker/Dockerfile docker/

# Plattform starten
docker compose up --build -d

# Öffnen
open http://localhost:3000
```

## Lokale Entwicklung

```bash
# Backend
cd backend && pip install -e . && uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Frontend (in separatem Terminal)
cd frontend && npm install && npm run dev
```

## Konfiguration

Alle Backend-Einstellungen verwenden den `YOLO_`-Prefix (via pydantic-settings):

| Variable | Beschreibung | Standard |
|---|---|---|
| `YOLO_ANTHROPIC_API_KEY` | Anthropic API Key | — |
| `YOLO_CLAUDE_HOME` | Pfad zu Subscription-Credentials | `~/.claude` |
| `YOLO_CLAUDE_JSON` | Pfad zu claude.json | `~/.claude.json` |
| `YOLO_PROJECTS_DIR` | Verzeichnis der Projekte | `/app/projects` |
| `YOLO_WORKSPACES_DIR` | Verzeichnis für Arbeitskopien | `/app/workspaces` |
| `YOLO_DOCKER_IMAGE` | Docker-Image für Runs | `claude-code` |
| `YOLO_CONTAINER_NETWORK_MODE` | Netzwerkmodus der Container | `none` |

Frontend-Variablen: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`.

## Projektstruktur

```
yolo-deck/
├── docker/
│   └── Dockerfile              # Claude Code Container-Image
├── backend/
│   ├── pyproject.toml
│   └── app/
│       ├── main.py             # FastAPI Application
│       ├── config.py           # Konfiguration
│       ├── docker_manager.py   # Container-Orchestrierung
│       ├── project_manager.py  # Projekt-Verwaltung (Git)
│       └── models.py           # Pydantic-Modelle
├── frontend/
│   ├── package.json
│   └── src/
│       ├── app/                # Next.js App Router
│       ├── components/         # React-Komponenten
│       └── lib/                # API-Client & WebSocket-Hook
├── projects/                   # Gemountete Projekt-Repos
├── docker-compose.yml
└── .env.example
```

## Sicherheit

| Maßnahme | Beschreibung |
|---|---|
| Netzwerk-Isolation | Container laufen mit `network_mode: none` — kein Internetzugang |
| Resource Limits | Memory- und CPU-Limits verhindern Host-Überlastung |
| Git-Worktree-Kopie | Original-Repo bleibt unberührt |
| Feature-Branch | Alle Änderungen auf `claude-yolo/<timestamp>`-Branch, reviewbar vor Merge |
| Non-Root Container | `USER claude` im Dockerfile für Least Privilege |
| API Key Isolation | Key nur im Backend, nicht im Frontend exponiert |

## API-Endpunkte

| Methode | Pfad | Beschreibung |
|---|---|---|
| `GET` | `/api/projects` | Alle Projekte auflisten |
| `GET` | `/api/projects/{id}` | Einzelnes Projekt abfragen |
| `POST` | `/api/run` | Neuen Run starten |
| `POST` | `/api/run/{id}/stop` | Laufenden Run abbrechen |
| `GET` | `/api/runs` | Aktive Runs auflisten |
| `WS` | `/ws/run/{id}` | Live-Output eines Runs streamen |

## Lizenz

MIT
