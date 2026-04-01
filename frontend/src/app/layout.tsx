import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
    title: "YOLO Deck",
    description:
        "Steuerungszentrale für claude-yolo — Claude Code in isolierten Docker-Containern",
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="de">
            <body>{children}</body>
        </html>
    );
}
