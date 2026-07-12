"use client";

import { useEffect, useRef } from "react";
import { Check } from "lucide-react";

type ThreadMessage = {
  id: string;
  sender: string;
  content: string;
  imageUrl?: string | null;
  createdAt: string; // pre-formatted on the server (IST) — Server Components can't pass Date objects to Client Components
};

// Styled like a real WhatsApp chat (wallpaper + bubble shapes) so it's fast to
// scan what's AI vs staff vs customer. No header bar here — the page above
// already shows the client's name/phone/status, so a second one would just
// eat vertical space without adding anything. Auto-scrolls to the newest
// message on first load and whenever a new one arrives.
export default function MessageThread({ messages }: { messages: ThreadMessage[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto rounded-xl border border-gray-300 bg-[#e5ddd5] px-3 py-3 shadow-sm">
      {messages.map((m) => {
        const sent = m.sender !== "CLIENT";
        const sentBg = m.sender === "STAFF" ? "bg-[#dbeafe]" : "bg-[#d9fdd3]";
        return (
          <div key={m.id} className={`flex ${sent ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[75%] overflow-hidden rounded-2xl shadow-sm ${
                sent ? `rounded-tr-none ${sentBg}` : "rounded-tl-none bg-white"
              }`}
            >
              {m.imageUrl && (
                <img src={m.imageUrl} alt="" className="max-h-64 w-full object-cover" />
              )}
              <div className="px-2.5 py-1.5">
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
          </div>
        );
      })}
      {messages.length === 0 && <p className="text-sm text-gray-500">No messages yet.</p>}
      <div ref={bottomRef} />
    </div>
  );
}
