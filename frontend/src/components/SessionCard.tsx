"use client";
import { useEffect, useRef, useState } from "react";
import { Session } from "@/lib/types";
import { parseLogLines, TerminalLine } from "@/lib/logParser";

const STATUS_DOT: Record<Session["status"], string> = {
    running: "bg-emerald-500 animate-pulse",
    completed: "bg-emerald-500",
    error: "bg-red-500",
    stopped: "bg-yellow-500",
};

const STATUS_LABEL: Record<Session["status"], string> = {
    running: "Läuft",
    completed: "Fertig",
    error: "Fehler",
    stopped: "Gestoppt",
};

const LINE_STYLES: Record<TerminalLine["style"], string> = {
    text: "text-zinc-200",
    tool: "text-cyan-400",
    "tool-result": "text-zinc-500 text-[11px]",
    system: "text-yellow-500 italic",
    result: "text-emerald-400",
    error: "text-red-400",
    dim: "text-zinc-600",
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
}

export default function SessionCard({ session, onStop, onRemove, onRefresh }: Props) {
    const isActive = session.status === "running";
    const [collapsed, setCollapsed] = useState(!isActive);
    const termRef = useRef<HTMLDivElement>(null);
    const userScrolledUp = useRef(false);

    // Auto-expand when session starts running
    useEffect(() => {
        if (isActive) setCollapsed(false);
    }, [isActive]);

    // Auto-collapse when session finishes
    useEffect(() => {
        if (!isActive && session.lines.length > 0) setCollapsed(true);
    }, [isActive, session.lines.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const isStopped = session.status !== "running";

    return (
        <div className="bg-zinc-900 border border-zinc-700 rounded-lg overflow-hidden">
            {/* Header */}
            <div
                className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-zinc-800/50"
                onClick={() => setCollapsed(!collapsed)}
            >
                <span
                    className={`w-2.5 h-2.5 rounded-full shrink-0 ${STATUS_DOT[session.status]}`}
                />
                <span className="font-medium text-sm truncate">
                    {session.projectName}
                </span>
                {session.model && (
                    <span className="text-zinc-500 text-[10px] bg-zinc-800 px-1.5 py-0.5 rounded shrink-0">
                        {session.model.replace(/^claude-/, "").replace(/-\d{8}$/, "")}
                    </span>
                )}
                <span className="text-zinc-500 text-xs truncate flex-1">
                    {promptPreview}
                </span>

                {/* Timer */}
                <span className="text-zinc-500 text-xs shrink-0">
                    <ElapsedTimer
                        startedAt={session.startedAt}
                        stoppedAt={isStopped ? session.finishedAt ?? undefined : undefined}
                    />
                </span>

                <span className="text-zinc-600 text-xs shrink-0">
                    {STATUS_LABEL[session.status]}
                </span>
                {!isActive && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onRemove();
                        }}
                        className="text-zinc-600 hover:text-zinc-300 text-sm px-1"
                        title="Entfernen"
                    >
                        X
                    </button>
                )}
            </div>

            {/* Container Status */}
            {container && (
                <div className="px-4 py-2 border-t border-zinc-800 bg-zinc-900/50 flex items-center gap-4 text-xs">
                    <span className="text-zinc-500">
                        Container:{" "}
                        <span className="font-mono text-zinc-400">
                            {container.containerId}
                        </span>
                    </span>
                    <span className="text-zinc-500">
                        Status:{" "}
                        <span
                            className={
                                container.containerStatus === "running"
                                    ? "text-emerald-400"
                                    : container.containerStatus === "exited"
                                      ? "text-red-400"
                                      : "text-yellow-400"
                            }
                        >
                            {container.containerStatus}
                        </span>
                    </span>
                    {container.exitCode !== null && (
                        <span className="text-zinc-500">
                            Exit Code:{" "}
                            <span
                                className={
                                    container.exitCode === 0
                                        ? "text-emerald-400"
                                        : "text-red-400"
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
                            className="text-zinc-500 hover:text-zinc-300 underline ml-auto"
                        >
                            Status aktualisieren
                        </button>
                    )}
                </div>
            )}

            {/* Error hint when no container info and no output */}
            {hasError && !container && session.lines.length === 0 && (
                <div className="px-4 py-2 border-t border-zinc-800 bg-zinc-900/50 flex items-center gap-2 text-xs">
                    <span className="text-red-400">
                        Keine Verbindung zum Container.
                    </span>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onRefresh();
                        }}
                        className="text-zinc-500 hover:text-zinc-300 underline"
                    >
                        Status abrufen
                    </button>
                </div>
            )}

            {/* Terminal */}
            {!collapsed && (
                <div
                    ref={termRef}
                    onScroll={handleScroll}
                    className="bg-black font-mono text-xs leading-5 p-3 max-h-[400px] overflow-y-auto border-t border-zinc-800"
                >
                    {allLines.length === 0 && isActive && (
                        <span className="text-zinc-600">
                            Warte auf Output...
                        </span>
                    )}
                    {allLines.length === 0 && !isActive && (
                        <span className="text-zinc-600">
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

            {/* Footer */}
            {isActive && (
                <div className="px-4 py-2 border-t border-zinc-800 flex justify-end">
                    <button
                        onClick={onStop}
                        className="bg-red-600/80 hover:bg-red-500 text-xs px-3 py-1 rounded"
                    >
                        Stoppen
                    </button>
                </div>
            )}
        </div>
    );
}
