import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import ConversationList from "@/components/ConversationList";
import AutoRefresh from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

// Shared by /dashboard/conversations and /dashboard/conversations/[id] — keeps
// the client list permanently visible on the left (AiSensy-style), so opening
// a different conversation is a single click with no "Back" round trip.
export default async function ConversationsLayout({ children }: { children: React.ReactNode }) {
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

  const items = conversations.map((c) => ({
    id: c.id,
    clientName: c.client.name,
    channel: c.channel,
    status: c.status,
    aiPaused: c.aiPaused,
    handoffReason: c.handoffReason,
    lastMessage: c.messages[0]?.content ?? "No messages yet",
  }));

  return (
    <div className="flex overflow-hidden" style={{ height: "calc(100vh - 64px)" }}>
      <AutoRefresh intervalMs={8000} />

      <div className="flex w-[260px] flex-shrink-0 flex-col overflow-y-auto border-r border-gray-200 bg-white">
        <div className="flex-shrink-0 border-b border-gray-100 px-3 py-2.5">
          <h2 className="text-sm font-semibold text-gray-900">Conversations</h2>
        </div>
        <ConversationList conversations={items} />
      </div>

      <div className="min-w-0 flex-1 overflow-hidden pl-4">{children}</div>
    </div>
  );
}
