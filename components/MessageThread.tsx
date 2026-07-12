"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Search, X } from "lucide-react";

type ThreadMessage = {
  id: string;
  sender: string;
  content: string;
  imageUrl?: string | null;
  createdAt: string; // pre-formatted on the server (IST) — Server Components can't pass Date objects to Client Components
};

// Shared location messages (and anything else with a raw URL in it) come through
// as plain text with a link inside — turn those into real clickable <a> tags
// instead of dead text so staff can tap straight through to Google Maps etc.
const URL_SPLIT_REGEX = /(https?:\/\/[^\s]+)/g;
const URL_TEST_REGEX = /^https?:\/\//;
function renderWithLinks(text: string) {
  return text.split(URL_SPLIT_REGEX).map((part, i) =>
    URL_TEST_REGEX.test(part) ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-blue-600 underline"
        onClick={(e) => e.stopPropagation()}
      >
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

// Styled like a real WhatsApp chat (wallpaper + bubble shapes) so it's fast to
// scan what's AI vs staff vs customer. No header bar here — the page above
// already shows the client's name/phone/status, so a second one would just
// eat vertical space without adding anything. Auto-scrolls to the newest
// message on first load and whenever a new one arrives. Images render as a
// fixed 190x190 thumbnail (inline style, not a Tailwind class, so it can't be
// silently dropped by a build step) instead of stretching to the bubble's
// full width — tap one to open it full-size in a lightbox.
export default function MessageThread({ messages }: { messages: ThreadMessage[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto rounded-xl border border-gray-300 bg-[#e5ddd5] px-3 py-3 shadow-sm">
        {messages.map((m) => {
          const sent = m.sender !== "CLIENT";
          const sentBg = m.sender === "STAFF" ? "bg-[#dbeafe]" : "bg-[#d9fdd3]";
          return (
            <div key={m.id} className={`flex ${sent ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[70%] overflow-hidden rounded-2xl shadow-sm ${
                  sent ? `rounded-tr-none ${sentBg}` : "rounded-tl-none bg-white"
                }`}
              >
                {m.imageUrl && (
                  <button
                    type="button"
                    onClick={() => setLightbox(m.imageUrl!)}
                    className="group relative block overflow-hidden"
                    style={{ width: 190, height: 190 }}
                  >
                    {/* Inline style (not a Tailwind class) on purpose — guarantees the
                        fixed thumbnail box can never be dropped by a CSS build step. */}
                    <img
                      src={m.imageUrl}
                      alt=""
                      style={{ width: 190, height: 190, objectFit: "cover", display: "block" }}
                    />
                    <span className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded-full bg-black/50 px-1.5 py-0.5 text-[10px] text-white opacity-90 group-hover:opacity-100">
                      <Search size={10} /> Enlarge
                    </span>
                  </button>
                )}
                <div className="px-2 py-1.5">
                  {m.sender === "STAFF" && (
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-600">Staff</p>
                  )}
                  <p className="whitespace-pre-wrap text-[14px] text-gray-900">{renderWithLinks(m.content)}</p>
                  <div className="mt-0.5 flex items-center justify-end gap-0.5">
                    <span className="text-[11px] text-gray-500">{m.createdAt}</span>
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

      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
          onClick={() => setLightbox(null)}
        >
          <button
            type="button"
            onClick={() => setLightbox(null)}
            className="absolute right-5 top-5 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
          >
            <X size={20} />
          </button>
          <img
            src={lightbox}
            alt=""
            className="max-h-full max-w-full rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
