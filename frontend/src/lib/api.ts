import { HistoryEntry, PromptTemplate } from './types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
    const token = typeof window !== "undefined" ? localStorage.getItem("yolo_auth_token") : null;
    const headers = new Headers(init?.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(`${API_BASE}${path}`, { ...init, headers });
}

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
    const res = await apiFetch("/api/projects");
    if (res.status === 401) throw new Error("401");
    return res.json();
}

export async function addProject(path: string): Promise<Project> {
    const res = await apiFetch("/api/projects", {
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
    await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" });
}

export async function browseDirectory(path: string): Promise<DirEntry[]> {
    const res = await apiFetch(
        `/api/browse?path=${encodeURIComponent(path)}`
    );
    if (!res.ok) return [];
    return res.json();
}

export async function createDirectory(path: string): Promise<{ path: string }> {
    const res = await apiFetch(`/api/mkdir`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
    });
    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Fehler beim Erstellen");
    }
    return res.json();
}

export interface OllamaModel {
    name: string;
    size: number;
    modified_at: string;
}

export async function fetchOllamaStatus(): Promise<{available: boolean}> {
    try {
        const res = await apiFetch(`/api/ollama/status`);
        if (!res.ok) return { available: false };
        return res.json();
    } catch {
        return { available: false };
    }
}

export async function fetchOllamaModels(): Promise<OllamaModel[]> {
    try {
        const res = await apiFetch(`/api/ollama/models`);
        if (!res.ok) return [];
        const data = await res.json();
        return data.models || data || [];
    } catch {
        return [];
    }
}

export async function startRun(
    projectId: string,
    prompt: string,
    model?: string,
    provider?: string,
): Promise<RunResponse> {
    const res = await apiFetch(`/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            project_id: projectId,
            prompt,
            model,
            provider: provider || "anthropic",
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
    await apiFetch(`/api/run/${runId}/stop`, { method: "POST" });
}

export async function sendPrompt(
    runId: string,
    prompt: string,
    model?: string,
    maxTurns?: number,
): Promise<void> {
    const res = await apiFetch(`/api/run/${runId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            prompt,
            model: model || undefined,
            max_turns: maxTurns || undefined,
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
}

export interface RunDetails {
    run_id: string;
    status: string;
    container_id: string;
    container_status: string | null;
    exit_code: number | null;
    logs: string[];
    workspace_path: string | null;
}

export async function fetchRunDetails(runId: string): Promise<RunDetails | null> {
    try {
        const res = await apiFetch(`/api/run/${runId}`);
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
        const res = await apiFetch(`/api/runs`);
        if (!res.ok) return [];
        return res.json();
    } catch {
        return [];
    }
}

export async function fetchHistory(limit = 50, offset = 0): Promise<HistoryEntry[]> {
    const res = await apiFetch(`/api/history?limit=${limit}&offset=${offset}`);
    if (!res.ok) return [];
    return res.json();
}

export async function fetchHistoryRun(runId: string): Promise<any> {
    const res = await apiFetch(`/api/history/${runId}`);
    if (!res.ok) return null;
    return res.json();
}

export async function deleteHistory(): Promise<void> {
    await apiFetch(`/api/history`, { method: "DELETE" });
}

export async function fetchRunFiles(runId: string, path = ""): Promise<any[]> {
    const res = await apiFetch(`/api/run/${runId}/files?path=${encodeURIComponent(path)}`);
    if (!res.ok) return [];
    return res.json();
}

export async function fetchRunFile(runId: string, path: string): Promise<{ content: string; truncated: boolean }> {
    const res = await apiFetch(`/api/run/${runId}/file?path=${encodeURIComponent(path)}`);
    if (!res.ok) return { content: "", truncated: false };
    return res.json();
}

export async function fetchRunStats(runId: string): Promise<{ cpu_percent: number; memory_mb: number; memory_limit_mb: number } | null> {
    const res = await apiFetch(`/api/run/${runId}/stats`);
    if (!res.ok) return null;
    return res.json();
}

export async function fetchTemplates(): Promise<PromptTemplate[]> {
    const res = await apiFetch(`/api/templates`);
    if (!res.ok) return [];
    return res.json();
}

export async function saveTemplate(name: string, prompt: string, model?: string): Promise<PromptTemplate | null> {
    const res = await apiFetch(`/api/templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, prompt, model: model || null }),
    });
    if (!res.ok) return null;
    return res.json();
}

export async function deleteTemplate(id: string): Promise<void> {
    await apiFetch(`/api/templates/${id}`, { method: "DELETE" });
}
