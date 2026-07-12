"use client";

import { useEffect, useRef } from "react";
import { Check } from "lucide-react";

type ThreadMessage = {
  id: string;
  sender: string;
  content: string;
  createdAt: string; // pre-formatted on the server (IST) — Server Components can't pass Date objects to Client Components
};

// Styled to look like an actual WhatsApp chat screen (header bar, wallpaper,
// bubble shapes) rather than a generic list — makes it much faster for staff
// to scan at a glance what's AI, what's staff, and what's the customer.
// Auto-scrolls to the newest message on first load and whenever a new one
// arrives (including ones picked up by AutoRefresh).
export default function MessageThread({
  clientName,
  messages,
}: {
  clientName: string;
  messages: ThreadMessage[];
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-gray-300 shadow-sm">
      <div className="flex flex-shrink-0 items-center gap-2 bg-[#075e54] px-3 py-2">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-white/20 text-xs font-semibold text-white">
          {clientName.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">{clientName}</p>
          <p className="truncate text-[11px] text-white/70">WhatsApp</p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto bg-[#e5ddd5] px-3 py-3">
        {messages.map((m) => {
          const sent = m.sender !== "CLIENT";
          const sentBg = m.sender === "STAFF" ? "bg-[#dbeafe]" : "bg-[#d9fdd3]";
          return (
            <div key={m.id} className={`flex ${sent ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[75%] rounded-2xl px-2.5 py-1.5 shadow-sm ${
                  sent ? `rounded-tr-none ${sentBg}` : "rounded-tl-none bg-white"
                }`}
              >
                {m.sender === "STAFF" && (
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-600">Staff</p>
                )}
                <p className="whitespace-pre-wrap text-[13px] text-gray-900">{m.content}</p>
                <div className="mt-0.5 flex items-center justify-end gap-0.5">
                  <span className="text-[10px] text-gray-500">{m.createdAt}</span>
                  {sent && <Check size={12} className="flex-shrink-0 text-gray-500" />}
                </div>
              </div>
            </div>
          );
        })}
        {messages.length === 0 && <p className="text-sm text-gray-500">No messages yet.</p>}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
