import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formatDateTime } from "@/lib/formatDate";
import MessageThread from "@/components/MessageThread";
import SendTemplateButton from "@/components/SendTemplateButton";

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

  // Sending a manual reply counts as "taking over" the conversation — pause the
  // AI so it doesn't also reply to the customer's next message and talk over staff.
  if (!conversation.aiPaused) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { aiPaused: true },
    });
  }

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

async function toggleAiPaused(formData: FormData) {
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
    data: { aiPaused: !conversation.aiPaused },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: conversation.aiPaused ? "AI_RESUMED" : "AI_INTERVENED",
    metadata: { conversationId: conversation.id },
  });

  revalidatePath(`/dashboard/conversations/${conversationId}`);
}

export default async function ConversationDetailPage({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return null;

  const [conversation, approvedTemplates] = await Promise.all([
    prisma.conversation.findFirst({
      where: { id: params.id, organizationId: user.organizationId },
      include: { client: true, messages: { orderBy: { createdAt: "asc" } } },
    }),
    prisma.messageTemplate.findMany({
      where: { organizationId: user.organizationId, status: "APPROVED" },
      orderBy: { name: "asc" },
    }),
  ]);

  if (!conversation) redirect("/dashboard/conversations");

  const threadMessages = conversation.messages.map((m) => ({
    id: m.id,
    sender: m.sender,
    content: m.content,
    imageUrl: m.imageUrl,
    createdAt: formatDateTime(m.createdAt),
  }));

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-shrink-0 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-[22px] font-semibold leading-tight text-gray-900">{conversation.client.name}</h1>
            <p className="text-[13px] text-gray-500">
              {conversation.client.phone} · {conversation.channel} · Status: {conversation.status}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className={`rounded-full px-2 py-1 text-[11px] font-semibold ${
                conversation.aiPaused ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
              }`}
            >
              {conversation.aiPaused ? "Staff Handling" : "AI Active"}
            </span>
            <form action={toggleAiPaused}>
              <input type="hidden" name="conversationId" value={conversation.id} />
              <button
                type="submit"
                className={`flex h-9 items-center rounded-lg px-2.5 text-xs font-medium text-white ${
                  conversation.aiPaused ? "bg-accent hover:bg-emerald-600" : "bg-amber-600 hover:bg-amber-700"
                }`}
              >
                {conversation.aiPaused ? "▶ Resume" : "⏸ Pause"}
              </button>
            </form>
            <form action={closeConversation}>
              <input type="hidden" name="conversationId" value={conversation.id} />
              <button type="submit" className="flex h-9 items-center rounded-lg bg-gray-600 px-2.5 text-xs font-medium text-white hover:bg-gray-700">
                {conversation.status === "CLOSED" ? "↺ Reopen" : "✓ Closed"}
              </button>
            </form>
          </div>
        </div>
      </div>

      <MessageThread messages={threadMessages} />

      <div className="mt-2 flex-shrink-0">
        <div className="flex items-center gap-2">
          <form key={conversation.messages.length} action={sendManualReply} className="flex flex-1 gap-2">
            <input type="hidden" name="conversationId" value={conversation.id} />
            <textarea
              name="text"
              placeholder="Type a reply to send on WhatsApp..."
              required
              rows={1}
              className="h-[44px] flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2.5 text-sm leading-tight"
            />
            <button type="submit" className="h-[44px] flex-shrink-0 rounded-lg bg-primary px-4 text-sm font-medium text-white hover:bg-primary-light">
              Send
            </button>
          </form>
          <SendTemplateButton
            conversationId={conversation.id}
            templates={approvedTemplates.map((t) => ({ id: t.id, name: t.name, language: t.language }))}
          />
        </div>
        <p className="mt-1 text-[11px] text-gray-400">
          Free-text only delivers within 24 hours of the customer's last message; use Send Template
          outside that window.
        </p>
      </div>
    </div>
  );
}
