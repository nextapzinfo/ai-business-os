"use client";

import { useState } from "react";

type TeachMessage = { role: "user" | "assistant"; text: string; actionsTaken?: string[] };

// "Teach AI" chat — Training page. Lets the owner update products/knowledge by
// chatting naturally ("Sorbhaja er dam ekhon 260") instead of using forms,
// same idea as Meta's own built-in Business Agent chat. Unlike the Agent
// Studio Test Sandbox, tool calls here are REAL writes to Product/Document.
export default function TeachAIChat() {
  const [messages, setMessages] = useState<TeachMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSend() {
    const message = input.trim();
    if (!message || loading) return;

    const history = messages.map((m) => ({ role: m.role, content: m.text }));
    setMessages((prev) => [...prev, { role: "user", text: message }]);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/agent/teach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history }),
      });
      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: data.answer || "Sorry, something went wrong — try again.",
          actionsTaken: data.actionsTaken,
        },
      ]);
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", text: "Something went wrong — try again." }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-gray-900">Teach AI</h3>
      <p className="mt-1 text-xs text-gray-500">
        Chat with your AI to update it directly — tell it a price change, a new policy, or any fact to
        remember (e.g. "Sorbhaja er dam ekhon 260" or "amra robibar bondho thaki"). This writes to the real
        Products/Knowledge Base immediately — it's not a test sandbox.
      </p>

      <div
        className="mt-3 flex-1 space-y-2 overflow-y-auto rounded-lg border border-gray-100 bg-gray-50 p-3"
        style={{ minHeight: 220, maxHeight: 380 }}
      >
        {messages.length === 0 && (
          <p className="text-xs text-gray-400">No messages yet — tell it something to remember below.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"}`}>
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                m.role === "user" ? "bg-primary text-white" : "border border-gray-200 bg-white text-gray-800"
              }`}
            >
              {m.text}
            </div>
            {m.actionsTaken && m.actionsTaken.length > 0 && (
              <div className="mt-1 flex max-w-[85%] flex-col gap-1">
                {m.actionsTaken.map((a, j) => (
                  <span key={j} className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">
                    ✓ {a}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        {loading && <p className="text-xs text-gray-400">Thinking...</p>}
      </div>

      <div className="mt-3 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSend();
          }}
          placeholder="Tell your AI something to remember or correct..."
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <button
          onClick={handleSend}
          disabled={loading}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-60"
        >
          Send
        </button>
      </div>
    </div>
  );
}
