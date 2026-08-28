"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCheck, Search, X, ThumbsDown } from "lucide-react";
import { flagMessageWrong } from "@/app/dashboard/conversations/[id]/actions";

type ThreadMessage = {
  id: string;
  sender: string;
  content: string;
  imageUrl?: string | null;
  mediaType?: string | null; // IMAGE or VIDEO — null/IMAGE both render as a photo (older rows predate this field, they're always photos)
  flaggedWrong?: boolean;
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

// Styled like a real WhatsApp chat (wallpaper + bubble shapes + a single
// outgoing bubble color, same as the real app) — embedded directly inside the
// same rounded card as the header/reply bar in the page above (no rounding or
// border of its own here, the card wrapper supplies both), so the whole
// Conversation view reads as one continuous WhatsApp-style window rather than
// three separate panels. AI vs staff-sent is now called out with a small text
// tag instead of a different bubble color, so the bubbles themselves stay
// true to WhatsApp's real look. Auto-scrolls to the newest message on first
// load and whenever a new one arrives. Images render as a fixed 190x190
// thumbnail (inline style, not a Tailwind class, so it can't be silently
// dropped by a build step) instead of stretching to the bubble's full width —
// tap one to open it full-size in a lightbox.
export default function MessageThread({ messages }: { messages: ThreadMessage[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [flaggedLocally, setFlaggedLocally] = useState<Set<string>>(new Set());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  async function handleFlagWrong(messageId: string) {
    setFlaggedLocally((prev) => new Set(prev).add(messageId)); // optimistic — instant feedback
    try {
      await flagMessageWrong(messageId);
    } catch (err) {
      console.error("Flag wrong failed:", err);
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto bg-[#e5ddd5] px-3 py-3">
        {messages.map((m) => {
          const sent = m.sender !== "CLIENT";
          return (
            <div key={m.id} className={`flex ${sent ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[75%] overflow-hidden rounded-2xl shadow-sm ${
                  sent ? "rounded-tr-none bg-[#d9fdd3]" : "rounded-tl-none bg-white"
                }`}
              >
                {m.imageUrl && m.mediaType === "VIDEO" ? (
                  // Video gets its own native player (controls, no autoplay) instead of
                  // the tap-to-enlarge lightbox images use — a <video controls> element
                  // is already fully interactive on its own, so a second "enlarge" step
                  // would just be friction.
                  <video
                    src={m.imageUrl}
                    controls
                    style={{ width: 190, height: 190, objectFit: "cover", display: "block", background: "#000" }}
                  />
                ) : (
                  m.imageUrl && (
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
                  )
                )}
                <div className="px-2 py-1.5">
                  {sent && (
                    <p
                      className={`text-[10px] font-semibold uppercase tracking-wide ${
                        m.sender === "STAFF" ? "text-blue-600" : "text-emerald-700"
                      }`}
                    >
                      {m.sender === "STAFF" ? "You (Staff)" : "AI"}
                    </p>
                  )}
                  <p className="whitespace-pre-wrap text-[14.5px] text-gray-900">{renderWithLinks(m.content)}</p>
                  <div className="mt-0.5 flex items-center justify-end gap-1.5">
                    {m.sender === "AI" &&
                      (m.flaggedWrong || flaggedLocally.has(m.id) ? (
                        <span className="text-[10px] text-gray-400">Flagged for review</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleFlagWrong(m.id)}
                          title="Mark this reply as wrong — sends it to the Training page for review"
                          className="text-gray-400 hover:text-red-500"
                        >
                          <ThumbsDown size={11} />
                        </button>
                      ))}
                    <span className="text-[11px] text-gray-500">{m.createdAt}</span>
                    {/* Double-check, like a real WhatsApp sent message — this app doesn't
                        track actual delivered/read receipts, so it's shown in neutral gray
                        (meaning "sent") rather than WhatsApp's blue "read" color, to avoid
                        implying a read confirmation this app doesn't actually have. */}
                    {sent && <CheckCheck size={14} className="flex-shrink-0 text-gray-400" />}
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
