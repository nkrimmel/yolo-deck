import asyncio
import json
import logging
import shlex
import docker
from datetime import datetime, timezone
from pathlib import Path
from .config import settings
from .models import RunStatus

logger = logging.getLogger(__name__)


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
        self._queue: asyncio.Queue = asyncio.Queue()
        self._queue_items: dict[str, dict] = {}  # run_id -> queue item data
        self._output_queues: dict[str, asyncio.Queue] = {}  # run_id -> output queue
        self._prompt_counters: dict[str, int] = {}  # run_id -> prompt count

    @property
    def client(self):
        if self._client is None:
            self._client = docker.from_env()
        return self._client

    async def _flush_ollama_cache(self, model: str) -> None:
        """Unload Ollama model to clear KV-cache before a new run."""
        import httpx
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(
                    f"{settings.ollama_base_url}/api/generate",
                    json={"model": model, "keep_alive": 0},
                )
                logger.info("Ollama cache flushed for model %s", model)
        except Exception as e:
            logger.warning("Ollama cache flush failed: %s", e)

    async def start_run(
        self,
        run_id: str,
        workspace_path: Path,
        prompt: str,
        project_id: str,
        model: str | None = None,
        max_turns: int | None = None,
        provider: str = "anthropic",
        project_name: str | None = None,
    ) -> str | None:
        """
        Startet einen Claude Code Container oder reiht ihn in die Queue ein.
        Gibt die Container-ID zurück, oder None wenn in Queue.
        """
        # Check concurrent run limit (idle sessions still use a container)
        running_count = sum(1 for r in self.active_runs.values() if r.get("status") in (RunStatus.RUNNING, RunStatus.IDLE))
        if running_count >= settings.max_concurrent_runs:
            # Queue this run
            queue_item = {
                "run_id": run_id,
                "workspace_path": workspace_path,
                "prompt": prompt,
                "project_id": project_id,
                "model": model,
                "max_turns": max_turns,
                "provider": provider,
                "project_name": project_name,
            }
            self._queue_items[run_id] = queue_item
            self.active_runs[run_id] = {
                "container_id": None,
                "status": RunStatus.QUEUED,
                "workspace_path": str(workspace_path),
                "project_id": project_id,
                "synced": False,
                "exit_code": None,
                "saved_logs": [],
                "started_at": datetime.now(timezone.utc).isoformat(),
                "prompt": prompt,
                "model": model or settings.default_model,
                "provider": provider,
            }
            await self._queue.put(run_id)
            logger.info("Run %s: Queued (running: %d, max: %d)", run_id, running_count, settings.max_concurrent_runs)
            return None

        return await self._launch_container(
            run_id=run_id,
            workspace_path=workspace_path,
            prompt=prompt,
            project_id=project_id,
            model=model,
            max_turns=max_turns,
            provider=provider,
            project_name=project_name,
        )

    async def _launch_container(
        self,
        run_id: str,
        workspace_path: Path,
        prompt: str,
        project_id: str,
        model: str | None = None,
        max_turns: int | None = None,
        provider: str = "anthropic",
        project_name: str | None = None,
    ) -> str:
        """Launch a long-lived Docker container, then exec the first prompt."""
        model_str = model or settings.default_model

        # Translate container paths to host paths for Docker volume mounts
        host_workspace = _to_host_path(workspace_path)
        host_claude_home = settings.claude_home_host or str(settings.claude_home)
        host_claude_json = settings.claude_json_host or str(settings.claude_json)

        environment = {
            "TERM": "xterm-256color",
            "HOME": "/home/claude",
            # Agent-Teams (multi-agent/swarm) aktivieren
            "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
            # Diagnostics — actual host path and project name
            "YOLO_HOST_PATH": host_workspace,
            "YOLO_PROJECT_NAME": project_name or project_id,
        }

        # Provider-specific environment
        if provider == "ollama":
            environment["ANTHROPIC_BASE_URL"] = settings.ollama_base_url
            environment["ANTHROPIC_AUTH_TOKEN"] = "ollama"
            environment["ANTHROPIC_API_KEY"] = ""
            # Flush Ollama KV-cache to prevent context bleed from previous runs
            await self._flush_ollama_cache(model_str)
        elif settings.anthropic_api_key:
            # API key auth (optional override)
            environment["ANTHROPIC_API_KEY"] = settings.anthropic_api_key

        logger.info(
            "Run %s: workspace_path=%s → host_workspace=%s (browse_root=%s, host_home=%s, project_id=%s, project_name=%s)",
            run_id, workspace_path, host_workspace,
            settings.browse_root, settings.host_home_path,
            project_id, project_name,
        )

        volumes = {
            host_workspace: {
                "bind": "/workspace",
                "mode": "rw",
            },
            # Credentials mounted to staging path (ro) — copied into
            # /home/claude by root preamble so claude user can read them
            host_claude_home: {
                "bind": "/host-claude-auth",
                "mode": "ro",
            },
            host_claude_json: {
                "bind": "/host-claude-auth.json",
                "mode": "ro",
            },
        }

        # Inner command: setup + stay alive (no claude -p here)
        inner_cmd = (
            'echo "[YOLO Deck] Projekt: $YOLO_PROJECT_NAME ($YOLO_HOST_PATH)"; '
            'git config --global --add safe.directory /workspace 2>/dev/null; '
            'git config --global user.name "Claude YOLO" 2>/dev/null; '
            'git config --global user.email "claude-yolo@localhost" 2>/dev/null; '
            '[ -z "$(ls -A /workspace 2>/dev/null)" ] && git init /workspace >/dev/null 2>&1; '
            'exec tail -f /dev/null'
        )

        # Root preamble: copy credentials, fix permissions, then drop to claude user
        claude_cmd = (
            f'cp -a /host-claude-auth /home/claude/.claude 2>/dev/null; '
            f'cp -a /host-claude-auth.json /home/claude/.claude.json 2>/dev/null; '
            f'rm -rf /home/claude/.claude/projects /home/claude/.claude/memory '
            f'/home/claude/.claude/todos /home/claude/.claude/statsig 2>/dev/null; '
            f'chown -R claude:claude /home/claude /workspace 2>/dev/null; '
            f'exec su -c {_shell_quote(inner_cmd)} claude'
        )

        # Extra Docker options for Ollama (needs network access to host)
        extra_run_kwargs = {}
        if provider == "ollama":
            extra_run_kwargs["extra_hosts"] = {"host.docker.internal": "host-gateway"}

        container = self.client.containers.run(
            image=settings.docker_image,
            command=["bash", "-c", claude_cmd],
            environment=environment,
            volumes=volumes,
            # Sicherheit
            mem_limit=settings.container_memory_limit,
            nano_cpus=int(settings.container_cpu_limit * 1e9),
            # Start as root to fix permissions, then drop to claude user via su
            user="root",
            # Kein TTY, Output streamen
            detach=True,
            stdout=True,
            stderr=True,
            # Labels für Management
            labels={
                "claude-yolo": "true",
                "run-id": run_id,
            },
            auto_remove=False,
            **extra_run_kwargs,
        )

        started_at = datetime.now(timezone.utc).isoformat()
        # Create output queue for this session
        self._output_queues[run_id] = asyncio.Queue()
        self._prompt_counters[run_id] = 0

        self.active_runs[run_id] = {
            "container_id": container.id,
            "status": RunStatus.RUNNING,
            "workspace_path": str(workspace_path),
            "project_id": project_id,
            "project_name": project_name,
            "synced": False,
            "started_at": started_at,
            "prompt": prompt,
            "model": model_str,
            "provider": provider,
        }

        # Persist initial run to DB
        try:
            from .database import save_run
            asyncio.ensure_future(save_run({
                "id": run_id,
                "project_id": project_id,
                "project_name": project_name,
                "status": "running",
                "started_at": started_at,
                "prompt": prompt,
                "model": model_str,
                "provider": provider,
            }))
        except Exception as e:
            logger.warning("Run %s: DB save at start failed: %s", run_id, e)

        # Watch for unexpected container death
        asyncio.ensure_future(self._watch_container(run_id))

        # Execute the first prompt immediately
        asyncio.ensure_future(self.exec_prompt(
            run_id=run_id,
            prompt=prompt,
            model=model_str,
            max_turns=max_turns,
            provider=provider,
        ))

        return container.id

    def _update_run_status(self, run_id: str) -> None:
        """Aktualisiert den Run-Status anhand des tatsächlichen Container-Zustands."""
        run = self.active_runs.get(run_id)
        if not run or run["status"] not in (RunStatus.RUNNING, RunStatus.IDLE):
            return

        try:
            container = self.client.containers.get(run["container_id"])
            container.reload()
            if container.status == "exited":
                exit_code = container.attrs.get("State", {}).get("ExitCode", -1)
                run["exit_code"] = exit_code
                run["status"] = RunStatus.COMPLETED if exit_code == 0 else RunStatus.FAILED
                logger.info("Run %s: Container exited (code %d) → %s", run_id, exit_code, run["status"])
        except docker.errors.NotFound:
            # Container entfernt — Status aus gespeichertem exit_code ableiten
            if "exit_code" not in run:
                run["status"] = RunStatus.FAILED
                run["exit_code"] = -1
            logger.warning("Run %s: Container nicht mehr vorhanden → %s", run_id, run["status"])
        except Exception as e:
            logger.error("Run %s: Status-Check fehlgeschlagen: %s", run_id, e)

    async def _watch_container(self, run_id: str) -> None:
        """Background-Task: Watches for unexpected container death."""
        run = self.active_runs.get(run_id)
        if not run:
            return

        try:
            container = self.client.containers.get(run["container_id"])
            result = await asyncio.to_thread(container.wait)
            exit_code = result.get("StatusCode", -1)
            run["exit_code"] = exit_code

            # Only update if not already completed/failed by stop_run
            if run["status"] in (RunStatus.RUNNING, RunStatus.IDLE):
                run["status"] = RunStatus.FAILED
                logger.info("Run %s: Container died unexpectedly (code %d)", run_id, exit_code)

                # Signal session end through output queue
                output_queue = self._output_queues.get(run_id)
                if output_queue:
                    await output_queue.put(("session_end", json.dumps({
                        "type": "error",
                        "data": f"Container unerwartet beendet (Exit Code: {exit_code})",
                    })))

            # Persist to DB
            await self._save_run_to_db(run_id, exit_code)

            # Container cleanup
            try:
                await asyncio.to_thread(container.remove)
            except Exception:
                pass
        except docker.errors.NotFound:
            if run["status"] in (RunStatus.RUNNING, RunStatus.IDLE):
                run.setdefault("exit_code", -1)
                run["status"] = RunStatus.FAILED
        except Exception as e:
            logger.error("Run %s: Watch-Fehler: %s", run_id, e)

        # Cleanup output queue
        self._output_queues.pop(run_id, None)
        self._prompt_counters.pop(run_id, None)

        # Process queued runs now that capacity is freed
        await self._process_queue()

    async def _save_run_to_db(self, run_id: str, exit_code: int) -> None:
        """Persist run completion data to DB."""
        run = self.active_runs.get(run_id)
        if not run:
            return
        try:
            from .database import save_run
            saved_logs = run.get("saved_logs", [])
            cost_usd = None
            claude_duration_ms = None
            num_turns = None
            for line in saved_logs:
                try:
                    data = json.loads(line)
                    if data.get("type") == "result":
                        cost_usd = data.get("cost_usd") or data.get("result", {}).get("cost_usd")
                        claude_duration_ms = data.get("duration_ms") or data.get("result", {}).get("duration_ms")
                        num_turns = data.get("num_turns") or data.get("result", {}).get("num_turns")
                    # Don't break — accumulate from all prompts (last result wins)
                except (json.JSONDecodeError, AttributeError):
                    continue

            finished_at = datetime.now(timezone.utc)
            started_at_str = run.get("started_at")
            wallclock_ms = None
            if started_at_str:
                try:
                    started_dt = datetime.fromisoformat(started_at_str)
                    wallclock_ms = (finished_at - started_dt).total_seconds() * 1000
                except (ValueError, TypeError):
                    pass
            duration_ms = claude_duration_ms or wallclock_ms

            await save_run({
                "id": run_id,
                "project_id": run.get("project_id"),
                "project_name": run.get("project_name"),
                "prompt": run.get("prompt"),
                "model": run.get("model"),
                "provider": run.get("provider"),
                "status": run["status"].value if hasattr(run["status"], "value") else str(run["status"]),
                "exit_code": exit_code,
                "cost_usd": cost_usd,
                "duration_ms": duration_ms,
                "num_turns": num_turns,
                "started_at": started_at_str,
                "finished_at": finished_at.isoformat(),
                "logs_json": json.dumps(saved_logs),
            })
        except Exception as e:
            logger.warning("Run %s: DB save on completion failed: %s", run_id, e)

    async def exec_prompt(
        self,
        run_id: str,
        prompt: str,
        model: str | None = None,
        max_turns: int | None = None,
        provider: str | None = None,
    ) -> None:
        """Execute a claude -p command inside the running container."""
        run = self.active_runs.get(run_id)
        if not run:
            return

        container_id = run.get("container_id")
        if not container_id:
            return

        output_queue = self._output_queues.get(run_id)
        if not output_queue:
            return

        model_str = model or run.get("model") or settings.default_model
        max_turns_str = str(max_turns or settings.max_turns)
        prov = provider or run.get("provider", "anthropic")

        # Increment prompt counter
        self._prompt_counters[run_id] = self._prompt_counters.get(run_id, 0) + 1
        prompt_num = self._prompt_counters[run_id]

        # Set status to running
        run["status"] = RunStatus.RUNNING

        # Send prompt_start message
        await output_queue.put(("data", json.dumps({
            "type": "prompt_start",
            "prompt": prompt,
            "prompt_number": prompt_num,
        })))

        # Build the claude command
        claude_cmd = (
            f'cd /workspace && claude -p {_shell_quote(prompt)}'
            f' --output-format stream-json'
            f' --model {_shell_quote(model_str)}'
            f' --max-turns {max_turns_str}'
            f' --dangerously-skip-permissions'
            f' --verbose'
            f' 2>&1'
        )

        try:
            container = self.client.containers.get(container_id)

            # Use low-level API for streaming exec
            exec_id = self.client.api.exec_create(
                container.id,
                ["su", "-c", claude_cmd, "claude"],
                stdout=True,
                stderr=True,
            )
            exec_stream = self.client.api.exec_start(exec_id, stream=True)

            # Stream output in a thread (Docker SDK is blocking)
            saved_lines = run.setdefault("saved_logs", [])
            loop = asyncio.get_event_loop()

            def _stream_exec():
                buffer = ""
                for chunk in exec_stream:
                    text = chunk.decode("utf-8", errors="replace")
                    buffer += text
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        line = line.rstrip()
                        if line:
                            saved_lines.append(line)
                            loop.call_soon_threadsafe(output_queue.put_nowait, ("data", line))
                # Flush remaining buffer
                if buffer.strip():
                    saved_lines.append(buffer.strip())
                    loop.call_soon_threadsafe(output_queue.put_nowait, ("data", buffer.strip()))

            await asyncio.to_thread(_stream_exec)

            # Check exec exit code
            exec_info = self.client.api.exec_inspect(exec_id)
            exit_code = exec_info.get("ExitCode", -1)

            if exit_code != 0:
                logger.warning("Run %s: Prompt #%d exec exited with code %d", run_id, prompt_num, exit_code)

        except docker.errors.NotFound:
            logger.error("Run %s: Container not found during exec", run_id)
            run["status"] = RunStatus.FAILED
            await output_queue.put(("data", json.dumps({
                "type": "error",
                "data": "Container nicht mehr vorhanden",
            })))
            return
        except Exception as e:
            logger.error("Run %s: Exec error: %s", run_id, e)
            run["status"] = RunStatus.FAILED
            await output_queue.put(("data", json.dumps({
                "type": "error",
                "data": f"Exec-Fehler: {e}",
            })))
            return

        # Transition to idle
        run["status"] = RunStatus.IDLE
        await output_queue.put(("data", json.dumps({"type": "idle"})))
        logger.info("Run %s: Prompt #%d finished → idle", run_id, prompt_num)

    async def _process_queue(self):
        """Start next queued run if capacity available."""
        running_count = sum(1 for r in self.active_runs.values() if r.get("status") in (RunStatus.RUNNING, RunStatus.IDLE))
        while running_count < settings.max_concurrent_runs and not self._queue.empty():
            try:
                run_id = self._queue.get_nowait()
                if run_id in self._queue_items:
                    item = self._queue_items.pop(run_id)
                    logger.info("Run %s: Dequeued, launching container", run_id)
                    await self._launch_container(**item)
                    running_count += 1
            except asyncio.QueueEmpty:
                break

    async def stream_session(self, run_id: str):
        """
        Generator that yields output from the session's output queue.
        Stays open across multiple prompts. Yields (type, data) tuples.
        Ends only on session_end signal or timeout.
        """
        run = self.active_runs.get(run_id)
        if not run:
            yield ("error", "Run nicht gefunden")
            return

        output_queue = self._output_queues.get(run_id)
        if not output_queue:
            yield ("error", "Session-Queue nicht gefunden")
            return

        try:
            while True:
                try:
                    msg_type, payload = await asyncio.wait_for(output_queue.get(), timeout=300)
                except asyncio.TimeoutError:
                    # Send keepalive instead of terminating
                    yield ("output", json.dumps({"type": "keepalive"}))
                    continue

                if msg_type == "session_end":
                    # payload is a JSON string with type/data
                    try:
                        end_data = json.loads(payload)
                        yield (end_data.get("type", "complete"), end_data.get("data", "Session beendet"))
                    except (json.JSONDecodeError, AttributeError):
                        yield ("complete", "Session beendet")
                    return

                if msg_type == "data":
                    yield ("output", payload)

        except Exception as e:
            logger.error("Run %s: Stream session error: %s", run_id, e)
            yield ("error", str(e))

    async def stop_run(self, run_id: str):
        """Stop a session: signal end, stop container, persist to DB."""
        run = self.active_runs.get(run_id)
        if not run:
            return

        # Signal session end through output queue
        output_queue = self._output_queues.get(run_id)
        if output_queue:
            await output_queue.put(("session_end", json.dumps({
                "type": "complete",
                "data": "Session beendet",
            })))

        exit_code = 0
        run["status"] = RunStatus.COMPLETED

        # Stop and remove container
        container_id = run.get("container_id")
        if container_id:
            try:
                container = self.client.containers.get(container_id)
                container.stop(timeout=10)
                exit_code = 0
            except Exception:
                pass

        run["exit_code"] = exit_code

        # Persist to DB
        await self._save_run_to_db(run_id, exit_code)

        # Cleanup
        self._output_queues.pop(run_id, None)
        self._prompt_counters.pop(run_id, None)

    def get_container_stats(self, run_id: str) -> dict | None:
        """Get resource usage stats for a running container."""
        if run_id not in self.active_runs:
            return None
        run = self.active_runs[run_id]
        container_id = run.get("container_id")
        if not container_id:
            return None
        try:
            container = self.client.containers.get(container_id)
            stats = container.stats(stream=False)
            # Calculate CPU percentage
            cpu_delta = stats["cpu_stats"]["cpu_usage"]["total_usage"] - stats["precpu_stats"]["cpu_usage"]["total_usage"]
            system_delta = stats["cpu_stats"]["system_cpu_usage"] - stats["precpu_stats"]["system_cpu_usage"]
            num_cpus = len(stats["cpu_stats"]["cpu_usage"].get("percpu_usage", [1]))
            cpu_percent = (cpu_delta / system_delta) * num_cpus * 100.0 if system_delta > 0 else 0.0
            # Memory
            memory_usage = stats["memory_stats"].get("usage", 0)
            memory_limit = stats["memory_stats"].get("limit", 0)
            memory_mb = memory_usage / (1024 * 1024)
            memory_limit_mb = memory_limit / (1024 * 1024)
            return {
                "cpu_percent": round(cpu_percent, 1),
                "memory_mb": round(memory_mb, 1),
                "memory_limit_mb": round(memory_limit_mb, 1),
            }
        except Exception:
            return None

    def get_run_details(self, run_id: str) -> dict | None:
        """Container-Status und letzte Log-Zeilen für einen Run."""
        run = self.active_runs.get(run_id)
        if not run:
            return None

        # Status aus Container-Zustand aktualisieren
        self._update_run_status(run_id)

        container_id = run.get("container_id")
        details = {
            "run_id": run_id,
            "status": run["status"],
            "container_id": container_id[:12] if container_id else None,
            "container_status": None,
            "exit_code": None,
            "logs": [],
            "workspace_path": run.get("workspace_path"),
            "project_id": run.get("project_id"),
            "synced": run.get("synced", False),
        }

        if not container_id:
            # Queued run — no container yet
            return details

        try:
            container = self.client.containers.get(run["container_id"])
            container.reload()
            details["container_status"] = container.status
            state = container.attrs.get("State", {})
            if state.get("Status") == "exited":
                details["exit_code"] = state.get("ExitCode")
                run["exit_code"] = details["exit_code"]
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
            # Gespeicherten Exit-Code und Logs verwenden
            details["exit_code"] = run.get("exit_code")
            details["logs"] = run.get("saved_logs", [])
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
            self._update_run_status(run_id)
            container_id = run.get("container_id")
            result.append({
                "run_id": run_id,
                "status": run["status"],
                "container_id": container_id[:12] if container_id else None,
                "project_id": run.get("project_id"),
            })
        return result
