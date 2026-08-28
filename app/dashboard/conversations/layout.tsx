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
  });

  // Sorted by the conversation's own latest MESSAGE (in or out), not by when
  // the Conversation row was first created — added 2026-08-28, owner's own
  // request: "Conversation r old customer jadi kno ping kore tahole
  // automatically tar ta upore uthe asbe - like wts app e ja hoi" (if an old
  // customer messages again, their chat should jump back to the top, like
  // real WhatsApp). A conversation can be reopened and reused across many
  // days (see the webhook's "reopen instead of split" fix, Aug 2026), so
  // sorting by `createdAt` alone left a customer who just wrote in sitting
  // wherever their conversation was first created, sometimes far from the
  // top. Falls back to the conversation's own createdAt only for the
  // edge case of a brand-new conversation with zero messages yet.
  const sorted = conversations.sort((a, b) => {
    const aTime = (a.messages[0]?.createdAt ?? a.createdAt).getTime();
    const bTime = (b.messages[0]?.createdAt ?? b.createdAt).getTime();
    return bTime - aTime;
  });

  const items = sorted.map((c) => ({
    id: c.id,
    clientName: c.client.name,
    clientPhone: c.client.phone, // added 2026-08-28 — see the search bar in ConversationList.tsx
    channel: c.channel,
    status: c.status,
    aiPaused: c.aiPaused,
    handoffReason: c.handoffReason,
    lastMessage: c.messages[0]?.content ?? "No messages yet",
  }));

  return (
    <>
      <AutoRefresh intervalMs={8000} />
      {/* The overall height (viewport minus whatever chrome <main> reserves
          around it) now lives inside ConversationsSplitView instead of here —
          it varies by route on mobile (the conversation detail route drops
          DashboardShell's top bar entirely, see that file), so a client
          component that already knows the current pathname needs to own it. */}
      <ConversationsSplitView conversations={items}>{children}</ConversationsSplitView>
    </>
  );
}
