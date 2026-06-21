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
        <html lang="de" suppressHydrationWarning>
            <head>
                <script
                    dangerouslySetInnerHTML={{
                        __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark')}catch(e){}})()`,
                    }}
                />
            </head>
            <body>{children}</body>
        </html>
    );
}
