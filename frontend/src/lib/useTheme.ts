"use client";
import { useCallback, useEffect, useState } from "react";

export function useTheme() {
    const [theme, setTheme] = useState<"light" | "dark">("dark");
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setTheme(
            document.documentElement.classList.contains("dark")
                ? "dark"
                : "light"
        );
        setMounted(true);
    }, []);

    const toggle = useCallback(() => {
        setTheme((prev) => {
            const next = prev === "dark" ? "light" : "dark";
            document.documentElement.classList.toggle("dark", next === "dark");
            localStorage.setItem("theme", next);
            return next;
        });
    }, []);

    return { theme, toggle, mounted };
}
