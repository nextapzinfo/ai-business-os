import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import AutoRefresh from "@/components/AutoRefresh";
import ConversationsSplitView from "@/components/ConversationsSplitView";

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
    <div className="flex h-[calc(100dvh-56px)] overflow-hidden lg:h-[calc(100vh-64px)]">
      <AutoRefresh intervalMs={8000} />
      <ConversationsSplitView conversations={items}>{children}</ConversationsSplitView>
    </div>
  );
}
