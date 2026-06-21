"use client";
import { useState } from "react";

interface Props {
  onLogin: (token: string) => void;
}

export default function LoginScreen({ onLogin }: Props) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api/projects`,
        { headers: { Authorization: `Bearer ${token.trim()}` } }
      );
      if (res.ok) {
        localStorage.setItem("yolo_auth_token", token.trim());
        onLogin(token.trim());
      } else {
        setError("Ungültiger Token");
      }
    } catch {
      setError("Verbindung fehlgeschlagen");
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-zinc-950 flex items-center justify-center">
      <form onSubmit={handleSubmit} className="bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 rounded-lg p-8 w-full max-w-sm">
        <h1 className="text-xl font-bold text-gray-900 dark:text-zinc-100 mb-6 text-center">YOLO Deck</h1>
        <label className="block text-sm text-gray-500 dark:text-zinc-400 mb-1">API Token</label>
        <input
          type="password"
          value={token}
          onChange={(e) => { setToken(e.target.value); setError(""); }}
          placeholder="Token eingeben..."
          autoFocus
          className="w-full bg-gray-100 dark:bg-zinc-800 border border-gray-300 dark:border-zinc-600 rounded px-3 py-2 mb-4"
        />
        {error && <div className="text-red-500 text-sm mb-3">{error}</div>}
        <button
          type="submit"
          disabled={!token.trim()}
          className="w-full bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 py-2 rounded font-medium"
        >
          Anmelden
        </button>
      </form>
    </div>
  );
}
