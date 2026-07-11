"use client";

import { useEffect, useRef } from "react";

type ThreadMessage = {
  id: string;
  sender: string;
  content: string;
  createdAt: string; // pre-formatted on the server (IST) — Server Components can't pass Date objects to Client Components
};

// Auto-scrolls the thread to the newest message on first load and whenever a
// new message arrives (including ones picked up by AutoRefresh), so staff
// don't have to manually scroll down every time.
export default function MessageThread({ messages }: { messages: ThreadMessage[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  return (
    <div style={threadStyle}>
      {messages.map((m) => (
        <div key={m.id} style={bubbleStyle(m.sender)}>
          <div style={metaStyle}>
            {m.sender} · {m.createdAt}
          </div>
          <div style={contentStyle}>{m.content}</div>
        </div>
      ))}
      {messages.length === 0 && <p style={emptyStyle}>No messages yet.</p>}
      <div ref={bottomRef} />
    </div>
  );
}

function bubbleStyle(sender: string) {
  const bg = sender === "CLIENT" ? "#fff" : sender === "STAFF" ? "#dbeafe" : "#dcfce7";
  return {
    alignSelf: sender === "CLIENT" ? "flex-start" : "flex-end",
    maxWidth: "70%",
    background: bg,
    border: "1px solid #e5e5e5",
    borderRadius: 8,
    padding: "8px 12px",
  } as const;
}

const threadStyle = {
  flex: 1,
  minHeight: 0,
  border: "1px solid #e5e5e5",
  borderRadius: 8,
  background: "#fafafa",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  overflowY: "auto",
} as const;
const metaStyle = { fontSize: 11, color: "#888", marginBottom: 2 };
const contentStyle = { fontSize: 14, whiteSpace: "pre-wrap" } as const;
const emptyStyle = { color: "#666", fontSize: 14 };
