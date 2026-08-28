import type { Metadata, Viewport } from "next";
import "./globals.css";
import Providers from "@/components/Providers";

// Web App Manifest — added 2026-08-28, owner's own report: a mobile "Add to
// Home Screen" shortcut opened a brand-new browser tab/page every time it
// was tapped, instead of resuming the app, so re-opening it repeatedly
// piled up more and more tabs in mobile Chrome ("mobile er chorme to anak
// page hoe jachhe"). Root cause: this app had no manifest.json at all, so a
// "shortcut" was really just a plain bookmark — mobile browsers only give a
// shortcut its own standalone, single-window behavior (no new tab per tap)
// once a real Web App Manifest with display:"standalone" is present and the
// shortcut was (re-)added after it exists. `manifest`/`icons`/`appleWebApp`
// below are Next.js's built-in Metadata API support for this — no extra
// package needed. Existing shortcuts made BEFORE this shipped won't pick it
// up automatically; they need to be removed and re-added once this is live.
export const metadata: Metadata = {
  title: "AI Business OS",
  description: "AI Employee platform for Tax/Law firms",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "AI Business OS",
  },
};

export const viewport: Viewport = {
  themeColor: "#12403a",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
