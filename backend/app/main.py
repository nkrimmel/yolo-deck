import uuid
import json
import logging
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
import docker.errors
from .config import settings
from .models import RunRequest, RunResponse, RunStatus, StreamMessage, AddProjectRequest, DirEntry
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


@app.post("/api/projects")
async def add_project(request: AddProjectRequest):
    """Projekt per Pfad hinzufügen (Symlink in projects/)."""
    try:
        return project_mgr.add_project(request.path)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except FileExistsError as e:
        raise HTTPException(409, str(e))


@app.delete("/api/projects/{project_id}")
async def remove_project(project_id: str):
    """Projekt-Symlink entfernen (Original bleibt unberührt)."""
    try:
        project_mgr.remove_project(project_id)
        return {"status": "removed"}
    except FileNotFoundError:
        raise HTTPException(404, f"Projekt '{project_id}' nicht gefunden")


@app.get("/api/browse")
async def browse_directory(path: str = Query(default="")) -> list[DirEntry]:
    """Verzeichnis-Inhalt für Dateibrowser auflisten."""
    browse_root = Path(settings.browse_root).expanduser().resolve()
    logging.info("browse: path=%r, browse_root=%s", path, browse_root)
    if not path or path.strip() == "~":
        target = browse_root
    elif path.startswith("~"):
        target = browse_root / path[1:].lstrip("/")
    else:
        target = Path(path).resolve()
    if not target.is_dir():
        raise HTTPException(404, f"Verzeichnis nicht gefunden: {target}")

    entries = []
    def _sort_key(p: Path):
        try:
            return (not p.is_dir(), p.name.lower())
        except PermissionError:
            return (True, p.name.lower())

    try:
        items = sorted(target.iterdir(), key=_sort_key)
    except PermissionError:
        raise HTTPException(403, f"Zugriff verweigert: {target}")
    for item in items:
        try:
            # Show hidden directories (needed for navigation), hide hidden files
            if item.name.startswith(".") and not item.is_dir():
                continue
            is_git = item.is_dir() and (item / ".git").exists()
            entries.append(DirEntry(
                name=item.name,
                path=str(item),
                is_dir=item.is_dir(),
                is_git=is_git,
            ))
        except PermissionError:
            continue
    return entries


@app.post("/api/run", response_model=RunResponse)
async def start_run(request: RunRequest):
    """
    Startet einen Claude Code Run für ein Projekt.
    Gibt eine run_id zurück, über die der WebSocket-Stream verbunden wird.
    """
    # Projekt validieren
    try:
        project = project_mgr.get_project(request.project_id)
    except FileNotFoundError:
        raise HTTPException(404, "Projekt nicht gefunden")

    run_id = str(uuid.uuid4())[:8]

    # Projekt-Verzeichnis direkt mounten (wie claude-yolo)
    project_path = Path(project.path).resolve()

    # Container starten
    try:
        await docker_mgr.start_run(
            run_id=run_id,
            workspace_path=project_path,
            prompt=request.prompt,
            project_id=request.project_id,
            model=request.model,
            max_turns=request.max_turns,
        )
    except docker.errors.ImageNotFound:
        raise HTTPException(
            500,
            f"Docker-Image '{settings.docker_image}' nicht gefunden. "
            "Bitte mit 'docker build -t claude-code ...' erstellen.",
        )
    except docker.errors.APIError as e:
        logging.error("Docker API Fehler: %s", e)
        raise HTTPException(500, f"Docker-Fehler: {e.explanation or str(e)}")
    except Exception as e:
        logging.error("Container-Start fehlgeschlagen: %s", e)
        raise HTTPException(500, f"Container-Start fehlgeschlagen: {str(e)}")

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


@app.get("/api/run/{run_id}")
async def get_run_details(run_id: str):
    """Container-Status und Logs für einen Run."""
    details = docker_mgr.get_run_details(run_id)
    if not details:
        raise HTTPException(404, "Run nicht gefunden")
    return details


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
        # Client hat Verbindung getrennt — Container läuft weiter.
        # User kann explizit per POST /api/run/{run_id}/stop stoppen.
        pass
    except Exception as e:
        await websocket.send_text(
            json.dumps({"type": "error", "data": str(e), "run_id": run_id})
        )
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
