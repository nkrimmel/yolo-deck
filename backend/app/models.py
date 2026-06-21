from pydantic import BaseModel
from enum import Enum


class RunStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    IDLE = "idle"
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
    provider: str = "anthropic"


class RunResponse(BaseModel):
    run_id: str
    project_id: str
    status: RunStatus
    branch: str | None = None


class StreamMessage(BaseModel):
    type: str  # "output", "status", "error", "complete"
    data: str
    run_id: str


class PromptRequest(BaseModel):
    prompt: str
    model: str | None = None
    max_turns: int | None = None


class AddProjectRequest(BaseModel):
    path: str


class CreateDirRequest(BaseModel):
    path: str


class DirEntry(BaseModel):
    name: str
    path: str
    is_dir: bool
    is_git: bool = False


class HistoryEntry(BaseModel):
    id: str
    project_id: str | None = None
    project_name: str | None = None
    prompt: str | None = None
    model: str | None = None
    provider: str | None = None
    status: str | None = None
    exit_code: int | None = None
    cost_usd: float | None = None
    duration_ms: float | None = None
    num_turns: int | None = None
    started_at: str | None = None
    finished_at: str | None = None


class HistoryDetail(HistoryEntry):
    logs_json: str | None = None


class PromptTemplate(BaseModel):
    id: str
    name: str
    prompt: str
    model: str | None = None
    created_at: str | None = None


class CreateTemplateRequest(BaseModel):
    name: str
    prompt: str
    model: str | None = None
