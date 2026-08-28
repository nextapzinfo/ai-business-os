"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { AlertCircle, Search } from "lucide-react";

export type ConversationListItem = {
  id: string;
  clientName: string;
  clientPhone: string;
  channel: string;
  status: string;
  aiPaused: boolean;
  handoffReason: string | null;
  lastMessage: string;
};

function initialOf(name: string) {
  return (name?.trim()?.[0] ?? "?").toUpperCase();
}

const AVATAR_COLORS = ["bg-emerald-500", "bg-sky-500", "bg-amber-500", "bg-violet-500", "bg-rose-500"];
function avatarColor(seed: string) {
  const idx = seed.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % AVATAR_COLORS.length;
  return AVATAR_COLORS[idx];
}

// The clickable conversation list used in the shared Conversations layout —
// a client component so it can highlight whichever conversation is currently
// open (via the URL) without a full page navigation/"Back" round trip.
//
// Search bar added 2026-08-28, owner's own request: "Conversation : attach
// korechi oi khane jokhon sob ph no dakhabe - sekhane akra serach bar dao -
// Name ba ph no die serach kora jabe ar oi perticular client r sathe chat
// kora jabe" (in Conversations, where every phone number shows, add a
// search bar — searchable by Name or phone number — to open that
// particular customer's chat). Filters client-side, since the full list is
// already fetched and sorted server-side (see conversations/layout.tsx).
export default function ConversationList({ conversations }: { conversations: ConversationListItem[] }) {
  const pathname = usePathname();
  const [query, setQuery] = useState("");

  const filtered = (() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) => c.clientName.toLowerCase().includes(q) || c.clientPhone.toLowerCase().includes(q)
    );
  })();

  return (
    <>
      <div className="sticky top-0 z-10 flex-shrink-0 border-b border-gray-100 bg-white px-2.5 py-2">
        <div className="flex items-center gap-1.5 rounded-lg bg-gray-100 px-2.5 py-1.5">
          <Search size={14} className="flex-shrink-0 text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or phone..."
            className="w-full bg-transparent text-xs text-gray-700 outline-none placeholder:text-gray-400"
          />
        </div>
      </div>
      <div className="divide-y divide-gray-100">
      {filtered.map((c) => {
        const isActive = pathname === `/dashboard/conversations/${c.id}`;
        return (
          <a
            key={c.id}
            href={`/dashboard/conversations/${c.id}`}
            className={`flex items-center gap-2 border-l-2 px-2.5 py-2 transition-colors ${
              isActive ? "border-primary bg-primary/5" : "border-transparent hover:bg-gray-50"
            }`}
          >
            <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${avatarColor(c.clientName)}`}>
              {initialOf(c.clientName)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-sm font-medium text-gray-900">{c.clientName}</span>
                <span
                  className={`h-2 w-2 flex-shrink-0 rounded-full ${c.aiPaused ? "bg-amber-500" : "bg-emerald-500"}`}
                  title={c.aiPaused ? "Staff Handling" : "AI Active"}
                />
              </div>
              {c.handoffReason ? (
                <p className="flex items-center gap-1 truncate text-xs font-medium text-red-600">
                  <AlertCircle size={11} className="flex-shrink-0" /> Needs you — {c.handoffReason}
                </p>
              ) : (
                <p className="truncate text-xs text-gray-500">{c.lastMessage}</p>
              )}
            </div>
          </a>
        );
      })}
      {filtered.length === 0 && (
        <p className="px-3 py-6 text-center text-sm text-gray-500">
          {query.trim() ? "No conversations match your search." : "No conversations yet."}
        </p>
      )}
      </div>
    </>
  );
}
