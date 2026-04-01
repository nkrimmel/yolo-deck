import asyncio
import shlex
import docker
from pathlib import Path
from .config import settings
from .models import RunStatus


def _shell_quote(s: str) -> str:
    """Safely quote a string for shell use."""
    return shlex.quote(s)


def _to_host_path(container_path: Path) -> str:
    """Translate a backend-container path to the equivalent host path.

    In Docker, the host home is mounted as /host/home inside the backend
    container.  Docker volume mounts need host paths, so we reverse the
    mapping: /host/home/foo → $HOME/foo on the host.
    """
    path_str = str(container_path)
    browse_root = str(Path(settings.browse_root).expanduser().resolve())
    host_home = settings.host_home_path

    if host_home and browse_root != "~" and path_str.startswith(browse_root):
        return host_home + path_str[len(browse_root):]
    return path_str


class DockerManager:
    def __init__(self):
        self._client = None
        self.active_runs: dict[str, dict] = {}

    @property
    def client(self):
        if self._client is None:
            self._client = docker.from_env()
        return self._client

    async def start_run(
        self,
        run_id: str,
        workspace_path: Path,
        prompt: str,
        project_id: str,
        model: str | None = None,
        max_turns: int | None = None,
    ) -> str:
        """
        Startet einen Claude Code Container.
        Gibt die Container-ID zurück.
        """
        model_str = model or settings.default_model
        max_turns_str = str(max_turns or settings.max_turns)

        environment = {
            "TERM": "xterm-256color",
        }

        # API key auth (optional override)
        if settings.anthropic_api_key:
            environment["ANTHROPIC_API_KEY"] = settings.anthropic_api_key

        # Translate container paths to host paths for Docker volume mounts
        host_workspace = _to_host_path(workspace_path)
        host_claude_home = settings.claude_home_host or str(settings.claude_home)
        host_claude_json = settings.claude_json_host or str(settings.claude_json)

        volumes = {
            host_workspace: {
                "bind": "/workspace",
                "mode": "rw",
            },
            # Subscription auth — mount host credentials into container
            host_claude_home: {
                "bind": "/home/claude/.claude",
                "mode": "rw",
            },
            host_claude_json: {
                "bind": "/home/claude/.claude.json",
                "mode": "rw",
            },
        }

        # Build the claude command
        claude_cmd = (
            f'cd /workspace && claude -p {_shell_quote(prompt)}'
            f' --output-format stream-json'
            f' --model {_shell_quote(model_str)}'
            f' --max-turns {max_turns_str}'
            f' --dangerously-skip-permissions'
            f' --verbose'
        )

        container = self.client.containers.run(
            image=settings.docker_image,
            command=["bash", "-c", claude_cmd],
            environment=environment,
            volumes=volumes,
            # Sicherheit
            mem_limit=settings.container_memory_limit,
            nano_cpus=int(settings.container_cpu_limit * 1e9),
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
            "workspace_path": str(workspace_path),
            "project_id": project_id,
            "synced": False,
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

    def get_run_details(self, run_id: str) -> dict | None:
        """Container-Status und letzte Log-Zeilen für einen Run."""
        run = self.active_runs.get(run_id)
        if not run:
            return None

        details = {
            "run_id": run_id,
            "status": run["status"],
            "container_id": run["container_id"][:12],
            "container_status": None,
            "exit_code": None,
            "logs": [],
            "workspace_path": run.get("workspace_path"),
            "project_id": run.get("project_id"),
            "synced": run.get("synced", False),
        }

        try:
            container = self.client.containers.get(run["container_id"])
            container.reload()
            details["container_status"] = container.status  # created, running, exited, etc.
            state = container.attrs.get("State", {})
            if state.get("Status") == "exited":
                details["exit_code"] = state.get("ExitCode")
            # Letzte Log-Zeilen holen
            try:
                raw_logs = container.logs(tail=500, timestamps=False)
                details["logs"] = [
                    line for line in raw_logs.decode("utf-8", errors="replace").splitlines() if line.strip()
                ]
            except Exception:
                pass
        except docker.errors.NotFound:
            details["container_status"] = "removed"
        except Exception as e:
            details["container_status"] = f"error: {e}"

        return details

    def mark_synced(self, run_id: str):
        """Mark a run as synced back to the original project."""
        run = self.active_runs.get(run_id)
        if run:
            run["synced"] = True

    def list_active_runs(self) -> list[dict]:
        """Alle bekannten Runs mit Basis-Info auflisten. Aktualisiert Container-Status."""
        result = []
        for run_id, run in self.active_runs.items():
            # Update status from actual container state
            if run["status"] == RunStatus.RUNNING:
                try:
                    container = self.client.containers.get(run["container_id"])
                    container.reload()
                    if container.status == "exited":
                        exit_code = container.attrs.get("State", {}).get("ExitCode", -1)
                        run["status"] = RunStatus.COMPLETED if exit_code == 0 else RunStatus.FAILED
                except docker.errors.NotFound:
                    run["status"] = RunStatus.FAILED
                except Exception:
                    pass

            result.append({
                "run_id": run_id,
                "status": run["status"],
                "container_id": run["container_id"][:12],
                "project_id": run.get("project_id"),
            })
        return result
