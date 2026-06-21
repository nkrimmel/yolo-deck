"use client";
import { useEffect, useRef, useState } from "react";
import {
    fetchProjects,
    addProject,
    removeProject,
    browseDirectory,
    createDirectory,
    fetchOllamaStatus,
    fetchOllamaModels,
    fetchTemplates,
    saveTemplate,
    deleteTemplate,
    Project,
    DirEntry,
    OllamaModel,
} from "@/lib/api";
import { PromptTemplate } from "@/lib/types";
import { useSessionManager } from "@/lib/useSessionManager";
import SessionCard from "@/components/SessionCard";
import ThemeToggle from "@/components/ThemeToggle";
import HistoryPanel from "@/components/HistoryPanel";
import LoginScreen from "@/components/LoginScreen";

export default function Dashboard() {
    const [projects, setProjects] = useState<Project[]>([]);
    const [selectedProject, setSelectedProject] = useState<string>("");
    const [prompt, setPrompt] = useState("");
    const [model, setModel] = useState("claude-sonnet-4-20250514");
    const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
    const [ollamaAvailable, setOllamaAvailable] = useState(false);
    const [provider, setProvider] = useState<"anthropic" | "ollama">("anthropic");
    const [customOllamaModel, setCustomOllamaModel] = useState("");
    const [needsAuth, setNeedsAuth] = useState(false);
    const [templates, setTemplates] = useState<PromptTemplate[]>([]);
    const [showSaveTemplate, setShowSaveTemplate] = useState(false);
    const [templateName, setTemplateName] = useState("");
    const promptRef = useRef<HTMLTextAreaElement>(null);
    const {
        sessions,
        activeCount,
        startSession,
        stopSession,
        removeSession,
        clearCompleted,
        refreshStatus,
        sendSessionPrompt,
    } = useSessionManager();

    const [view, setView] = useState<"active" | "history">("active");

    // Directory browser state
    const [showBrowser, setShowBrowser] = useState(false);
    const [browsePath, setBrowsePath] = useState("~");
    const [dirEntries, setDirEntries] = useState<DirEntry[]>([]);
    const [addError, setAddError] = useState<string | null>(null);
    const [manualPath, setManualPath] = useState("");
    const [newFolderName, setNewFolderName] = useState("");
    const [showNewFolder, setShowNewFolder] = useState(false);

    const loadProjects = () =>
        fetchProjects()
            .then((data) => { setProjects(data); setNeedsAuth(false); })
            .catch((e: Error) => { if (e?.message === "401") setNeedsAuth(true); });

    useEffect(() => {
        loadProjects();
        fetchTemplates().then(setTemplates).catch(() => {});
        fetchOllamaStatus().then(s => {
            setOllamaAvailable(s.available);
            if (s.available) {
                fetchOllamaModels().then(setOllamaModels);
            }
        });
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    function formatSize(bytes: number): string {
        const gb = bytes / 1e9;
        return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
    }

    const handleModelChange = (value: string) => {
        if (value.startsWith("ollama:")) {
            setProvider("ollama");
            setModel(value.slice(7));
            setCustomOllamaModel("");
        } else {
            setProvider("anthropic");
            setModel(value);
            setCustomOllamaModel("");
        }
    };

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

    const handleCreateFolder = async () => {
        if (!newFolderName.trim()) return;
        setAddError(null);
        const fullPath = `${browsePath}/${newFolderName.trim()}`;
        try {
            const result = await createDirectory(fullPath);
            setNewFolderName("");
            setShowNewFolder(false);
            setBrowsePath(result.path);
        } catch (e: unknown) {
            setAddError(e instanceof Error ? e.message : "Fehler");
        }
    };

    // Keyboard shortcut: Ctrl+Enter to run (only when main prompt textarea is focused)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                if (document.activeElement === promptRef.current) {
                    e.preventDefault();
                    handleRun();
                }
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [selectedProject, prompt, model, provider]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleRun = async () => {
        if (!selectedProject || !prompt.trim()) return;
        const project = projects.find((p) => p.id === selectedProject);
        if (!project) return;
        const effectiveModel = provider === "ollama" && customOllamaModel ? customOllamaModel : model;
        await startSession(selectedProject, project.name, prompt, effectiveModel, provider);
    };

    const handleChain = (projectId: string, projectName: string) => {
        setSelectedProject(projectId);
        setPrompt("");
        promptRef.current?.focus();
        setView("active");
    };

    const handleLogout = () => {
        localStorage.removeItem("yolo_auth_token");
        setNeedsAuth(true);
    };

    // Show login if auth required
    if (needsAuth) {
        return <LoginScreen onLogin={() => { setNeedsAuth(false); loadProjects(); }} />;
    }

    const queuedCount = sessions.filter(s => s.status === "queued").length;
    const completedCount = sessions.filter(s => s.status === "completed").length;
    const errorCount = sessions.filter(s => s.status === "error").length;
    const totalCost = sessions.reduce((sum, s) => sum + (s.metadata?.cost || 0), 0);
    const totalTurns = sessions.reduce((sum, s) => sum + (s.metadata?.turns || 0), 0);

    return (
        <main className="min-h-screen bg-gray-50 text-gray-900 dark:bg-zinc-950 dark:text-zinc-100 p-8">
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-4">
                    <h1 className="text-2xl font-bold">YOLO Deck</h1>
                    {sessions.length > 0 && (
                        <div className="flex items-center gap-3 text-xs font-mono
                                        px-3 py-1.5 rounded-lg
                                        bg-gray-100 border border-gray-200
                                        dark:bg-zinc-900/60 dark:border-zinc-800">
                            <div className="flex items-center gap-1">
                                <span className={`w-1.5 h-1.5 rounded-full ${activeCount > 0 ? "bg-emerald-500 animate-pulse" : "bg-gray-300 dark:bg-zinc-600"}`} />
                                <span className="text-gray-700 dark:text-zinc-300">{activeCount}</span>
                            </div>
                            {queuedCount > 0 && (
                                <div className="flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
                                    <span className="text-gray-700 dark:text-zinc-300">{queuedCount}</span>
                                </div>
                            )}
                            {completedCount > 0 && (
                                <span className="text-emerald-600 dark:text-emerald-400">{completedCount} ok</span>
                            )}
                            {errorCount > 0 && (
                                <span className="text-red-500 dark:text-red-400">{errorCount} err</span>
                            )}
                            <span className="text-gray-300 dark:text-zinc-700">|</span>
                            {totalTurns > 0 && (
                                <span className="text-gray-600 dark:text-zinc-400">{totalTurns}T</span>
                            )}
                            {totalCost > 0 && (
                                <span className="text-emerald-600 dark:text-emerald-400">${totalCost.toFixed(4)}</span>
                            )}
                            {sessions.length > activeCount && (
                                <button
                                    onClick={clearCompleted}
                                    className="text-gray-400 hover:text-gray-600
                                               dark:text-zinc-600 dark:hover:text-zinc-300 underline ml-1"
                                >
                                    aufräumen
                                </button>
                            )}
                        </div>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={handleLogout}
                        className="text-xs text-gray-400 hover:text-gray-600 dark:text-zinc-500 dark:hover:text-zinc-300"
                    >
                        Abmelden
                    </button>
                    <ThemeToggle />
                </div>
            </div>

            {/* Projekt-Auswahl */}
            <div className="mb-4">
                <label className="block text-sm text-gray-500 dark:text-zinc-400 mb-1">
                    Projekt
                </label>
                <div className="flex gap-2">
                    <select
                        value={selectedProject}
                        onChange={(e) => setSelectedProject(e.target.value)}
                        className="flex-1 bg-white border border-gray-300
                                   dark:bg-zinc-900 dark:border-zinc-700
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
                        className="bg-gray-100 hover:bg-gray-200 border border-gray-300
                                   dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:border-zinc-700
                                   px-3 py-2 rounded text-sm"
                    >
                        + Hinzufügen
                    </button>
                    {selectedProject && (
                        <button
                            onClick={() => handleRemoveProject(selectedProject)}
                            className="bg-gray-100 hover:bg-red-50 border border-gray-300
                                       text-gray-500 hover:text-red-500
                                       dark:bg-zinc-800 dark:hover:bg-red-900 dark:border-zinc-700
                                       dark:text-zinc-400 dark:hover:text-red-400
                                       px-3 py-2 rounded text-sm"
                            title="Projekt entfernen"
                        >
                            Entfernen
                        </button>
                    )}
                </div>
                {selectedProject && (
                    <div className="text-xs text-gray-500 dark:text-zinc-500 mt-1">
                        {projects.find((p) => p.id === selectedProject)?.path}
                    </div>
                )}
            </div>

            {/* Directory Browser */}
            {showBrowser && (
                <div className="mb-4 bg-white border border-gray-200 dark:bg-zinc-900 dark:border-zinc-700 rounded p-4">
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
                            className="flex-1 bg-gray-100 border border-gray-300
                                       dark:bg-zinc-800 dark:border-zinc-600
                                       rounded px-3 py-2 text-sm font-mono"
                        />
                        <button
                            onClick={() => {
                                if (manualPath.trim())
                                    handleAddProject(manualPath.trim());
                            }}
                            className="bg-emerald-600 hover:bg-emerald-500
                                       text-white px-3 py-2 rounded text-sm"
                        >
                            Hinzufügen
                        </button>
                    </div>

                    <div className="text-xs text-gray-500 dark:text-zinc-500 mb-2">
                        Oder Verzeichnis durchsuchen:
                    </div>

                    <div className="flex items-center gap-2 mb-3">
                        <button
                            onClick={navigateUp}
                            className="bg-gray-100 hover:bg-gray-200
                                       dark:bg-zinc-800 dark:hover:bg-zinc-700
                                       px-2 py-1 rounded text-sm"
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
                            className="flex-1 bg-gray-100 border border-gray-300
                                       dark:bg-zinc-800 dark:border-zinc-600
                                       rounded px-3 py-1 text-sm font-mono"
                        />
                        <button
                            onClick={() => {
                                setShowNewFolder(!showNewFolder);
                                setNewFolderName("");
                            }}
                            className="bg-gray-100 hover:bg-gray-200 border border-gray-300
                                       dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:border-zinc-700
                                       px-2 py-1 rounded text-sm"
                            title="Neuer Ordner"
                        >
                            + Ordner
                        </button>
                        <button
                            onClick={() => setShowBrowser(false)}
                            className="text-gray-400 hover:text-gray-600
                                       dark:text-zinc-500 dark:hover:text-zinc-300 px-2"
                        >
                            X
                        </button>
                    </div>
                    {showNewFolder && (
                        <div className="flex gap-2 mb-3">
                            <input
                                type="text"
                                value={newFolderName}
                                onChange={(e) => setNewFolderName(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") handleCreateFolder();
                                    if (e.key === "Escape") {
                                        setShowNewFolder(false);
                                        setNewFolderName("");
                                    }
                                }}
                                placeholder="Ordnername"
                                autoFocus
                                className="flex-1 bg-gray-100 border border-gray-300
                                           dark:bg-zinc-800 dark:border-zinc-600
                                           rounded px-3 py-1 text-sm font-mono"
                            />
                            <button
                                onClick={handleCreateFolder}
                                disabled={!newFolderName.trim()}
                                className="bg-emerald-600 hover:bg-emerald-500
                                           text-white disabled:opacity-40
                                           px-3 py-1 rounded text-sm"
                            >
                                Erstellen
                            </button>
                            <button
                                onClick={() => {
                                    setShowNewFolder(false);
                                    setNewFolderName("");
                                }}
                                className="text-gray-400 hover:text-gray-600
                                           dark:text-zinc-500 dark:hover:text-zinc-300
                                           px-2 text-sm"
                            >
                                Abbrechen
                            </button>
                        </div>
                    )}
                    {addError && (
                        <div className="text-red-500 dark:text-red-400 text-sm mb-2">
                            {addError}
                        </div>
                    )}
                    <div className="max-h-64 overflow-y-auto space-y-0.5">
                        {dirEntries.map((entry) => (
                            <div
                                key={entry.path}
                                className="flex items-center gap-2 px-2 py-1
                                           hover:bg-gray-100 dark:hover:bg-zinc-800
                                           rounded text-sm"
                            >
                                <span className="text-gray-400 dark:text-zinc-500 w-5 text-center">
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
                                        className="flex-1 text-left text-gray-700 hover:text-gray-900
                                                   dark:text-zinc-200 dark:hover:text-white"
                                    >
                                        {entry.name}
                                    </button>
                                ) : (
                                    <span className="flex-1 text-gray-400 dark:text-zinc-500">
                                        {entry.name}
                                    </span>
                                )}
                                {entry.is_dir && (
                                    <button
                                        onClick={() =>
                                            handleAddProject(entry.path)
                                        }
                                        className="text-emerald-600 hover:text-emerald-500
                                                   dark:text-emerald-500 dark:hover:text-emerald-400
                                                   text-xs px-2 py-0.5 border
                                                   border-emerald-300 dark:border-emerald-800 rounded"
                                    >
                                        Auswählen
                                    </button>
                                )}
                            </div>
                        ))}
                        {dirEntries.length === 0 && (
                            <div className="text-gray-400 dark:text-zinc-600 text-sm px-2">
                                Verzeichnis leer oder nicht zugreifbar
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Template Selector */}
            {templates.length > 0 && (
                <div className="flex gap-2 mb-2">
                    <select
                        onChange={(e) => {
                            const t = templates.find(t => t.id === e.target.value);
                            if (t) {
                                setPrompt(t.prompt);
                                if (t.model) setModel(t.model);
                            }
                        }}
                        className="flex-1 bg-white dark:bg-zinc-900 border border-gray-300 dark:border-zinc-700 rounded px-3 py-1.5 text-sm"
                        defaultValue=""
                    >
                        <option value="">— Vorlage wählen —</option>
                        {templates.map(t => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                    </select>
                    <button
                        onClick={() => setShowSaveTemplate(!showSaveTemplate)}
                        className="text-xs text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300 px-2"
                    >
                        + Vorlage
                    </button>
                </div>
            )}

            {/* Save Template Form */}
            {showSaveTemplate && (
                <div className="flex gap-2 mb-2">
                    <input
                        type="text"
                        value={templateName}
                        onChange={(e) => setTemplateName(e.target.value)}
                        placeholder="Vorlagenname..."
                        className="flex-1 bg-gray-100 dark:bg-zinc-800 border border-gray-300 dark:border-zinc-600 rounded px-3 py-1.5 text-sm"
                    />
                    <button
                        onClick={async () => {
                            if (templateName.trim() && prompt.trim()) {
                                const t = await saveTemplate(templateName.trim(), prompt, model);
                                if (t) setTemplates(prev => [t, ...prev]);
                                setTemplateName("");
                                setShowSaveTemplate(false);
                            }
                        }}
                        disabled={!templateName.trim() || !prompt.trim()}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 px-3 py-1.5 rounded text-sm"
                    >
                        Speichern
                    </button>
                </div>
            )}

            {/* No templates yet — show save button inline */}
            {templates.length === 0 && prompt.trim() && (
                <div className="mb-2">
                    <button
                        onClick={() => setShowSaveTemplate(!showSaveTemplate)}
                        className="text-xs text-gray-500 dark:text-zinc-500 hover:text-gray-700 dark:hover:text-zinc-300"
                    >
                        + Als Vorlage speichern
                    </button>
                </div>
            )}

            {/* Prompt-Eingabe */}
            <div className="mb-4">
                <label className="block text-sm text-gray-500 dark:text-zinc-400 mb-1">
                    Prompt
                </label>
                <textarea
                    ref={promptRef}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={4}
                    placeholder="Was soll Claude tun?"
                    className="w-full bg-white border border-gray-300
                               dark:bg-zinc-900 dark:border-zinc-700
                               rounded px-3 py-2 resize-y"
                />
            </div>

            {/* Model */}
            <div className="mb-4">
                <div className="flex items-center gap-2 mb-1">
                    <label className="text-sm text-gray-500 dark:text-zinc-400">
                        Model
                    </label>
                    <span
                        title={ollamaAvailable ? "Ollama verfügbar" : "Ollama nicht erreichbar"}
                        className={`inline-block w-2 h-2 rounded-full ${
                            ollamaAvailable
                                ? "bg-emerald-500"
                                : "bg-gray-300 dark:bg-zinc-600"
                        }`}
                    />
                </div>
                <select
                    value={provider === "ollama" ? `ollama:${model}` : model}
                    onChange={(e) => handleModelChange(e.target.value)}
                    className="w-full bg-white border border-gray-300
                               dark:bg-zinc-900 dark:border-zinc-700
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
                    {ollamaAvailable && ollamaModels.length > 0 && (
                        <optgroup label="Ollama (Lokal)">
                            {ollamaModels.map((m) => (
                                <option key={m.name} value={`ollama:${m.name}`}>
                                    {m.name} ({formatSize(m.size)})
                                </option>
                            ))}
                        </optgroup>
                    )}
                </select>
                {provider === "ollama" && (
                    <input
                        type="text"
                        value={customOllamaModel}
                        onChange={(e) => {
                            setCustomOllamaModel(e.target.value);
                        }}
                        placeholder="Oder Ollama-Modellname eingeben..."
                        className="w-full mt-2 bg-white border border-gray-300
                                   dark:bg-zinc-900 dark:border-zinc-700
                                   rounded px-3 py-2 text-sm"
                    />
                )}
            </div>

            {/* Aktions-Button */}
            <div className="flex gap-3 mb-6">
                <button
                    onClick={handleRun}
                    disabled={!selectedProject || !prompt.trim()}
                    className="bg-emerald-600 hover:bg-emerald-500
                               text-white disabled:opacity-40 px-4 py-2 rounded
                               font-medium"
                >
                    Ausführen (Ctrl+Enter)
                </button>
            </div>

            {/* View Toggle */}
            <div className="flex gap-2 mb-4">
                <button
                    onClick={() => setView("active")}
                    className={`px-3 py-1.5 rounded text-sm ${
                        view === "active"
                            ? "bg-blue-600 text-white"
                            : "bg-gray-200 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
                    }`}
                >
                    Aktiv ({sessions.length})
                    {queuedCount > 0 && (
                        <span className="ml-1 text-yellow-300">+{queuedCount} Q</span>
                    )}
                </button>
                <button
                    onClick={() => setView("history")}
                    className={`px-3 py-1.5 rounded text-sm ${
                        view === "history"
                            ? "bg-blue-600 text-white"
                            : "bg-gray-200 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
                    }`}
                >
                    Historie
                </button>
            </div>

            {view === "active" ? (
                <>
                    <div className="space-y-3">
                        {sessions.length === 0 && (
                            <div className="bg-gray-100 border border-gray-200
                                            dark:bg-black dark:border-zinc-800
                                            rounded font-mono text-sm p-4
                                            text-gray-400 dark:text-zinc-600">
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
                                onChain={handleChain}
                                onSendPrompt={sendSessionPrompt}
                            />
                        ))}
                    </div>
                </>
            ) : (
                <HistoryPanel />
            )}
        </main>
    );
}
