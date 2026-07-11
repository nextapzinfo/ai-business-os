import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import AutoRefresh from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

function initialOf(name: string) {
  return (name?.trim()?.[0] ?? "?").toUpperCase();
}

const AVATAR_COLORS = ["bg-emerald-500", "bg-sky-500", "bg-amber-500", "bg-violet-500", "bg-rose-500"];
function avatarColor(seed: string) {
  const idx = seed.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % AVATAR_COLORS.length;
  return AVATAR_COLORS[idx];
}

export default async function ConversationsPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const conversations = await prisma.conversation.findMany({
    where: { organizationId: user.organizationId },
    include: {
      client: true,
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div>
      <AutoRefresh intervalMs={8000} />
      <h1 className="text-xl font-semibold text-gray-900">Conversations</h1>
      <p className="mt-1 text-sm text-gray-500">Click any conversation to open the full thread and reply manually.</p>

      <div className="mt-4 divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white">
        {conversations.map((c) => (
          <a
            key={c.id}
            href={`/dashboard/conversations/${c.id}`}
            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-gray-50"
          >
            <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white ${avatarColor(c.client.name)}`}>
              {initialOf(c.client.name)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-gray-900">{c.client.name}</span>
                <span className="flex-shrink-0 text-xs text-gray-400">{c.channel}</span>
              </div>
              <p className="truncate text-sm text-gray-500">{c.messages[0]?.content ?? "No messages yet"}</p>
            </div>
            <div className="flex flex-shrink-0 flex-col items-end gap-1">
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                  c.aiPaused ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
                }`}
              >
                {c.aiPaused ? "Staff Handling" : "AI Active"}
              </span>
              <span className="text-xs text-gray-400">{c.status}</span>
            </div>
          </a>
        ))}
        {conversations.length === 0 && (
          <p className="px-4 py-6 text-sm text-gray-500">No conversations yet.</p>
        )}
      </div>
    </div>
  );
}
