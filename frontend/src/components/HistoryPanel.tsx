"use client";
import { useState, useEffect } from "react";
import { fetchHistory, deleteHistory } from "@/lib/api";
import { HistoryEntry } from "@/lib/types";

export default function HistoryPanel() {
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [loading, setLoading] = useState(true);

    const load = async () => {
        setLoading(true);
        const data = await fetchHistory();
        setHistory(data);
        setLoading(false);
    };

    useEffect(() => {
        load();
    }, []);

    const handleClear = async () => {
        await deleteHistory();
        setHistory([]);
    };

    const formatCost = (cost?: number) =>
        cost != null ? `$${cost.toFixed(4)}` : "–";

    const formatDuration = (ms?: number) => {
        if (ms == null) return "–";
        const s = Math.round(ms / 1000);
        return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
    };

    const formatDate = (iso?: string) => {
        if (!iso) return "–";
        const d = new Date(iso);
        return d.toLocaleDateString("de-DE", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        });
    };

    const statusColor = (status?: string) => {
        switch (status) {
            case "completed":
                return "text-emerald-500";
            case "failed":
                return "text-red-500";
            default:
                return "text-zinc-400";
        }
    };

    if (loading)
        return (
            <div className="text-center text-zinc-500 py-8">Laden...</div>
        );

    return (
        <div className="space-y-3">
            <div className="flex justify-between items-center">
                <h3 className="text-sm font-medium text-gray-500 dark:text-zinc-400">
                    {history.length} Runs in Historie
                </h3>
                {history.length > 0 && (
                    <button
                        onClick={handleClear}
                        className="text-xs text-red-400 hover:text-red-300"
                    >
                        Historie löschen
                    </button>
                )}
            </div>
            {history.length === 0 ? (
                <div className="text-center text-zinc-600 py-8">
                    Keine Historie vorhanden
                </div>
            ) : (
                <div className="space-y-2">
                    {history.map((run) => (
                        <div
                            key={run.id}
                            className="bg-gray-100 dark:bg-zinc-900/50 rounded-lg p-3
                                       border border-gray-200 dark:border-zinc-800/50"
                        >
                            <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0 flex-1">
                                    <span
                                        className={`text-xs font-mono ${statusColor(run.status)}`}
                                    >
                                        {run.status === "completed"
                                            ? "✓"
                                            : run.status === "failed"
                                              ? "✗"
                                              : "●"}
                                    </span>
                                    <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">
                                        {run.project_name || run.project_id}
                                    </span>
                                    <span className="text-xs text-zinc-500 truncate max-w-[200px]">
                                        {run.prompt?.slice(0, 60)}
                                        {(run.prompt?.length || 0) > 60
                                            ? "…"
                                            : ""}
                                    </span>
                                </div>
                                <div className="flex items-center gap-3 text-xs text-zinc-500 shrink-0">
                                    {run.model && (
                                        <span>
                                            {run.model.split("-").slice(-1)[0]}
                                        </span>
                                    )}
                                    <span>{formatCost(run.cost_usd)}</span>
                                    <span>
                                        {formatDuration(run.duration_ms)}
                                    </span>
                                    {run.num_turns && (
                                        <span>{run.num_turns}T</span>
                                    )}
                                    <span>{formatDate(run.started_at)}</span>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
