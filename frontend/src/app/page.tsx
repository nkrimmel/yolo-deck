"use client";
import { useEffect, useState } from "react";
import {
    fetchProjects,
    addProject,
    removeProject,
    browseDirectory,
    Project,
    DirEntry,
} from "@/lib/api";
import { useSessionManager } from "@/lib/useSessionManager";
import SessionCard from "@/components/SessionCard";

export default function Dashboard() {
    const [projects, setProjects] = useState<Project[]>([]);
    const [selectedProject, setSelectedProject] = useState<string>("");
    const [prompt, setPrompt] = useState("");
    const [model, setModel] = useState("claude-sonnet-4-20250514");
    const {
        sessions,
        activeCount,
        startSession,
        stopSession,
        removeSession,
        clearCompleted,
        refreshStatus,
    } = useSessionManager();

    // Directory browser state
    const [showBrowser, setShowBrowser] = useState(false);
    const [browsePath, setBrowsePath] = useState("~");
    const [dirEntries, setDirEntries] = useState<DirEntry[]>([]);
    const [addError, setAddError] = useState<string | null>(null);
    const [manualPath, setManualPath] = useState("");

    const loadProjects = () => fetchProjects().then(setProjects);

    useEffect(() => {
        loadProjects();
    }, []);

    useEffect(() => {
        if (showBrowser) {
            browseDirectory(browsePath).then(setDirEntries);
        }
    }, [browsePath, showBrowser]);

    const handleAddProject = async (path: string) => {
        setAddError(null);
        try {
            const project = await addProject(path);
            await loadProjects();
            setSelectedProject(project.id);
            setShowBrowser(false);
            setManualPath("");
        } catch (e: unknown) {
            setAddError(e instanceof Error ? e.message : "Fehler");
        }
    };

    const handleRemoveProject = async (id: string) => {
        await removeProject(id);
        if (selectedProject === id) setSelectedProject("");
        await loadProjects();
    };

    const navigateUp = () => {
        const parts = browsePath.split("/").filter(Boolean);
        parts.pop();
        setBrowsePath("/" + parts.join("/") || "/");
    };

    const handleRun = async () => {
        if (!selectedProject || !prompt.trim()) return;
        const project = projects.find((p) => p.id === selectedProject);
        if (!project) return;
        await startSession(selectedProject, project.name, prompt, model);
    };

    return (
        <main className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
            <h1 className="text-2xl font-bold mb-6">YOLO Deck</h1>

            {/* Projekt-Auswahl */}
            <div className="mb-4">
                <label className="block text-sm text-zinc-400 mb-1">
                    Projekt
                </label>
                <div className="flex gap-2">
                    <select
                        value={selectedProject}
                        onChange={(e) => setSelectedProject(e.target.value)}
                        className="flex-1 bg-zinc-900 border border-zinc-700
                                   rounded px-3 py-2"
                    >
                        <option value="">— Projekt wählen —</option>
                        {projects.map((p) => (
                            <option key={p.id} value={p.id}>
                                {p.name}
                                {p.current_branch
                                    ? ` (${p.current_branch})`
                                    : ""}
                            </option>
                        ))}
                    </select>
                    <button
                        onClick={() => {
                            setShowBrowser(!showBrowser);
                            setAddError(null);
                        }}
                        className="bg-zinc-800 hover:bg-zinc-700 border border-zinc-700
                                   px-3 py-2 rounded text-sm"
                    >
                        + Hinzufügen
                    </button>
                    {selectedProject && (
                        <button
                            onClick={() => handleRemoveProject(selectedProject)}
                            className="bg-zinc-800 hover:bg-red-900 border border-zinc-700
                                       px-3 py-2 rounded text-sm text-zinc-400
                                       hover:text-red-400"
                            title="Projekt entfernen"
                        >
                            Entfernen
                        </button>
                    )}
                </div>
                {selectedProject && (
                    <div className="text-xs text-zinc-500 mt-1">
                        {projects.find((p) => p.id === selectedProject)?.path}
                    </div>
                )}
            </div>

            {/* Directory Browser */}
            {showBrowser && (
                <div className="mb-4 bg-zinc-900 border border-zinc-700 rounded p-4">
                    {/* Pfad direkt eingeben */}
                    <div className="flex gap-2 mb-3">
                        <input
                            type="text"
                            value={manualPath}
                            onChange={(e) => setManualPath(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && manualPath.trim()) {
                                    handleAddProject(manualPath.trim());
                                }
                            }}
                            placeholder="Pfad direkt eingeben, z.B. /home/user/mein-projekt"
                            className="flex-1 bg-zinc-800 border border-zinc-600
                                       rounded px-3 py-2 text-sm font-mono"
                        />
                        <button
                            onClick={() => {
                                if (manualPath.trim())
                                    handleAddProject(manualPath.trim());
                            }}
                            className="bg-emerald-600 hover:bg-emerald-500
                                       px-3 py-2 rounded text-sm"
                        >
                            Hinzufügen
                        </button>
                    </div>

                    <div className="text-xs text-zinc-500 mb-2">
                        Oder Verzeichnis durchsuchen:
                    </div>

                    <div className="flex items-center gap-2 mb-3">
                        <button
                            onClick={navigateUp}
                            className="bg-zinc-800 hover:bg-zinc-700 px-2 py-1
                                       rounded text-sm"
                        >
                            ..
                        </button>
                        <input
                            type="text"
                            value={browsePath}
                            onChange={(e) => setBrowsePath(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    browseDirectory(browsePath).then(
                                        setDirEntries
                                    );
                                }
                            }}
                            className="flex-1 bg-zinc-800 border border-zinc-600
                                       rounded px-3 py-1 text-sm font-mono"
                        />
                        <button
                            onClick={() => setShowBrowser(false)}
                            className="text-zinc-500 hover:text-zinc-300 px-2"
                        >
                            X
                        </button>
                    </div>
                    {addError && (
                        <div className="text-red-400 text-sm mb-2">
                            {addError}
                        </div>
                    )}
                    <div className="max-h-64 overflow-y-auto space-y-0.5">
                        {dirEntries.map((entry) => (
                            <div
                                key={entry.path}
                                className="flex items-center gap-2 px-2 py-1
                                           hover:bg-zinc-800 rounded text-sm"
                            >
                                <span className="text-zinc-500 w-5 text-center">
                                    {entry.is_git
                                        ? "G"
                                        : entry.is_dir
                                          ? "/"
                                          : " "}
                                </span>
                                {entry.is_dir ? (
                                    <button
                                        onClick={() =>
                                            setBrowsePath(entry.path)
                                        }
                                        className="flex-1 text-left text-zinc-200
                                                   hover:text-white"
                                    >
                                        {entry.name}
                                    </button>
                                ) : (
                                    <span className="flex-1 text-zinc-500">
                                        {entry.name}
                                    </span>
                                )}
                                {entry.is_dir && (
                                    <button
                                        onClick={() =>
                                            handleAddProject(entry.path)
                                        }
                                        className="text-emerald-500 hover:text-emerald-400
                                                   text-xs px-2 py-0.5 border
                                                   border-emerald-800 rounded"
                                    >
                                        Auswählen
                                    </button>
                                )}
                            </div>
                        ))}
                        {dirEntries.length === 0 && (
                            <div className="text-zinc-600 text-sm px-2">
                                Verzeichnis leer oder nicht zugreifbar
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Prompt-Eingabe */}
            <div className="mb-4">
                <label className="block text-sm text-zinc-400 mb-1">
                    Prompt
                </label>
                <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={4}
                    placeholder="Was soll Claude tun?"
                    className="w-full bg-zinc-900 border border-zinc-700
                               rounded px-3 py-2 resize-y"
                />
            </div>

            {/* Model */}
            <div className="mb-4">
                <label className="block text-sm text-zinc-400 mb-1">
                    Model
                </label>
                <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-700
                               rounded px-3 py-2 text-sm"
                >
                    <optgroup label="Claude 4">
                        <option value="claude-opus-4-20250514">Opus 4</option>
                        <option value="claude-sonnet-4-20250514">Sonnet 4</option>
                    </optgroup>
                    <optgroup label="Claude 3.5">
                        <option value="claude-3-5-sonnet-20241022">Sonnet 3.5</option>
                        <option value="claude-3-5-haiku-20241022">Haiku 3.5</option>
                    </optgroup>
                </select>
            </div>

            {/* Aktions-Button */}
            <div className="flex gap-3 mb-6">
                <button
                    onClick={handleRun}
                    disabled={!selectedProject || !prompt.trim()}
                    className="bg-emerald-600 hover:bg-emerald-500
                               disabled:opacity-40 px-4 py-2 rounded
                               font-medium"
                >
                    Ausführen
                </button>
            </div>

            {/* Session-Liste */}
            {sessions.length > 0 && (
                <div className="mb-4 flex items-center gap-3">
                    <span className="text-sm text-zinc-400">
                        {activeCount} aktiv / {sessions.length} gesamt
                    </span>
                    {sessions.length > activeCount && (
                        <button
                            onClick={clearCompleted}
                            className="text-xs text-zinc-500 hover:text-zinc-300 underline"
                        >
                            Abgeschlossene entfernen
                        </button>
                    )}
                </div>
            )}

            <div className="space-y-3">
                {sessions.length === 0 && (
                    <div className="bg-black border border-zinc-800 rounded font-mono text-sm p-4 text-zinc-600">
                        Wähle ein Projekt und starte einen Run...
                    </div>
                )}
                {sessions.map((session) => (
                    <SessionCard
                        key={session.id}
                        session={session}
                        onStop={() => stopSession(session.id)}
                        onRemove={() => removeSession(session.id)}
                        onRefresh={() => refreshStatus(session.id)}
                    />
                ))}
            </div>
        </main>
    );
}
