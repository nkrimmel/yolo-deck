"use client";
import { useState, useCallback, useRef, useEffect } from "react";
import {
    startRun,
    stopRun,
    sendPrompt,
    fetchRunDetails,
    fetchActiveRuns,
    fetchProjects,
} from "./api";
import { Session, StreamMessage, ContainerInfo, WS_BASE, RunMetadata } from "./types";
import { extractRunMetadata } from "./logParser";

const POLL_INTERVAL = 2000;

export function useSessionManager() {
    const [sessions, setSessions] = useState<Session[]>([]);
    const pollRefs = useRef<Map<string, number>>(new Map());
    const wsRefs = useRef<Record<string, WebSocket>>({});
    const restored = useRef(false);

    /** Start polling container status + logs every 2s. */
    function startPolling(runId: string) {
        if (pollRefs.current.has(runId)) return;

        const poll = async () => {
            try {
                const details = await fetchRunDetails(runId);
                if (!details) return;

                const container: ContainerInfo = {
                    containerId: details.container_id,
                    containerStatus: details.container_status || "unknown",
                    exitCode: details.exit_code,
                };

                const isFinished =
                    details.status === "completed" ||
                    details.status === "failed" ||
                    details.container_status === "exited" ||
                    details.container_status === "removed";

                const isIdle = details.status === "idle";

                setSessions((prev) =>
                    prev.map((s) => {
                        if (s.id !== runId) return s;

                        const logLines: StreamMessage[] = details.logs.map(
                            (line) => ({
                                type: "output" as const,
                                data: line,
                                run_id: runId,
                            })
                        );

                        const exitCode = details.exit_code ?? -1;
                        const newStatus = isFinished
                            ? exitCode === 0
                                ? ("completed" as const)
                                : ("error" as const)
                            : isIdle
                                ? ("idle" as const)
                                : ("running" as const);

                        if (isFinished) {
                            const msg =
                                exitCode === 0
                                    ? `Abgeschlossen (Exit Code: 0)`
                                    : `Fehlgeschlagen (Exit Code: ${exitCode})`;
                            logLines.push({
                                type: exitCode === 0 ? "complete" : "error",
                                data: msg,
                                run_id: runId,
                            });
                        }

                        const metadata = extractRunMetadata(logLines);

                        // Browser notification on completion
                        if (isFinished && (s.status === "running" || s.status === "idle")) {
                            sendNotification(newStatus, s);
                        }

                        return {
                            ...s,
                            container,
                            status: newStatus,
                            lines: logLines,
                            metadata: metadata || s.metadata,
                            finishedAt: isFinished && !s.finishedAt ? new Date() : s.finishedAt,
                            workspacePath: details.workspace_path || s.workspacePath,
                        };
                    })
                );

                // Stop polling only when truly finished (not idle)
                if (isFinished) {
                    const intervalId = pollRefs.current.get(runId);
                    if (intervalId) clearInterval(intervalId);
                    pollRefs.current.delete(runId);
                }
            } catch {
                // Network error — will retry next interval
            }
        };

        poll();
        const intervalId = window.setInterval(poll, POLL_INTERVAL);
        pollRefs.current.set(runId, intervalId);
    }

    function stopPolling(id: string) {
        const intervalId = pollRefs.current.get(id);
        if (intervalId) clearInterval(intervalId);
        pollRefs.current.delete(id);
    }

    function sendNotification(newStatus: string, session: Session) {
        if (typeof Notification === "undefined") return;
        if (Notification.permission !== "granted") return;
        if (document.hasFocus()) return;

        if (newStatus === "completed") {
            new Notification(`✓ ${session.projectName} fertig`, {
                body: session.prompt.slice(0, 100),
            });
        } else if (newStatus === "error") {
            new Notification(`✗ ${session.projectName} fehlgeschlagen`, {
                body: session.prompt.slice(0, 100),
            });
        }
    }

    /** Connect WebSocket for real-time log streaming. */
    const connectWebSocket = useCallback((runId: string) => {
        const token = typeof window !== "undefined" ? localStorage.getItem("yolo_auth_token") : null;
        const wsUrl = token
            ? `${WS_BASE}/ws/run/${runId}?token=${encodeURIComponent(token)}`
            : `${WS_BASE}/ws/run/${runId}`;
        const ws = new WebSocket(wsUrl);
        wsRefs.current[runId] = ws;

        ws.onmessage = (event) => {
            try {
                const msg: StreamMessage = JSON.parse(event.data);

                // Check if the output data itself contains idle/prompt_start signals
                let innerType: string | null = null;
                if (msg.type === "output") {
                    try {
                        const inner = JSON.parse(msg.data);
                        if (inner.type === "idle" || inner.type === "prompt_start" || inner.type === "keepalive") {
                            innerType = inner.type;
                        }
                    } catch {
                        // not JSON, that's fine
                    }
                }

                setSessions((prev) =>
                    prev.map((s) => {
                        if (s.id !== runId) return s;

                        // Skip keepalive messages from accumulating
                        if (innerType === "keepalive" || msg.type === "keepalive") {
                            return s;
                        }

                        const newLines = [...s.lines, msg];
                        const metadata = extractRunMetadata(newLines);

                        if (msg.type === "complete") {
                            sendNotification("completed", s);
                            return {
                                ...s,
                                lines: newLines,
                                status: "completed" as const,
                                finishedAt: new Date(),
                                metadata: metadata || s.metadata,
                            };
                        }
                        if (msg.type === "error") {
                            sendNotification("error", s);
                            return {
                                ...s,
                                lines: newLines,
                                status: "error" as const,
                                finishedAt: new Date(),
                                metadata: metadata || s.metadata,
                            };
                        }

                        // Handle idle signal — session is waiting for next prompt
                        if (innerType === "idle") {
                            return {
                                ...s,
                                lines: newLines,
                                status: "idle" as const,
                                metadata: metadata || s.metadata,
                            };
                        }

                        // Handle prompt_start — back to running
                        if (innerType === "prompt_start") {
                            return {
                                ...s,
                                lines: newLines,
                                status: "running" as const,
                                metadata: metadata || s.metadata,
                            };
                        }

                        return {
                            ...s,
                            lines: newLines,
                            metadata: metadata || s.metadata,
                        };
                    })
                );
            } catch {
                // Ignore parse errors
            }
        };

        ws.onclose = () => {
            delete wsRefs.current[runId];
            // Final fetch to get complete status
            fetchRunDetails(runId).then((details) => {
                if (!details) return;
                setSessions((prev) =>
                    prev.map((s) => {
                        if (s.id !== runId) return s;
                        if (s.status === "running" || s.status === "idle") {
                            // If backend says idle, fall back to polling
                            if (details.status === "idle" || details.status === "running") {
                                startPolling(runId);
                                return s;
                            }
                            const status =
                                details.exit_code === 0
                                    ? ("completed" as const)
                                    : details.exit_code !== null
                                      ? ("error" as const)
                                      : s.status;
                            if (status !== "running" && status !== "idle") {
                                sendNotification(status, s);
                            }
                            return {
                                ...s,
                                status,
                                finishedAt: status !== "running" ? new Date() : null,
                            };
                        }
                        return s;
                    })
                );
            });
        };

        ws.onerror = () => {
            // WebSocket failed, fall back to polling
            ws.close();
            startPolling(runId);
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Restore active runs from backend on mount
    useEffect(() => {
        if (restored.current) return;
        restored.current = true;

        (async () => {
            const [runs, projects] = await Promise.all([
                fetchActiveRuns(),
                fetchProjects(),
            ]);

            if (runs.length === 0) return;

            const restoredSessions: Session[] = runs.map((run) => {
                const project = projects.find((p) => p.id === run.project_id);
                return {
                    id: run.run_id,
                    projectId: run.project_id || "",
                    projectName: project?.name || run.project_id || "Unbekannt",
                    prompt: "(wiederhergestellt)",
                    model: "",
                    status: "running" as const,
                    lines: [],
                    startedAt: new Date(),
                    finishedAt: null,
                    container: null,
                    metadata: null,
                };
            });

            setSessions((prev) => {
                // Don't add duplicates
                const existingIds = new Set(prev.map((s) => s.id));
                const newSessions = restoredSessions.filter(
                    (s) => !existingIds.has(s.id)
                );
                return [...prev, ...newSessions];
            });

            // Restored runs use polling (may have missed earlier WS messages)
            for (const run of runs) {
                startPolling(run.run_id);
            }
        })();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const startSession = useCallback(
        async (
            projectId: string,
            projectName: string,
            prompt: string,
            model: string,
            provider: string = "anthropic",
        ) => {
            // Request notification permission on first session start
            if (typeof Notification !== "undefined" && Notification.permission === "default") {
                Notification.requestPermission();
            }

            const session: Session = {
                id: "",
                projectId,
                projectName,
                prompt,
                model,
                status: "running",
                lines: [],
                startedAt: new Date(),
                finishedAt: null,
                container: null,
                metadata: null,
            };

            let runId: string;
            try {
                const run = await startRun(projectId, prompt, model, provider);
                runId = run.run_id;
            } catch (e) {
                const errorMsg = e instanceof Error ? e.message : String(e);
                session.id = `err-${Date.now()}`;
                session.status = "error";
                session.lines = [
                    {
                        type: "error",
                        data: `API-Fehler: ${errorMsg}`,
                        run_id: session.id,
                    },
                ];
                setSessions((prev) => [session, ...prev]);
                return;
            }

            session.id = runId;
            setSessions((prev) => [session, ...prev]);
            connectWebSocket(runId);
        },
        [connectWebSocket]
    );

    const stopSession = useCallback(async (id: string) => {
        try {
            await stopRun(id);
        } catch {
            // container may already be gone
        }
        // Close WebSocket if open
        const ws = wsRefs.current[id];
        if (ws) {
            ws.close();
            delete wsRefs.current[id];
        }
        stopPolling(id);
        setSessions((prev) =>
            prev.map((s) =>
                s.id === id && (s.status === "running" || s.status === "idle")
                    ? { ...s, status: "stopped", finishedAt: new Date() }
                    : s
            )
        );
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const sendSessionPrompt = useCallback(async (id: string, prompt: string) => {
        try {
            await sendPrompt(id, prompt);
            // Status will be updated via WebSocket/polling when prompt_start arrives
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            setSessions((prev) =>
                prev.map((s) => {
                    if (s.id !== id) return s;
                    return {
                        ...s,
                        lines: [...s.lines, {
                            type: "error" as const,
                            data: `Prompt-Fehler: ${errorMsg}`,
                            run_id: id,
                        }],
                    };
                })
            );
        }
    }, []);

    const removeSession = useCallback((id: string) => {
        // Close WebSocket if open
        const ws = wsRefs.current[id];
        if (ws) {
            ws.close();
            delete wsRefs.current[id];
        }
        stopPolling(id);
        setSessions((prev) => prev.filter((s) => s.id !== id));
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const clearCompleted = useCallback(() => {
        setSessions((prev) =>
            prev.filter((s) => {
                if (s.status !== "running" && s.status !== "idle") {
                    const ws = wsRefs.current[s.id];
                    if (ws) {
                        ws.close();
                        delete wsRefs.current[s.id];
                    }
                    stopPolling(s.id);
                    return false;
                }
                return true;
            })
        );
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const refreshStatus = useCallback(async (id: string) => {
        const details = await fetchRunDetails(id);
        if (!details) return;
        const container: ContainerInfo = {
            containerId: details.container_id,
            containerStatus: details.container_status || "unknown",
            exitCode: details.exit_code,
        };
        setSessions((prev) =>
            prev.map((s) => {
                if (s.id !== id) return s;
                const logLines: StreamMessage[] = details.logs.map(
                    (line) => ({
                        type: "output" as const,
                        data: line,
                        run_id: id,
                    })
                );
                const metadata = extractRunMetadata(logLines);
                return { ...s, container, lines: logLines, metadata: metadata || s.metadata, workspacePath: details.workspace_path || s.workspacePath };
            })
        );
    }, []);

    const activeCount = sessions.filter((s) => s.status === "running" || s.status === "idle").length;

    return {
        sessions,
        activeCount,
        startSession,
        stopSession,
        removeSession,
        clearCompleted,
        refreshStatus,
        sendSessionPrompt,
    };
}
