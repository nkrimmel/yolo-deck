"use client";
import { useState, useCallback, useRef, useEffect } from "react";
import {
    startRun,
    stopRun,
    fetchRunDetails,
    fetchActiveRuns,
    fetchProjects,
} from "./api";
import { Session, StreamMessage, ContainerInfo } from "./types";

const POLL_INTERVAL = 2000;

export function useSessionManager() {
    const [sessions, setSessions] = useState<Session[]>([]);
    const pollRefs = useRef<Map<string, number>>(new Map());
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

                        const newStatus = isFinished
                            ? details.exit_code === 0
                                ? ("completed" as const)
                                : ("error" as const)
                            : ("running" as const);

                        if (isFinished) {
                            const msg =
                                details.exit_code === 0
                                    ? `Abgeschlossen (Exit Code: 0)`
                                    : `Fehlgeschlagen (Exit Code: ${details.exit_code})`;
                            logLines.push({
                                type:
                                    details.exit_code === 0
                                        ? "complete"
                                        : "error",
                                data: msg,
                                run_id: runId,
                            });
                        }

                        return {
                            ...s,
                            container,
                            status: newStatus,
                            lines: logLines,
                            finishedAt: isFinished && !s.finishedAt ? new Date() : s.finishedAt,
                        };
                    })
                );

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
                    status: "running" as const,
                    lines: [],
                    startedAt: new Date(),
                    finishedAt: null,
                    container: null,
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

            // Start polling for each restored run
            for (const run of runs) {
                startPolling(run.run_id);
            }
        })();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const startSession = useCallback(
        async (projectId: string, projectName: string, prompt: string) => {
            const session: Session = {
                id: "",
                projectId,
                projectName,
                prompt,
                status: "running",
                lines: [],
                startedAt: new Date(),
                finishedAt: null,
                container: null,
            };

            let runId: string;
            try {
                const run = await startRun(projectId, prompt);
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
            startPolling(runId);
        },
        [] // eslint-disable-line react-hooks/exhaustive-deps
    );

    const stopSession = useCallback(async (id: string) => {
        try {
            await stopRun(id);
        } catch {
            // container may already be gone
        }
        stopPolling(id);
        setSessions((prev) =>
            prev.map((s) =>
                s.id === id && s.status === "running"
                    ? { ...s, status: "stopped", finishedAt: new Date() }
                    : s
            )
        );
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const removeSession = useCallback((id: string) => {
        stopPolling(id);
        setSessions((prev) => prev.filter((s) => s.id !== id));
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const clearCompleted = useCallback(() => {
        setSessions((prev) =>
            prev.filter((s) => {
                if (s.status !== "running") {
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
                return { ...s, container, lines: logLines };
            })
        );
    }, []);

    const activeCount = sessions.filter((s) => s.status === "running").length;

    return {
        sessions,
        activeCount,
        startSession,
        stopSession,
        removeSession,
        clearCompleted,
        refreshStatus,
    };
}
