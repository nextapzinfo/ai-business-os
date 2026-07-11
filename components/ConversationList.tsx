"use client";

import { usePathname } from "next/navigation";

export type ConversationListItem = {
  id: string;
  clientName: string;
  channel: string;
  status: string;
  aiPaused: boolean;
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
export default function ConversationList({ conversations }: { conversations: ConversationListItem[] }) {
  const pathname = usePathname();

  return (
    <div className="divide-y divide-gray-100">
      {conversations.map((c) => {
        const isActive = pathname === `/dashboard/conversations/${c.id}`;
        return (
          <a
            key={c.id}
            href={`/dashboard/conversations/${c.id}`}
            className={`flex items-center gap-2.5 border-l-2 px-3 py-3 transition-colors ${
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
              <p className="truncate text-xs text-gray-500">{c.lastMessage}</p>
            </div>
          </a>
        );
      })}
      {conversations.length === 0 && <p className="px-3 py-6 text-center text-sm text-gray-500">No conversations yet.</p>}
    </div>
  );
}
