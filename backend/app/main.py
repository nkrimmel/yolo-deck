import uuid
import json
import logging
from pathlib import Path
from fastapi import Depends, FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
import docker.errors
import httpx
from .config import settings
from .models import RunRequest, RunResponse, RunStatus, StreamMessage, AddProjectRequest, CreateDirRequest, DirEntry, CreateTemplateRequest, PromptRequest
from .auth import verify_token
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


@app.on_event("startup")
async def startup():
    from .database import init_db
    await init_db()


# ── REST Endpoints ──


@app.get("/api/projects", dependencies=[Depends(verify_token)])
async def list_projects():
    """Alle verfügbaren Projekte auflisten."""
    return project_mgr.list_projects()


@app.get("/api/projects/{project_id}", dependencies=[Depends(verify_token)])
async def get_project(project_id: str):
    """Einzelnes Projekt abfragen."""
    try:
        return project_mgr.get_project(project_id)
    except FileNotFoundError:
        raise HTTPException(404, f"Projekt '{project_id}' nicht gefunden")


@app.post("/api/projects", dependencies=[Depends(verify_token)])
async def add_project(request: AddProjectRequest):
    """Projekt per Pfad hinzufügen (Symlink in projects/)."""
    try:
        return project_mgr.add_project(request.path)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    except FileExistsError as e:
        raise HTTPException(409, str(e))


@app.delete("/api/projects/{project_id}", dependencies=[Depends(verify_token)])
async def remove_project(project_id: str):
    """Projekt-Symlink entfernen (Original bleibt unberührt)."""
    try:
        project_mgr.remove_project(project_id)
        return {"status": "removed"}
    except FileNotFoundError:
        raise HTTPException(404, f"Projekt '{project_id}' nicht gefunden")


@app.get("/api/browse", dependencies=[Depends(verify_token)])
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


@app.post("/api/mkdir", dependencies=[Depends(verify_token)])
async def create_directory(request: CreateDirRequest):
    """Neues Verzeichnis erstellen und git init ausführen."""
    target = Path(request.path).expanduser().resolve()
    if target.exists():
        raise HTTPException(409, f"Pfad existiert bereits: {target}")
    try:
        target.mkdir(parents=True)
        # Git-Repo initialisieren, damit es sofort als Projekt nutzbar ist
        from git import Repo
        Repo.init(target)
        return {"path": str(target)}
    except PermissionError:
        raise HTTPException(403, f"Zugriff verweigert: {target}")
    except Exception as e:
        raise HTTPException(500, f"Fehler: {e}")


# ── Ollama Endpoints ──


@app.get("/api/ollama/status", dependencies=[Depends(verify_token)])
async def ollama_status():
    """Ollama-Erreichbarkeit prüfen."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{settings.ollama_base_url}/api/version")
            resp.raise_for_status()
            return {"available": True}
    except Exception:
        return {"available": False}


@app.get("/api/ollama/models", dependencies=[Depends(verify_token)])
async def ollama_models():
    """Verfügbare Ollama-Modelle auflisten."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{settings.ollama_base_url}/api/tags")
            resp.raise_for_status()
            data = resp.json()
            return data.get("models", [])
    except Exception:
        return []


@app.post("/api/run", response_model=RunResponse, dependencies=[Depends(verify_token)])
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
    project_link = Path(project.path)
    project_path = project_link.resolve()

    # Symlink-Ziel prüfen (kann ungültig sein wenn z.B. lokal hinzugefügt)
    if not project_path.exists():
        symlink_target = ""
        try:
            symlink_target = str(project_link.readlink()) if project_link.is_symlink() else ""
        except Exception:
            pass
        raise HTTPException(
            400,
            f"Projekt-Verzeichnis nicht erreichbar: {project_path}"
            + (f" (Symlink → {symlink_target})" if symlink_target else "")
            + ". Projekt evtl. neu hinzufügen."
        )

    # Container starten
    try:
        await docker_mgr.start_run(
            run_id=run_id,
            workspace_path=project_path,
            prompt=request.prompt,
            project_id=request.project_id,
            model=request.model,
            max_turns=request.max_turns,
            provider=request.provider,
            project_name=project.name,
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

    # Check if run was queued or started
    run_details = docker_mgr.active_runs.get(run_id, {})
    run_status = run_details.get("status", RunStatus.RUNNING)

    return RunResponse(
        run_id=run_id,
        project_id=request.project_id,
        status=run_status,
    )


@app.post("/api/run/{run_id}/stop", dependencies=[Depends(verify_token)])
async def stop_run(run_id: str):
    """Session beenden und Container stoppen."""
    await docker_mgr.stop_run(run_id)
    return {"status": "stopped"}


@app.post("/api/run/{run_id}/prompt", dependencies=[Depends(verify_token)])
async def send_prompt(run_id: str, request: PromptRequest):
    """Follow-up Prompt an eine idle Session senden."""
    run = docker_mgr.active_runs.get(run_id)
    if not run:
        raise HTTPException(404, "Run nicht gefunden")
    if run["status"] != RunStatus.IDLE:
        raise HTTPException(
            409,
            f"Run ist nicht idle (aktuell: {run['status'].value if hasattr(run['status'], 'value') else run['status']})"
        )

    import asyncio
    asyncio.ensure_future(docker_mgr.exec_prompt(
        run_id=run_id,
        prompt=request.prompt,
        model=request.model,
        max_turns=request.max_turns,
        provider=run.get("provider"),
    ))

    return {"status": "prompt_sent"}


@app.get("/api/run/{run_id}", dependencies=[Depends(verify_token)])
async def get_run_details(run_id: str):
    """Container-Status und Logs für einen Run."""
    details = docker_mgr.get_run_details(run_id)
    if not details:
        raise HTTPException(404, "Run nicht gefunden")
    return details


@app.get("/api/runs", dependencies=[Depends(verify_token)])
async def list_runs():
    """Aktive Runs auflisten."""
    return docker_mgr.list_active_runs()


# ── History & Templates ──


@app.get("/api/history", dependencies=[Depends(verify_token)])
async def get_history(limit: int = 50, offset: int = 0):
    from .database import get_run_history
    runs = await get_run_history(limit, offset)
    return runs


@app.get("/api/history/{run_id}", dependencies=[Depends(verify_token)])
async def get_history_run(run_id: str):
    from .database import get_run as db_get_run
    run = await db_get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


@app.delete("/api/history", dependencies=[Depends(verify_token)])
async def clear_history():
    from .database import delete_history
    await delete_history()
    return {"status": "ok"}


@app.get("/api/templates", dependencies=[Depends(verify_token)])
async def list_templates():
    from .database import get_templates
    return await get_templates()


@app.post("/api/templates", dependencies=[Depends(verify_token)])
async def create_template(req: CreateTemplateRequest):
    from .database import save_template
    return await save_template(req.name, req.prompt, req.model)


@app.delete("/api/templates/{template_id}", dependencies=[Depends(verify_token)])
async def remove_template(template_id: str):
    from .database import delete_template
    await delete_template(template_id)
    return {"status": "ok"}


# ── Files, Stats Endpoints ──


@app.get("/api/run/{run_id}/files", dependencies=[Depends(verify_token)])
async def get_run_files(run_id: str, path: str = ""):
    """List files in a run's workspace."""
    import os
    run = docker_mgr.get_run_details(run_id)
    workspace_path = None
    if run:
        workspace_path = run.get("workspace_path")
    if not workspace_path:
        raise HTTPException(status_code=404, detail="Run nicht gefunden")

    base = Path(workspace_path)
    target = base / path if path else base
    if not target.exists():
        raise HTTPException(status_code=404, detail="Pfad nicht gefunden")
    if not str(target.resolve()).startswith(str(base.resolve())):
        raise HTTPException(status_code=403, detail="Zugriff verweigert")

    entries = []
    try:
        for entry in sorted(target.iterdir(), key=lambda e: (not e.is_dir(), e.name)):
            if entry.name.startswith('.'):
                continue
            entries.append({
                "name": entry.name,
                "path": str(entry.relative_to(base)),
                "is_dir": entry.is_dir(),
            })
    except PermissionError:
        pass
    return entries


@app.get("/api/run/{run_id}/file", dependencies=[Depends(verify_token)])
async def get_run_file(run_id: str, path: str = Query(...)):
    """Read a file from a run's workspace."""
    run = docker_mgr.get_run_details(run_id)
    workspace_path = None
    if run:
        workspace_path = run.get("workspace_path")
    if not workspace_path:
        raise HTTPException(status_code=404, detail="Run nicht gefunden")

    base = Path(workspace_path)
    target = base / path
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="Datei nicht gefunden")
    if not str(target.resolve()).startswith(str(base.resolve())):
        raise HTTPException(status_code=403, detail="Zugriff verweigert")

    # Size limit: 1MB
    if target.stat().st_size > 1_000_000:
        return {"content": "Datei zu groß (>1MB)", "truncated": True}

    try:
        content = target.read_text(errors="replace")
        return {"content": content, "truncated": False}
    except Exception as e:
        return {"content": f"Fehler beim Lesen: {e}", "truncated": False}


@app.get("/api/run/{run_id}/stats", dependencies=[Depends(verify_token)])
async def get_run_stats(run_id: str):
    """Get container resource stats."""
    stats = docker_mgr.get_container_stats(run_id)
    if stats is None:
        raise HTTPException(status_code=404, detail="Run nicht gefunden oder nicht aktiv")
    return stats


# ── WebSocket für Live-Streaming ──


@app.websocket("/ws/run/{run_id}")
async def websocket_stream(websocket: WebSocket, run_id: str, token: str | None = Query(None)):
    """
    WebSocket-Endpoint für Live-Output einer Session.
    Bleibt offen über mehrere Prompts — endet bei session_end.
    """
    # Auth check for WebSocket
    if settings.auth_token and token != settings.auth_token:
        await websocket.close(code=1008)
        return
    await websocket.accept()

    try:
        async for msg_type, data in docker_mgr.stream_session(run_id):
            message = StreamMessage(
                type=msg_type,
                data=data,
                run_id=run_id,
            )
            await websocket.send_text(message.model_dump_json())

            # Bei complete oder error: Session ist beendet
            if msg_type in ("complete", "error"):
                break

    except WebSocketDisconnect:
        # Client hat Verbindung getrennt — Container läuft weiter.
        logging.info("WebSocket getrennt für Run %s — Container läuft weiter", run_id)
    except Exception as e:
        await websocket.send_text(
            json.dumps({"type": "error", "data": str(e), "run_id": run_id})
        )
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
