// Polyfill: Node.js 22+ exposes a broken `localStorage` global when
// `--localstorage-file` is missing or invalid.  Next.js SSR code (and
// React internals) call `localStorage.getItem(...)` during server
// rendering, which crashes.  Replace it with a no-op shim.
if (typeof globalThis.localStorage !== "undefined" && typeof window === "undefined") {
    globalThis.localStorage = {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
    };
}

/** @type {import('next').NextConfig} */
const nextConfig = {};

module.exports = nextConfig;
