export interface StreamMessage {
    type: "output" | "status" | "error" | "complete";
    data: string;
    run_id: string;
}

export type SessionStatus = "running" | "completed" | "error" | "stopped";

export interface ContainerInfo {
    containerId: string;
    containerStatus: string;
    exitCode: number | null;
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
}
