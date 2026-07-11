import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

async function sendManualReply(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const conversationId = formData.get("conversationId") as string;
  const text = (formData.get("text") as string)?.trim();
  if (!conversationId || !text) return;

  // Always re-derive the client's phone from our own DB — never trust form input for it.
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

export default async function ConversationDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const user = await getCurrentUser();
  if (!user) return null;

  const conversation = await prisma.conversation.findFirst({
    where: { id: params.id, organizationId: user.organizationId },
    include: {
      client: true,
      messages: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!conversation) redirect("/dashboard/conversations");

  return (
    <div>
      <a href="/dashboard/conversations" style={{ fontSize: 13, color: "#2563eb" }}>
        &larr; Back to Conversations
      </a>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>{conversation.client.name}</h1>
          <p style={{ color: "#666", fontSize: 13 }}>
            {conversation.client.phone} · {conversation.channel} · Status: {conversation.status}
          </p>
        </div>
        <form action={closeConversation}>
          <input type="hidden" name="conversationId" value={conversation.id} />
          <button type="submit" style={{ ...buttonStyle, background: "#666" }}>
            {conversation.status === "CLOSED" ? "Reopen" : "Mark Closed"}
          </button>
        </form>
      </div>

      <div
        style={{
          marginTop: 20,
          border: "1px solid #e5e5e5",
          borderRadius: 8,
          background: "#fafafa",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          maxHeight: 500,
          overflowY: "auto",
        }}
      >
        {conversation.messages.map((m) => (
          <div
            key={m.id}
            style={{
              alignSelf: m.sender === "CLIENT" ? "flex-start" : "flex-end",
              maxWidth: "70%",
              background: m.sender === "CLIENT" ? "#fff" : m.sender === "STAFF" ? "#dbeafe" : "#dcfce7",
              border: "1px solid #e5e5e5",
              borderRadius: 8,
              padding: "8px 12px",
            }}
          >
            <div style={{ fontSize: 11, color: "#888", marginBottom: 2 }}>
              {m.sender} · {m.createdAt.toLocaleString()}
            </div>
            <div style={{ fontSize: 14, whiteSpace: "pre-wrap" }}>{m.content}</div>
          </div>
        ))}
        {conversation.messages.length === 0 && (
          <p style={{ color: "#666", fontSize: 14 }}>No messages yet.</p>
        )}
      </div>

      <form
        action={sendManualReply}
        style={{ display: "flex", gap: 8, marginTop: 16 }}
      >
        <input type="hidden" name="conversationId" value={conversation.id} />
        <textarea
          name="text"
          placeholder="Type a reply to send on WhatsApp..."
          required
          rows={2}
          style={{ ...inputStyle, flex: 1, resize: "vertical" }}
        />
        <button type="submit" style={{ ...buttonStyle, alignSelf: "flex-end" }}>
          Send
        </button>
      </form>
      <p style={{ color: "#999", fontSize: 12, marginTop: 6 }}>
        Free-text replies only deliver within 24 hours of the customer's last message (WhatsApp's
        rule). Outside that window, use a Template broadcast instead.
      </p>
    </div>
  );
}

const inputStyle = {
  padding: 8,
  border: "1px solid #ccc",
  borderRadius: 6,
  fontFamily: "inherit",
  fontSize: 14,
};
const buttonStyle = {
  padding: "8px 16px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
};