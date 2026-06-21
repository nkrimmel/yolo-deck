"use client";
import { useTheme } from "@/lib/useTheme";

export default function ThemeToggle() {
    const { theme, toggle, mounted } = useTheme();

    return (
        <button
            onClick={toggle}
            className="bg-gray-200 dark:bg-zinc-800 hover:bg-gray-300 dark:hover:bg-zinc-700
                       rounded-lg p-2 text-gray-600 dark:text-zinc-400"
            title={theme === "dark" ? "Lichtmodus" : "Dunkelmodus"}
        >
            {mounted ? (
                theme === "dark" ? (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                    </svg>
                ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                    </svg>
                )
            ) : (
                <span className="block w-4 h-4" />
            )}
        </button>
    );
}
