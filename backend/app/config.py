from pydantic_settings import BaseSettings
from pathlib import Path

# Detect local dev vs Docker: if /app/projects exists use Docker paths,
# otherwise use repo-relative paths (backend/ is one level below repo root)
_repo_root = Path(__file__).resolve().parent.parent.parent
_default_projects = Path("/app/projects") if Path("/app/projects").exists() else _repo_root / "projects"
_default_workspaces = Path("/app/workspaces") if Path("/app/workspaces").exists() else _repo_root / "workspaces"


class Settings(BaseSettings):
    # Pfade
    projects_dir: Path = _default_projects
    workspaces_dir: Path = _default_workspaces

    # Docker
    docker_image: str = "claude-code"
    container_memory_limit: str = "4g"
    container_cpu_limit: float = 4.0

    # Auth — subscription auth via ~/.claude mount (default),
    # or optional API key override
    anthropic_api_key: str = ""
    claude_home: Path = Path.home() / ".claude"
    claude_json: Path = Path.home() / ".claude.json"

    # Claude
    default_model: str = "claude-sonnet-4-20250514"
    max_turns: int = 50

    # Browse — root path for the directory browser (host mount in Docker)
    browse_root: str = "~"

    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    allowed_origins: list[str] = ["http://localhost:3000"]

    model_config = {"env_file": ".env", "env_prefix": "YOLO_"}


settings = Settings()
