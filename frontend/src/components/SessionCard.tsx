"use client";
import { useEffect, useRef, useState } from "react";
import { Session } from "@/lib/types";
import { parseLogLines, TerminalLine } from "@/lib/logParser";
import { fetchRunStats } from "@/lib/api";
import WorkspaceExplorer from "./WorkspaceExplorer";

const STATUS_DOT: Record<Session["status"], string> = {
    running: "bg-emerald-500 animate-pulse",
    idle: "bg-blue-500",
    completed: "bg-emerald-500",
    error: "bg-red-500",
    stopped: "bg-yellow-500",
    queued: "bg-yellow-500",
};

const STATUS_LABEL: Record<Session["status"], string> = {
    running: "Läuft",
    idle: "Bereit",
    completed: "Fertig",
    error: "Fehler",
    stopped: "Gestoppt",
    queued: "Warteschlange",
};

const LINE_STYLES: Record<TerminalLine["style"], string> = {
    text: "text-gray-900 dark:text-zinc-200",
    tool: "text-cyan-700 dark:text-cyan-400",
    "tool-result": "text-gray-500 dark:text-zinc-500 text-[11px]",
    system: "text-yellow-700 dark:text-yellow-500 italic",
    result: "text-emerald-700 dark:text-emerald-400",
    error: "text-red-600 dark:text-red-400",
    dim: "text-gray-400 dark:text-zinc-600",
};

function formatTime(d: Date) {
    return d.toLocaleTimeString("de-DE", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
}

function formatElapsed(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    if (h > 0) return `${h}:${mm}:${ss}`;
    return `${mm}:${ss}`;
}

/** Live elapsed timer that updates every second. */
function ElapsedTimer({ startedAt, stoppedAt }: { startedAt: Date; stoppedAt?: Date }) {
    const [now, setNow] = useState(Date.now());

    useEffect(() => {
        if (stoppedAt) return;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [stoppedAt]);

    const endTime = stoppedAt ? stoppedAt.getTime() : now;
    const elapsed = Math.max(0, endTime - startedAt.getTime());
    return <span className="font-mono">{formatElapsed(elapsed)}</span>;
}

interface Props {
    session: Session;
    onStop: () => void;
    onRemove: () => void;
    onRefresh: () => void;
    onChain?: (projectId: string, projectName: string) => void;
    onSendPrompt?: (runId: string, prompt: string) => void;
}

export default function SessionCard({ session, onStop, onRemove, onRefresh, onChain, onSendPrompt }: Props) {
    const isActive = session.status === "running" || session.status === "queued" || session.status === "idle";
    const [collapsed, setCollapsed] = useState(!isActive);
    const [followUpPrompt, setFollowUpPrompt] = useState("");
    const [activeTab, setActiveTab] = useState<"output" | "files">("output");
    const [stats, setStats] = useState<{ cpu_percent: number; memory_mb: number; memory_limit_mb: number } | null>(null);
    const termRef = useRef<HTMLDivElement>(null);
    const userScrolledUp = useRef(false);

    // Auto-expand when session starts running
    useEffect(() => {
        if (isActive) setCollapsed(false);
    }, [isActive]);

    // Auto-collapse when session finishes (but NOT when idle)
    useEffect(() => {
        if (!isActive && session.status !== "idle" && session.lines.length > 0) setCollapsed(true);
    }, [isActive, session.status, session.lines.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

    // Poll container stats for running/idle sessions when expanded
    useEffect(() => {
        if ((session.status !== "running" && session.status !== "idle") || collapsed) return;
        const doFetch = () => fetchRunStats(session.id).then(setStats).catch(() => {});
        doFetch();
        const id = setInterval(doFetch, 5000);
        return () => clearInterval(id);
    }, [session.status, collapsed, session.id]);

    // Parse raw log lines into formatted terminal lines
    const rawTexts = session.lines.map((l) => l.data);
    const terminalLines = parseLogLines(rawTexts);

    // Also include non-output lines (errors, status, complete from the session manager)
    const metaLines: TerminalLine[] = session.lines
        .filter((l) => l.type !== "output")
        .map((l) => ({
            text: l.data,
            style: l.type === "error"
                ? "error" as const
                : l.type === "complete"
                    ? "result" as const
                    : "system" as const,
        }));

    const allLines = [...terminalLines, ...metaLines];

    // Auto-scroll
    useEffect(() => {
        if (!userScrolledUp.current && termRef.current) {
            termRef.current.scrollTop = termRef.current.scrollHeight;
        }
    }, [allLines.length]);

    const handleScroll = () => {
        if (!termRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = termRef.current;
        userScrolledUp.current = scrollHeight - scrollTop - clientHeight > 40;
    };

    const promptPreview =
        session.prompt.length > 60
            ? session.prompt.slice(0, 60) + "..."
            : session.prompt;

    const hasError = session.status === "error";
    const container = session.container;
    const isStopped = session.status !== "running" && session.status !== "queued" && session.status !== "idle";
    const isCompleted = session.status === "completed";

    return (
        <div className="bg-white border border-gray-200 dark:bg-zinc-900 dark:border-zinc-700 rounded-lg overflow-hidden">
            {/* Header */}
            <div
                className="flex items-center gap-3 px-4 py-3 cursor-pointer
                           hover:bg-gray-50 dark:hover:bg-zinc-800/50"
                onClick={() => setCollapsed(!collapsed)}
            >
                <span
                    className={`w-2.5 h-2.5 rounded-full shrink-0 ${STATUS_DOT[session.status]}`}
                />
                <span className="font-medium text-sm truncate">
                    {session.projectName}
                </span>
                {session.parentId && (
                    <span className="text-purple-600 dark:text-purple-400 text-[10px]
                                     bg-purple-50 dark:bg-purple-950/50
                                     px-1.5 py-0.5 rounded shrink-0">
                        Kette
                    </span>
                )}
                {session.model && (
                    <span className="text-gray-500 dark:text-zinc-500 text-[10px]
                                     bg-gray-100 dark:bg-zinc-800
                                     px-1.5 py-0.5 rounded shrink-0">
                        {session.model.replace(/^claude-/, "").replace(/-\d{8}$/, "")}
                    </span>
                )}
                <span className="text-gray-400 dark:text-zinc-500 text-xs truncate flex-1">
                    {promptPreview}
                </span>

                {/* Timer */}
                <span className="text-gray-400 dark:text-zinc-500 text-xs shrink-0">
                    <ElapsedTimer
                        startedAt={session.startedAt}
                        stoppedAt={isStopped ? session.finishedAt ?? undefined : undefined}
                    />
                </span>

                {/* Cost badge */}
                {session.metadata?.cost != null && session.metadata.cost > 0 && (
                    <span className="text-emerald-600 dark:text-emerald-400 text-[10px] bg-emerald-50 dark:bg-emerald-950/50 px-1.5 py-0.5 rounded shrink-0">
                        ${session.metadata.cost.toFixed(4)}
                    </span>
                )}
                {/* Turns badge */}
                {session.metadata?.turns != null && session.metadata.turns > 0 && (
                    <span className="text-gray-500 dark:text-zinc-500 text-[10px] shrink-0">
                        {session.metadata.turns}T
                    </span>
                )}

                <span className="text-gray-500 dark:text-zinc-600 text-xs shrink-0">
                    {STATUS_LABEL[session.status]}
                </span>
                {!isActive && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onRemove();
                        }}
                        className="text-gray-400 hover:text-gray-600
                                   dark:text-zinc-600 dark:hover:text-zinc-300
                                   text-sm px-1"
                        title="Entfernen"
                    >
                        X
                    </button>
                )}
            </div>

            {/* Container Status */}
            {container && (
                <div className="px-4 py-2 border-t border-gray-100 bg-gray-50
                                dark:border-zinc-800 dark:bg-zinc-900/50
                                flex items-center gap-4 text-xs flex-wrap">
                    {session.workspacePath && (
                        <span className="text-gray-500 dark:text-zinc-500">
                            Pfad:{" "}
                            <span className="font-mono text-gray-600 dark:text-zinc-400">
                                {session.workspacePath}
                            </span>
                        </span>
                    )}
                    <span className="text-gray-500 dark:text-zinc-500">
                        Container:{" "}
                        <span className="font-mono text-gray-600 dark:text-zinc-400">
                            {container.containerId}
                        </span>
                    </span>
                    <span className="text-gray-500 dark:text-zinc-500">
                        Status:{" "}
                        <span
                            className={
                                container.containerStatus === "running"
                                    ? "text-emerald-600 dark:text-emerald-400"
                                    : container.containerStatus === "exited"
                                      ? "text-red-500 dark:text-red-400"
                                      : "text-yellow-600 dark:text-yellow-400"
                            }
                        >
                            {container.containerStatus}
                        </span>
                    </span>
                    {container.exitCode !== null && (
                        <span className="text-gray-500 dark:text-zinc-500">
                            Exit Code:{" "}
                            <span
                                className={
                                    container.exitCode === 0
                                        ? "text-emerald-600 dark:text-emerald-400"
                                        : "text-red-500 dark:text-red-400"
                                }
                            >
                                {container.exitCode}
                            </span>
                        </span>
                    )}
                    {hasError && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onRefresh();
                            }}
                            className="text-gray-400 hover:text-gray-600
                                       dark:text-zinc-500 dark:hover:text-zinc-300
                                       underline ml-auto"
                        >
                            Status aktualisieren
                        </button>
                    )}
                </div>
            )}

            {/* Resource stats for running containers */}
            {(session.status === "running" || session.status === "idle") && stats && !collapsed && (
                <div className="px-4 py-1.5 border-t border-gray-100 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900/50 text-xs text-gray-500 dark:text-zinc-500 flex gap-4">
                    <span>CPU: {stats.cpu_percent}%</span>
                    <span>RAM: {stats.memory_mb.toFixed(1)} / {stats.memory_limit_mb.toFixed(1)} MB</span>
                </div>
            )}

            {/* Error hint when no container info and no output */}
            {hasError && !container && session.lines.length === 0 && (
                <div className="px-4 py-2 border-t border-gray-100 bg-gray-50
                                dark:border-zinc-800 dark:bg-zinc-900/50
                                flex items-center gap-2 text-xs">
                    <span className="text-red-500 dark:text-red-400">
                        Keine Verbindung zum Container.
                    </span>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onRefresh();
                        }}
                        className="text-gray-400 hover:text-gray-600
                                   dark:text-zinc-500 dark:hover:text-zinc-300 underline"
                    >
                        Status abrufen
                    </button>
                </div>
            )}

            {/* Tab bar for completed/error runs */}
            {isStopped && session.status !== "stopped" && (
                <div className="flex border-t border-gray-200 dark:border-zinc-800">
                    {(["output", "files"] as const).map(tab => (
                        <button
                            key={tab}
                            onClick={(e) => { e.stopPropagation(); setActiveTab(tab); setCollapsed(false); }}
                            className={`flex-1 text-xs py-1.5 ${
                                activeTab === tab
                                    ? "bg-gray-100 dark:bg-zinc-800 text-gray-900 dark:text-zinc-100 font-medium"
                                    : "text-gray-500 dark:text-zinc-500 hover:bg-gray-50 dark:hover:bg-zinc-800/50"
                            }`}
                        >
                            {tab === "output" ? "Output" : "Dateien"}
                        </button>
                    ))}
                </div>
            )}

            {/* Content area */}
            {!collapsed && (
                <>
                    {activeTab === "output" && (
                        <div
                            ref={termRef}
                            onScroll={handleScroll}
                            className="bg-white dark:bg-black font-mono text-xs leading-5 p-3
                                       max-h-[400px] overflow-y-auto
                                       border-t border-gray-200 dark:border-zinc-800"
                        >
                            {allLines.length === 0 && isActive && (
                                <span className="text-gray-400 dark:text-zinc-600">
                                    {session.status === "queued" ? "In der Warteschlange..." : "Warte auf Output..."}
                                </span>
                            )}
                            {allLines.length === 0 && !isActive && (
                                <span className="text-gray-400 dark:text-zinc-600">
                                    Kein Output empfangen.
                                </span>
                            )}
                            {allLines.map((line, i) => (
                                <div
                                    key={i}
                                    className={`whitespace-pre-wrap break-words ${LINE_STYLES[line.style]}`}
                                >
                                    {line.text}
                                </div>
                            ))}
                        </div>
                    )}
                    {activeTab === "files" && <WorkspaceExplorer runId={session.id} />}
                </>
            )}

            {/* Follow-up prompt input for idle sessions */}
            {session.status === "idle" && onSendPrompt && !collapsed && (
                <div className="px-4 py-2 border-t border-gray-200 dark:border-zinc-800">
                    <div className="flex gap-2">
                        <textarea
                            value={followUpPrompt}
                            onChange={(e) => setFollowUpPrompt(e.target.value)}
                            onKeyDown={(e) => {
                                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                                    e.preventDefault();
                                    if (followUpPrompt.trim()) {
                                        onSendPrompt(session.id, followUpPrompt.trim());
                                        setFollowUpPrompt("");
                                    }
                                }
                            }}
                            rows={2}
                            placeholder="Follow-up Prompt... (Ctrl+Enter)"
                            className="flex-1 bg-gray-100 border border-gray-300
                                       dark:bg-zinc-800 dark:border-zinc-600
                                       rounded px-3 py-2 text-xs resize-y
                                       font-mono"
                        />
                        <button
                            onClick={() => {
                                if (followUpPrompt.trim()) {
                                    onSendPrompt(session.id, followUpPrompt.trim());
                                    setFollowUpPrompt("");
                                }
                            }}
                            disabled={!followUpPrompt.trim()}
                            className="bg-blue-600 hover:bg-blue-500 text-white
                                       disabled:opacity-40
                                       text-xs px-3 py-1 rounded self-end"
                        >
                            Senden
                        </button>
                    </div>
                </div>
            )}

            {/* Footer: Stoppen only while a prompt is running */}
            {session.status === "running" && (
                <div className="px-4 py-2 border-t border-gray-200 dark:border-zinc-800 flex justify-end">
                    <button
                        onClick={onStop}
                        className="bg-red-600/80 hover:bg-red-500 text-white text-xs px-3 py-1 rounded"
                    >
                        Stoppen
                    </button>
                </div>
            )}

            {/* Container beenden when idle */}
            {session.status === "idle" && (
                <div className="px-4 py-2 border-t border-gray-200 dark:border-zinc-800 flex justify-end">
                    <button
                        onClick={onStop}
                        className="bg-gray-500 hover:bg-gray-400 dark:bg-zinc-600 dark:hover:bg-zinc-500 text-white text-xs px-3 py-1 rounded"
                    >
                        Container beenden
                    </button>
                </div>
            )}

            {/* Chaining button for completed runs */}
            {isCompleted && onChain && (
                <div className="px-4 py-2 border-t border-gray-200 dark:border-zinc-800 flex justify-end">
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onChain(session.projectId, session.projectName);
                        }}
                        className="bg-blue-600 hover:bg-blue-500 text-white text-xs px-3 py-1 rounded"
                    >
                        Nächster Schritt
                    </button>
                </div>
            )}
        </div>
    );
}
