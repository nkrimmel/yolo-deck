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

export interface DirEntry {
    name: string;
    path: string;
    is_dir: boolean;
    is_git: boolean;
}

export async function fetchProjects(): Promise<Project[]> {
    const res = await fetch(`${API_BASE}/api/projects`);
    return res.json();
}

export async function addProject(path: string): Promise<Project> {
    const res = await fetch(`${API_BASE}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
    });
    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Fehler beim Hinzufügen");
    }
    return res.json();
}

export async function removeProject(projectId: string): Promise<void> {
    await fetch(`${API_BASE}/api/projects/${projectId}`, { method: "DELETE" });
}

export async function browseDirectory(path: string): Promise<DirEntry[]> {
    const res = await fetch(
        `${API_BASE}/api/browse?path=${encodeURIComponent(path)}`
    );
    if (!res.ok) return [];
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
    if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
            const err = await res.json();
            detail = err.detail || JSON.stringify(err);
        } catch {
            // response body wasn't JSON
        }
        throw new Error(detail);
    }
    return res.json();
}

export async function stopRun(runId: string): Promise<void> {
    await fetch(`${API_BASE}/api/run/${runId}/stop`, { method: "POST" });
}

export interface RunDetails {
    run_id: string;
    status: string;
    container_id: string;
    container_status: string | null;
    exit_code: number | null;
    logs: string[];
}

export async function fetchRunDetails(runId: string): Promise<RunDetails | null> {
    try {
        const res = await fetch(`${API_BASE}/api/run/${runId}`);
        if (!res.ok) return null;
        return res.json();
    } catch {
        return null;
    }
}

export interface ActiveRun {
    run_id: string;
    status: string;
    container_id: string;
    project_id: string | null;
}

export async function fetchActiveRuns(): Promise<ActiveRun[]> {
    try {
        const res = await fetch(`${API_BASE}/api/runs`);
        if (!res.ok) return [];
        return res.json();
    } catch {
        return [];
    }
}
