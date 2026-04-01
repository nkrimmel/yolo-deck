# YOLO Deck — Setup-Anleitung

Die Steuerungszentrale für `claude-yolo`. Eine selbst gehostete Web-Plattform, die claude-yolo in isolierten Docker-Containern orchestriert und projektspezifische Änderungen per Prompt ermöglicht.

---

## Architektur-Überblick

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

Jeder Container:
- Wird aus dem `claude-yolo` Docker-Image gestartet
- Bekommt ein Projekt-Repo als Volume gemountet (als Git-Worktree-Kopie)
- Führt Claude Code headless aus
- Streamt Output über stdout zurück ans Backend → WebSocket → UI

---

## Voraussetzungen

- Docker Engine ≥ 24.0 (mit Compose v2)
- Node.js ≥ 20 (für Claude Code Installation und Frontend)
- Python ≥ 3.11 (für Backend)
- Git
- Anthropic API Key mit Claude Code Zugang
- Linux-Host empfohlen (macOS funktioniert, Volumes sind langsamer)

---

## Repo-Struktur

```
yolo-deck/
├── README.md
├── docker/
│   ├── Dockerfile              # Claude Code Container-Image
│   └── entrypoint.sh           # Container-Entrypoint
├── backend/
│   ├── pyproject.toml
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py             # FastAPI Application
│   │   ├── config.py           # Konfiguration
│   │   ├── docker_manager.py   # Container-Orchestrierung
│   │   ├── project_manager.py  # Projekt-Verwaltung (Git)
│   │   ├── ws_handler.py       # WebSocket-Streaming
│   │   └── models.py           # Pydantic-Modelle
│   └── tests/
├── frontend/
│   ├── package.json
│   ├── next.config.js
│   └── src/
│       ├── app/
│       │   ├── page.tsx        # Dashboard
│       │   └── project/
│       │       └── [id]/
│       │           └── page.tsx # Projekt-Ansicht
│       ├── components/
│       │   ├── ProjectList.tsx
│       │   ├── PromptInput.tsx
│       │   └── TerminalOutput.tsx
│       └── lib/
│           ├── api.ts
│           └── websocket.ts
├── projects/                    # Gemountete Projekt-Repos
│   └── .gitkeep
├── workspaces/                  # Git-Worktree-Kopien (ephemeral)
│   └── .gitkeep
├── docker-compose.yml
└── .env.example
```

---

## Phase 1 — Docker-Image mit Claude Code

### 1.1 Dockerfile erstellen

```dockerfile
# docker/Dockerfile
FROM node:20-bookworm

# Systempakete für typische Entwicklung
RUN apt-get update && apt-get install -y \
    git \
    curl \
    build-essential \
    python3 \
    python3-pip \
    jq \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Claude Code global aus dem offiziellen npm-Paket installieren
# Hinweis: Falls ein eigenes/fork-Repo verwendet wird, stattdessen:
#   COPY ./claude-code /opt/claude-code
#   RUN cd /opt/claude-code && npm install && npm link
RUN npm install -g @anthropic-ai/claude-code

# Arbeitsverzeichnis im Container
WORKDIR /workspace

# Entrypoint-Script
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Nicht-Root-User für Sicherheit (optional, aber empfohlen)
RUN useradd -m -s /bin/bash claude && \
    chown -R claude:claude /workspace
USER claude

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

### 1.2 Entrypoint-Script

```bash
#!/bin/bash
# docker/entrypoint.sh
set -euo pipefail

# ── Konfiguration aus Environment ──
PROMPT="${CLAUDE_PROMPT:?CLAUDE_PROMPT muss gesetzt sein}"
OUTPUT_FORMAT="${CLAUDE_OUTPUT_FORMAT:-stream-json}"
MAX_TURNS="${CLAUDE_MAX_TURNS:-50}"
MODEL="${CLAUDE_MODEL:-claude-sonnet-4-20250514}"

# ── Git-Konfiguration (damit Claude committen kann) ──
git config --global user.name "Claude YOLO"
git config --global user.email "claude-yolo@localhost"
git config --global --add safe.directory /workspace

# ── Feature-Branch erstellen ──
BRANCH_NAME="claude-yolo/$(date +%Y%m%d-%H%M%S)"
cd /workspace

if git rev-parse --git-dir > /dev/null 2>&1; then
    git checkout -b "$BRANCH_NAME"
    echo "▶ Arbeite auf Branch: $BRANCH_NAME"
else
    echo "⚠ Kein Git-Repo erkannt, arbeite direkt im Verzeichnis"
fi

# ── Claude Code ausführen ──
echo "▶ Starte Claude Code..."
echo "▶ Prompt: $PROMPT"
echo "▶ Model: $MODEL"
echo "---"

claude -p "$PROMPT" \
    --output-format "$OUTPUT_FORMAT" \
    --max-turns "$MAX_TURNS" \
    --model "$MODEL" \
    --verbose

EXIT_CODE=$?

# ── Änderungen committen ──
if git rev-parse --git-dir > /dev/null 2>&1; then
    if [ -n "$(git status --porcelain)" ]; then
        git add -A
        git commit -m "claude-yolo: $PROMPT"
        echo "---"
        echo "✅ Änderungen committed auf Branch: $BRANCH_NAME"
        echo "▶ Geänderte Dateien:"
        git diff --name-only HEAD~1
    else
        echo "---"
        echo "ℹ Keine Dateiänderungen vorgenommen."
    fi
fi

exit $EXIT_CODE
```

### 1.3 Image bauen

```bash
cd yolo-deck/
docker build -t claude-yolo:latest -f docker/Dockerfile docker/
```

### 1.4 Manueller Test

```bash
# Testlauf mit einem Beispielprojekt
docker run --rm \
    -v $(pwd)/projects/test-project:/workspace \
    -e ANTHROPIC_API_KEY="sk-ant-..." \
    -e CLAUDE_PROMPT="Erstelle eine README.md für dieses Projekt" \
    -e CLAUDE_MODEL="claude-sonnet-4-20250514" \
    --memory=2g \
    --cpus=2 \
    claude-yolo:latest
```

---

## Phase 2 — Backend (FastAPI)

### 2.1 Dependencies

```toml
# backend/pyproject.toml
[project]
name = "yolo-deck-backend"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.30.0",
    "docker>=7.0.0",
    "websockets>=13.0",
    "pydantic>=2.0",
    "pydantic-settings>=2.0",
    "gitpython>=3.1.40",
]
```

### 2.2 Konfiguration

```python
# backend/app/config.py
from pydantic_settings import BaseSettings
from pathlib import Path


class Settings(BaseSettings):
    # Pfade
    projects_dir: Path = Path("/app/projects")
    workspaces_dir: Path = Path("/app/workspaces")

    # Docker
    docker_image: str = "claude-yolo:latest"
    container_memory_limit: str = "4g"
    container_cpu_limit: float = 4.0
    container_network_mode: str = "none"  # Netzwerk-Isolation!

    # Claude
    anthropic_api_key: str
    default_model: str = "claude-sonnet-4-20250514"
    max_turns: int = 50

    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    allowed_origins: list[str] = ["http://localhost:3000"]

    model_config = {"env_file": ".env", "env_prefix": "YOLO_"}


settings = Settings()
```

### 2.3 Pydantic-Modelle

```python
# backend/app/models.py
from pydantic import BaseModel
from enum import Enum


class RunStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class ProjectInfo(BaseModel):
    id: str
    name: str
    path: str
    current_branch: str | None = None
    last_commit: str | None = None


class RunRequest(BaseModel):
    project_id: str
    prompt: str
    model: str | None = None
    max_turns: int | None = None


class RunResponse(BaseModel):
    run_id: str
    project_id: str
    status: RunStatus
    branch: str | None = None


class StreamMessage(BaseModel):
    type: str  # "output", "status", "error", "complete"
    data: str
    run_id: str
```

### 2.4 Projekt-Manager

```python
# backend/app/project_manager.py
import shutil
from pathlib import Path
from git import Repo, InvalidGitRepositoryError
from .config import settings
from .models import ProjectInfo


class ProjectManager:
    def list_projects(self) -> list[ProjectInfo]:
        """Alle Projekte im projects/-Verzeichnis auflisten."""
        projects = []
        for item in sorted(settings.projects_dir.iterdir()):
            if item.is_dir() and not item.name.startswith("."):
                info = self._get_project_info(item)
                projects.append(info)
        return projects

    def get_project(self, project_id: str) -> ProjectInfo:
        """Einzelnes Projekt laden."""
        path = settings.projects_dir / project_id
        if not path.exists():
            raise FileNotFoundError(f"Projekt '{project_id}' nicht gefunden")
        return self._get_project_info(path)

    def prepare_workspace(self, project_id: str) -> Path:
        """
        Erstellt eine Arbeitskopie des Projekts für den Container.
        Verwendet git clone (lokal), damit das Original unberührt bleibt.
        """
        source = settings.projects_dir / project_id
        if not source.exists():
            raise FileNotFoundError(f"Projekt '{project_id}' nicht gefunden")

        # Workspace-Verzeichnis: workspaces/<project_id>-<timestamp>
        import time
        timestamp = int(time.time())
        workspace = settings.workspaces_dir / f"{project_id}-{timestamp}"

        try:
            # Lokaler Git-Clone (schnell, hardlinks)
            Repo.clone_from(
                str(source),
                str(workspace),
                local=True,
                no_hardlinks=False,
            )
            # Remote auf Origin setzen (falls Push gewünscht)
            repo = Repo(workspace)
            repo.remotes.origin.set_url(str(source))
        except InvalidGitRepositoryError:
            # Kein Git-Repo → einfache Kopie
            shutil.copytree(source, workspace)

        return workspace

    def sync_back(self, workspace: Path, project_id: str) -> str | None:
        """
        Pusht den Claude-Branch zurück ins Original-Repo.
        Gibt den Branch-Namen zurück.
        """
        try:
            repo = Repo(workspace)
            branch = repo.active_branch.name
            if branch.startswith("claude-yolo/"):
                repo.remotes.origin.push(branch)
                return branch
        except Exception:
            pass
        return None

    def cleanup_workspace(self, workspace: Path):
        """Workspace-Kopie aufräumen."""
        if workspace.exists() and str(workspace).startswith(
            str(settings.workspaces_dir)
        ):
            shutil.rmtree(workspace)

    def _get_project_info(self, path: Path) -> ProjectInfo:
        info = ProjectInfo(id=path.name, name=path.name, path=str(path))
        try:
            repo = Repo(path)
            info.current_branch = str(repo.active_branch)
            if repo.head.is_valid():
                info.last_commit = repo.head.commit.message.strip()[:80]
        except (InvalidGitRepositoryError, TypeError, ValueError):
            pass
        return info
```

### 2.5 Docker-Manager

```python
# backend/app/docker_manager.py
import asyncio
import uuid
import docker
from pathlib import Path
from .config import settings
from .models import RunStatus


class DockerManager:
    def __init__(self):
        self.client = docker.from_env()
        self.active_runs: dict[str, dict] = {}

    async def start_run(
        self,
        run_id: str,
        workspace_path: Path,
        prompt: str,
        model: str | None = None,
        max_turns: int | None = None,
    ) -> str:
        """
        Startet einen Claude Code Container.
        Gibt die Container-ID zurück.
        """
        environment = {
            "ANTHROPIC_API_KEY": settings.anthropic_api_key,
            "CLAUDE_PROMPT": prompt,
            "CLAUDE_MODEL": model or settings.default_model,
            "CLAUDE_MAX_TURNS": str(max_turns or settings.max_turns),
            "CLAUDE_OUTPUT_FORMAT": "stream-json",
        }

        container = self.client.containers.run(
            image=settings.docker_image,
            environment=environment,
            volumes={
                str(workspace_path): {
                    "bind": "/workspace",
                    "mode": "rw",
                }
            },
            # Sicherheit
            mem_limit=settings.container_memory_limit,
            nano_cpus=int(settings.container_cpu_limit * 1e9),
            network_mode=settings.container_network_mode,
            # Kein TTY, Output streamen
            detach=True,
            stdout=True,
            stderr=True,
            # Labels für Management
            labels={
                "claude-yolo": "true",
                "run-id": run_id,
            },
            # Auto-Cleanup wenn fertig
            auto_remove=False,  # Wir räumen selbst auf nach Log-Streaming
        )

        self.active_runs[run_id] = {
            "container_id": container.id,
            "status": RunStatus.RUNNING,
        }

        return container.id

    async def stream_output(self, run_id: str):
        """
        Generator der Container-Logs als Stream liefert.
        Yields (type, data) Tuples.
        """
        run = self.active_runs.get(run_id)
        if not run:
            yield ("error", "Run nicht gefunden")
            return

        try:
            container = self.client.containers.get(run["container_id"])
        except docker.errors.NotFound:
            yield ("error", "Container nicht gefunden")
            return

        # Logs streamen (blockierend → in Thread auslagern)
        def _stream_logs():
            return container.logs(stream=True, follow=True)

        log_stream = await asyncio.to_thread(_stream_logs)

        for chunk in log_stream:
            line = chunk.decode("utf-8", errors="replace").rstrip()
            if line:
                yield ("output", line)

        # Container-Exit-Code prüfen
        result = await asyncio.to_thread(container.wait)
        exit_code = result.get("StatusCode", -1)

        if exit_code == 0:
            self.active_runs[run_id]["status"] = RunStatus.COMPLETED
            yield ("complete", f"Abgeschlossen (Exit Code: {exit_code})")
        else:
            self.active_runs[run_id]["status"] = RunStatus.FAILED
            yield ("error", f"Fehlgeschlagen (Exit Code: {exit_code})")

        # Container aufräumen
        try:
            await asyncio.to_thread(container.remove)
        except Exception:
            pass

    async def stop_run(self, run_id: str):
        """Container stoppen."""
        run = self.active_runs.get(run_id)
        if run:
            try:
                container = self.client.containers.get(run["container_id"])
                container.stop(timeout=10)
            except Exception:
                pass

    def list_active_runs(self) -> dict:
        return self.active_runs
```

### 2.6 FastAPI Application

```python
# backend/app/main.py
import uuid
import asyncio
import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from .config import settings
from .models import RunRequest, RunResponse, RunStatus, StreamMessage
from .docker_manager import DockerManager
from .project_manager import ProjectManager

app = FastAPI(title="YOLO Deck", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

docker_mgr = DockerManager()
project_mgr = ProjectManager()


# ── REST Endpoints ──


@app.get("/api/projects")
async def list_projects():
    """Alle verfügbaren Projekte auflisten."""
    return project_mgr.list_projects()


@app.get("/api/projects/{project_id}")
async def get_project(project_id: str):
    """Einzelnes Projekt abfragen."""
    try:
        return project_mgr.get_project(project_id)
    except FileNotFoundError:
        raise HTTPException(404, f"Projekt '{project_id}' nicht gefunden")


@app.post("/api/run", response_model=RunResponse)
async def start_run(request: RunRequest):
    """
    Startet einen Claude Code Run für ein Projekt.
    Gibt eine run_id zurück, über die der WebSocket-Stream verbunden wird.
    """
    # Projekt validieren
    try:
        project_mgr.get_project(request.project_id)
    except FileNotFoundError:
        raise HTTPException(404, "Projekt nicht gefunden")

    run_id = str(uuid.uuid4())[:8]

    # Arbeitskopie erstellen
    workspace = project_mgr.prepare_workspace(request.project_id)

    # Container starten
    await docker_mgr.start_run(
        run_id=run_id,
        workspace_path=workspace,
        prompt=request.prompt,
        model=request.model,
        max_turns=request.max_turns,
    )

    return RunResponse(
        run_id=run_id,
        project_id=request.project_id,
        status=RunStatus.RUNNING,
    )


@app.post("/api/run/{run_id}/stop")
async def stop_run(run_id: str):
    """Laufenden Run abbrechen."""
    await docker_mgr.stop_run(run_id)
    return {"status": "stopped"}


@app.get("/api/runs")
async def list_runs():
    """Aktive Runs auflisten."""
    return docker_mgr.list_active_runs()


# ── WebSocket für Live-Streaming ──


@app.websocket("/ws/run/{run_id}")
async def websocket_stream(websocket: WebSocket, run_id: str):
    """
    WebSocket-Endpoint für Live-Output eines Runs.
    Client verbindet sich nach POST /api/run mit der run_id.
    """
    await websocket.accept()

    try:
        async for msg_type, data in docker_mgr.stream_output(run_id):
            message = StreamMessage(
                type=msg_type,
                data=data,
                run_id=run_id,
            )
            await websocket.send_text(message.model_dump_json())

            # Bei complete oder error: Verbindung sauber schließen
            if msg_type in ("complete", "error"):
                break

    except WebSocketDisconnect:
        # Client hat Verbindung getrennt → Container stoppen
        await docker_mgr.stop_run(run_id)
    except Exception as e:
        await websocket.send_text(
            json.dumps({"type": "error", "data": str(e), "run_id": run_id})
        )
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
```

### 2.7 Backend starten

```bash
cd backend/
pip install -e .
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

---

## Phase 3 — Frontend (Next.js)

### 3.1 Setup

```bash
npx create-next-app@latest frontend \
    --typescript --tailwind --app --src-dir \
    --no-eslint --import-alias "@/*"
cd frontend/
npm install
```

### 3.2 API-Client

```typescript
// frontend/src/lib/api.ts
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export interface Project {
    id: string;
    name: string;
    path: string;
    current_branch: string | null;
    last_commit: string | null;
}

export interface RunResponse {
    run_id: string;
    project_id: string;
    status: string;
    branch: string | null;
}

export async function fetchProjects(): Promise<Project[]> {
    const res = await fetch(`${API_BASE}/api/projects`);
    return res.json();
}

export async function startRun(
    projectId: string,
    prompt: string,
    model?: string
): Promise<RunResponse> {
    const res = await fetch(`${API_BASE}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            project_id: projectId,
            prompt,
            model,
        }),
    });
    return res.json();
}

export async function stopRun(runId: string): Promise<void> {
    await fetch(`${API_BASE}/api/run/${runId}/stop`, { method: "POST" });
}
```

### 3.3 WebSocket-Hook

```typescript
// frontend/src/lib/useRunStream.ts
"use client";
import { useState, useCallback, useRef } from "react";

const WS_BASE = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8000";

interface StreamMessage {
    type: "output" | "status" | "error" | "complete";
    data: string;
    run_id: string;
}

export function useRunStream() {
    const [lines, setLines] = useState<StreamMessage[]>([]);
    const [isStreaming, setIsStreaming] = useState(false);
    const wsRef = useRef<WebSocket | null>(null);

    const connect = useCallback((runId: string) => {
        setLines([]);
        setIsStreaming(true);

        const ws = new WebSocket(`${WS_BASE}/ws/run/${runId}`);
        wsRef.current = ws;

        ws.onmessage = (event) => {
            const msg: StreamMessage = JSON.parse(event.data);
            setLines((prev) => [...prev, msg]);

            if (msg.type === "complete" || msg.type === "error") {
                setIsStreaming(false);
            }
        };

        ws.onclose = () => setIsStreaming(false);
        ws.onerror = () => setIsStreaming(false);
    }, []);

    const disconnect = useCallback(() => {
        wsRef.current?.close();
        setIsStreaming(false);
    }, []);

    return { lines, isStreaming, connect, disconnect };
}
```

### 3.4 Hauptseite (vereinfacht)

```tsx
// frontend/src/app/page.tsx
"use client";
import { useEffect, useState } from "react";
import { fetchProjects, startRun, stopRun, Project } from "@/lib/api";
import { useRunStream } from "@/lib/useRunStream";

export default function Dashboard() {
    const [projects, setProjects] = useState<Project[]>([]);
    const [selectedProject, setSelectedProject] = useState<string>("");
    const [prompt, setPrompt] = useState("");
    const [currentRunId, setCurrentRunId] = useState<string | null>(null);
    const { lines, isStreaming, connect, disconnect } = useRunStream();

    useEffect(() => {
        fetchProjects().then(setProjects);
    }, []);

    const handleRun = async () => {
        if (!selectedProject || !prompt.trim()) return;
        const run = await startRun(selectedProject, prompt);
        setCurrentRunId(run.run_id);
        connect(run.run_id);
    };

    const handleStop = async () => {
        if (currentRunId) {
            await stopRun(currentRunId);
            disconnect();
        }
    };

    return (
        <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
            <h1 className="text-2xl font-bold mb-6">YOLO Deck</h1>

            {/* Projekt-Auswahl */}
            <div className="mb-4">
                <label className="block text-sm text-zinc-400 mb-1">
                    Projekt
                </label>
                <select
                    value={selectedProject}
                    onChange={(e) => setSelectedProject(e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-700
                               rounded px-3 py-2"
                >
                    <option value="">— Projekt wählen —</option>
                    {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.name}
                            {p.current_branch
                                ? ` (${p.current_branch})`
                                : ""}
                        </option>
                    ))}
                </select>
            </div>

            {/* Prompt-Eingabe */}
            <div className="mb-4">
                <label className="block text-sm text-zinc-400 mb-1">
                    Prompt
                </label>
                <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={4}
                    placeholder="Was soll Claude tun?"
                    className="w-full bg-zinc-900 border border-zinc-700
                               rounded px-3 py-2 resize-y"
                />
            </div>

            {/* Aktions-Buttons */}
            <div className="flex gap-3 mb-6">
                <button
                    onClick={handleRun}
                    disabled={isStreaming || !selectedProject}
                    className="bg-emerald-600 hover:bg-emerald-500
                               disabled:opacity-40 px-4 py-2 rounded
                               font-medium"
                >
                    {isStreaming ? "Läuft..." : "▶ Ausführen"}
                </button>
                {isStreaming && (
                    <button
                        onClick={handleStop}
                        className="bg-red-600 hover:bg-red-500 px-4 py-2
                                   rounded font-medium"
                    >
                        ■ Stoppen
                    </button>
                )}
            </div>

            {/* Terminal-Output */}
            <div
                className="bg-black border border-zinc-800 rounded
                           font-mono text-sm p-4 h-[500px]
                           overflow-y-auto"
            >
                {lines.length === 0 && (
                    <span className="text-zinc-600">
                        Wähle ein Projekt und starte einen Run...
                    </span>
                )}
                {lines.map((line, i) => (
                    <div
                        key={i}
                        className={
                            line.type === "error"
                                ? "text-red-400"
                                : line.type === "complete"
                                  ? "text-emerald-400"
                                  : "text-zinc-300"
                        }
                    >
                        {line.data}
                    </div>
                ))}
            </div>
        </main>
    );
}
```

---

## Phase 4 — Docker Compose (Alles zusammen)

```yaml
# docker-compose.yml
services:
  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile.backend
    ports:
      - "8000:8000"
    volumes:
      - ./projects:/app/projects
      - ./workspaces:/app/workspaces
      - /var/run/docker.sock:/var/run/docker.sock  # Docker-in-Docker
    environment:
      - YOLO_ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - YOLO_PROJECTS_DIR=/app/projects
      - YOLO_WORKSPACES_DIR=/app/workspaces
    restart: unless-stopped

  frontend:
    build:
      context: ./frontend
    ports:
      - "3000:3000"
    environment:
      - NEXT_PUBLIC_API_URL=http://localhost:8000
      - NEXT_PUBLIC_WS_URL=ws://localhost:8000
    depends_on:
      - backend
    restart: unless-stopped
```

Backend braucht ein eigenes Dockerfile:

```dockerfile
# backend/Dockerfile.backend
FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml .
RUN pip install --no-cache-dir .
COPY app/ app/
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

---

## Phase 5 — Projekt einrichten und starten

### 5.1 Environment

```bash
# .env erstellen
cp .env.example .env
# ANTHROPIC_API_KEY eintragen
```

```bash
# .env.example
ANTHROPIC_API_KEY=sk-ant-...
```

### 5.2 Projekte hinzufügen

Projekte als Git-Repos in den `projects/`-Ordner legen:

```bash
# Bestehendes Repo klonen
git clone https://github.com/user/my-app.git projects/my-app

# Oder neues Projekt anlegen
mkdir projects/new-idea && cd projects/new-idea && git init
```

### 5.3 Starten

```bash
# 1. claude-yolo Docker-Image bauen
docker build -t claude-yolo:latest -f docker/Dockerfile docker/

# 2. Platform starten
docker compose up --build -d

# 3. Öffnen
open http://localhost:3000
```

---

## Sicherheits-Checkliste

| Maßnahme | Warum | Wie |
|---|---|---|
| Netzwerk-Isolation | Container soll nicht ins Internet oder Host-Netzwerk | `network_mode: none` im DockerManager |
| Resource Limits | Verhindert, dass ein Run den Host lahmlegt | `mem_limit` + `nano_cpus` konfiguriert |
| Git-Worktree-Kopie | Original-Repo bleibt unberührt | `prepare_workspace()` klont lokal |
| Feature-Branch | Alle Änderungen reviewbar vor Merge | `entrypoint.sh` erstellt automatisch Branch |
| Kein Root im Container | Principle of Least Privilege | `USER claude` im Dockerfile |
| API Key nur im Container | Key nicht im Frontend exponiert | Nur Backend kennt den Key, gibt ihn als Env weiter |
| Auto-Cleanup | Keine verwaisten Container/Volumes | `auto_remove` + explizites Cleanup |

---

## Erweiterungen (nächste Schritte)

**Run-History mit Datenbank:** SQLite oder PostgreSQL für persistente Run-Logs, damit man vergangene Runs, deren Prompts und Ergebnisse durchsuchen kann.

**Branch-Review-UI:** Nach einem Run die Git-Diff-Ansicht direkt im Frontend anzeigen, mit "Merge to main"-Button.

**Prompt-Templates:** Wiederkehrende Aufgaben als Templates speichern (z.B. "Refactor für TypeScript strict mode", "Tests hinzufügen", "Dependencies updaten").

**Queue-System:** Bei mehreren gleichzeitigen Runs ein Redis-basiertes Queue-System (Celery / Bull), damit nicht zu viele Container parallel laufen.

**Notifications:** Webhook oder E-Mail wenn ein Run fertig ist — besonders bei langen Runs.

**Multi-User:** Auth-Layer (z.B. Authelia oder Keycloak) wenn mehrere Leute Zugriff bekommen sollen.

**Claude Code mit Netzwerk:** Falls der Container npm install o.ä. können soll, selektiven Netzwerkzugriff über eigenes Docker-Network mit Egress-Filterung erlauben.
