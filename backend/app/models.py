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


class AddProjectRequest(BaseModel):
    path: str


class DirEntry(BaseModel):
    name: str
    path: str
    is_dir: bool
    is_git: bool = False
