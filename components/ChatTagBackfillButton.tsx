"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// "Read all old chats" — one-time pass over every customer's WhatsApp
// history (CRM Step 2b). Calls the backfill API in small batches until
// nothing is left, showing progress. Safe to stop and press again later:
// it always continues with customers not read yet.
export default function ChatTagBackfillButton({ total, pending }: { total: number; pending: number }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [left, setLeft] = useState(pending);
  const [error, setError] = useState<string | null>(null);
  const done = total - left;

  async function run() {
    setRunning(true);
    setError(null);
    let failures = 0;
    for (;;) {
      try {
        const res = await fetch("/api/crm/chat-tags/backfill", { method: "POST" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { remaining: number; processed: number };
        setLeft(data.remaining);
        failures = 0;
        if (data.remaining === 0 || data.processed === 0) break;
      } catch {
        failures++;
        if (failures >= 3) {
          setError("Stopped after repeated errors — press the button again to continue.");
          break;
        }
      }
    }
    setRunning(false);
    router.refresh();
  }

  if (total === 0) return <p className="text-xs text-gray-500">No customer chats yet.</p>;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={running || left === 0}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:cursor-not-allowed disabled:opacity-60"
      >
        {running ? "Reading chats…" : left === 0 ? "All old chats read ✓" : "Read all old chats now"}
      </button>
      <div className="min-w-[180px] flex-1">
        <div className="h-2 overflow-hidden rounded-full bg-gray-100">
          <div className="h-full bg-primary transition-all" style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
        </div>
        <p className="mt-1 text-xs text-gray-500">
          {done} of {total} customers read{left > 0 ? ` · ${left} left` : ""}
        </p>
      </div>
      {error && <p className="w-full text-xs text-red-600">{error}</p>}
    </div>
  );
}
