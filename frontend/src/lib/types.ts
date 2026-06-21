export interface StreamMessage {
    type: "output" | "status" | "error" | "complete" | "idle" | "prompt_start" | "keepalive";
    data: string;
    run_id: string;
}

export type SessionStatus = "running" | "completed" | "error" | "stopped" | "queued" | "idle";

export interface ContainerInfo {
    containerId: string;
    containerStatus: string;
    exitCode: number | null;
}

export interface RunMetadata {
    cost?: number;
    duration?: number;
    turns?: number;
}

export interface Session {
    id: string;
    projectId: string;
    projectName: string;
    prompt: string;
    model: string;
    status: SessionStatus;
    lines: StreamMessage[];
    startedAt: Date;
    finishedAt: Date | null;
    container: ContainerInfo | null;
    metadata: RunMetadata | null;
    parentId?: string;
    workspacePath?: string;
}

export interface HistoryEntry {
    id: string;
    project_id?: string;
    project_name?: string;
    prompt?: string;
    model?: string;
    provider?: string;
    status?: string;
    exit_code?: number;
    cost_usd?: number;
    duration_ms?: number;
    num_turns?: number;
    started_at?: string;
    finished_at?: string;
}

export interface PromptTemplate {
    id: string;
    name: string;
    prompt: string;
    model?: string;
    created_at?: string;
}

export const WS_BASE = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8000";
