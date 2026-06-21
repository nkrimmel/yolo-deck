"use client";
import { useState, useEffect } from "react";
import { fetchRunFiles, fetchRunFile } from "@/lib/api";

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface Props {
  runId: string;
}

export default function WorkspaceExplorer({ runId }: Props) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(true);

  const loadDir = async (path: string) => {
    setLoading(true);
    setFileContent(null);
    const data = await fetchRunFiles(runId, path);
    setEntries(data);
    setCurrentPath(path);
    setLoading(false);
  };

  useEffect(() => { loadDir(""); }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const openFile = async (path: string, name: string) => {
    setLoading(true);
    const data = await fetchRunFile(runId, path);
    setFileContent(data.content);
    setFileName(name);
    setLoading(false);
  };

  const navigateUp = () => {
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    loadDir(parts.join("/"));
  };

  if (loading && entries.length === 0 && !fileContent) {
    return <div className="text-zinc-500 text-xs p-3">Laden...</div>;
  }

  return (
    <div className="bg-gray-950 dark:bg-black font-mono text-xs border-t border-gray-200 dark:border-zinc-800 max-h-[400px] overflow-y-auto">
      {/* Breadcrumb */}
      <div className="sticky top-0 bg-zinc-900 border-b border-zinc-800 px-3 py-1.5 flex items-center gap-2">
        <button onClick={() => loadDir("")} className="text-blue-400 hover:text-blue-300">
          /
        </button>
        {currentPath && (
          <>
            <span className="text-zinc-600">/</span>
            <span className="text-zinc-300">{currentPath}</span>
            <button onClick={navigateUp} className="text-zinc-500 hover:text-zinc-300 ml-auto">
              ..
            </button>
          </>
        )}
        {fileContent !== null && (
          <button onClick={() => { setFileContent(null); loadDir(currentPath); }} className="text-zinc-500 hover:text-zinc-300 ml-auto">
            X Schließen
          </button>
        )}
      </div>

      {/* File content view */}
      {fileContent !== null ? (
        <div className="p-3">
          <div className="text-blue-300 mb-2 font-medium">{fileName}</div>
          <pre className="text-zinc-300 whitespace-pre-wrap break-words leading-5">{fileContent}</pre>
        </div>
      ) : (
        /* Directory listing */
        <div className="divide-y divide-zinc-900">
          {entries.map((entry) => (
            <div
              key={entry.path}
              onClick={() => entry.is_dir ? loadDir(entry.path) : openFile(entry.path, entry.name)}
              className="px-3 py-1.5 hover:bg-zinc-800/50 cursor-pointer flex items-center gap-2"
            >
              <span className="text-zinc-500 w-4 text-center">{entry.is_dir ? "/" : " "}</span>
              <span className={entry.is_dir ? "text-blue-300" : "text-zinc-300"}>{entry.name}</span>
            </div>
          ))}
          {entries.length === 0 && (
            <div className="px-3 py-3 text-zinc-600">Verzeichnis leer</div>
          )}
        </div>
      )}
    </div>
  );
}
