"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Server Components only fetch fresh data on a real page load, so a new
// WhatsApp message won't appear on a dashboard page left open in the
// background. This silently re-fetches the current route every few seconds
// so Conversations (list + thread) stay close to live without needing
// websockets/SSE infrastructure.
export default function AutoRefresh({ intervalMs = 8000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => {
      // Don't refresh (and risk remounting/clearing the reply box) while the
      // user is actively typing in a text field.
      const active = document.activeElement;
      const isTyping =
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLInputElement && active.type === "text");
      if (isTyping) return;
      router.refresh();
    }, intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);

  return null;
}
