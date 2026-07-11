import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formatDateTime } from "@/lib/formatDate";
import AutoRefresh from "@/components/AutoRefresh";
import MessageThread from "@/components/MessageThread";

export const dynamic = "force-dynamic";

async function sendManualReply(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const conversationId = formData.get("conversationId") as string;
  const text = (formData.get("text") as string)?.trim();
  if (!conversationId || !text) return;

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, organizationId: user.organizationId },
    include: { client: true },
  });
  if (!conversation) return;

  let sendError: string | null = null;
  try {
    await sendWhatsAppMessage(conversation.client.phone, text);
  } catch (err) {
    sendError = err instanceof Error ? err.message : "Unknown error";
    console.error("Manual WhatsApp reply failed:", err);
  }

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      sender: "STAFF",
      content: sendError ? `${text}\n\n[NOT DELIVERED: ${sendError}]` : text,
    },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "MANUAL_REPLY_SENT",
    metadata: { conversationId: conversation.id, delivered: !sendError, error: sendError },
  });

  revalidatePath(`/dashboard/conversations/${conversationId}`);
}

async function closeConversation(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const conversationId = formData.get("conversationId") as string;
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, organizationId: user.organizationId },
  });
  if (!conversation) return;

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { status: conversation.status === "CLOSED" ? "OPEN" : "CLOSED" },
  });

  revalidatePath(`/dashboard/conversations/${conversationId}`);
}

export default async function ConversationDetailPage({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return null;

  const conversation = await prisma.conversation.findFirst({
    where: { id: params.id, organizationId: user.organizationId },
    include: { client: true, messages: { orderBy: { createdAt: "asc" } } },
  });

  if (!conversation) redirect("/dashboard/conversations");

  const threadMessages = conversation.messages.map((m) => ({
    id: m.id,
    sender: m.sender,
    content: m.content,
    createdAt: formatDateTime(m.createdAt),
  }));

  return (
    <div>
      <AutoRefresh intervalMs={8000} />
      <a href="/dashboard/conversations" style={backLinkStyle}>&larr; Back to Conversations</a>

      <div style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>{conversation.client.name}</h1>
          <p style={subtitleStyle}>{conversation.client.phone} · {conversation.channel} · Status: {conversation.status}</p>
        </div>
        <form action={closeConversation}>
          <input type="hidden" name="conversationId" value={conversation.id} />
          <button type="submit" style={closeButtonStyle}>{conversation.status === "CLOSED" ? "Reopen" : "Mark Closed"}</button>
        </form>
      </div>

      <MessageThread messages={threadMessages} />

      <form key={conversation.messages.length} action={sendManualReply} style={replyFormStyle}>
        <input type="hidden" name="conversationId" value={conversation.id} />
        <textarea name="text" placeholder="Type a reply to send on WhatsApp..." required rows={2} style={textareaStyle} />
        <button type="submit" style={sendButtonStyle}>Send</button>
      </form>
      <p style={hintStyle}>
        Free-text replies only deliver within 24 hours of the customer's last message (WhatsApp's rule). Outside that window, use a Template broadcast instead.
      </p>
    </div>
  );
}

const backLinkStyle = { fontSize: 13, color: "#2563eb" };
const headerRowStyle = { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 };
const titleStyle = { marginBottom: 4 };
const subtitleStyle = { color: "#666", fontSize: 13 };
const closeButtonStyle = { padding: "8px 16px", background: "#666", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer" };
const replyFormStyle = { display: "flex", gap: 8, marginTop: 16 };
const textareaStyle = { padding: 8, border: "1px solid #ccc", borderRadius: 6, fontFamily: "inherit", fontSize: 14, flex: 1, resize: "vertical" } as const;
const sendButtonStyle = { padding: "8px 16px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", alignSelf: "flex-end" } as const;
const hintStyle = { color: "#999", fontSize: 12, marginTop: 6 };
