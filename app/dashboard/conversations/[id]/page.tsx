import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { sendWhatsAppMessage, sendWhatsAppTemplateMessage } from "@/lib/whatsapp";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { formatDateTime } from "@/lib/formatDate";
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

// Free-text replies only deliver within WhatsApp's 24-hour customer-service
// window. Outside that window (or any time staff wants a guaranteed-delivery
// message), an approved template is the only thing Meta will actually send —
// this lets staff fire one off to a single customer without going through
// the bulk Broadcasts flow.
async function sendTemplateToClient(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const conversationId = formData.get("conversationId") as string;
  const templateId = formData.get("templateId") as string;
  if (!conversationId || !templateId) return;

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, organizationId: user.organizationId },
    include: { client: true },
  });
  if (!conversation) return;

  const template = await prisma.messageTemplate.findFirst({
    where: { id: templateId, organizationId: user.organizationId, status: "APPROVED" },
  });
  if (!template) return;

  const hasVariable = template.bodyText.includes("{{1}}");
  let sendError: string | null = null;
  try {
    await sendWhatsAppTemplateMessage(
      conversation.client.phone,
      template.metaTemplateName,
      template.language,
      hasVariable ? [conversation.client.name] : [],
      template.headerType === "IMAGE" ? template.headerImageUrl ?? undefined : undefined
    );
  } catch (err) {
    sendError = err instanceof Error ? err.message : "Unknown error";
    console.error("Manual template send failed:", err);
  }

  const sentBodyText = hasVariable ? template.bodyText.replace("{{1}}", conversation.client.name) : template.bodyText;
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      sender: "STAFF",
      content: sendError
        ? `[Template: ${template.name}] ${sentBodyText}\n\n[NOT DELIVERED: ${sendError}]`
        : `[Template: ${template.name}] ${sentBodyText}`,
    },
  });

  // Sending a template counts as staff taking over, same as a manual reply.
  if (!conversation.aiPaused) {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { aiPaused: true } });
  }

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "TEMPLATE_SENT_TO_CLIENT",
    metadata: { conversationId: conversation.id, templateId: template.id, delivered: !sendError, error: sendError },
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
    createdAt: formatDateTime(m.createdAt),
  }));

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">{conversation.client.name}</h1>
            <p className="text-sm text-gray-500">
              {conversation.client.phone} · {conversation.channel} · Status: {conversation.status}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                conversation.aiPaused ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
              }`}
            >
              {conversation.aiPaused ? "Staff Handling" : "AI Active"}
            </span>
            <form action={toggleAiPaused}>
              <input type="hidden" name="conversationId" value={conversation.id} />
              <button
                type="submit"
                className={`rounded-lg px-3 py-1.5 text-sm font-medium text-white ${
                  conversation.aiPaused ? "bg-accent hover:bg-emerald-600" : "bg-amber-600 hover:bg-amber-700"
                }`}
              >
                {conversation.aiPaused ? "Resume AI" : "Intervene"}
              </button>
            </form>
            <form action={closeConversation}>
              <input type="hidden" name="conversationId" value={conversation.id} />
              <button type="submit" className="rounded-lg bg-gray-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700">
                {conversation.status === "CLOSED" ? "Reopen" : "Mark Closed"}
              </button>
            </form>
          </div>
        </div>
      </div>

      <MessageThread clientName={conversation.client.name} messages={threadMessages} />

      <div className="mt-3 flex-shrink-0">
        <form key={conversation.messages.length} action={sendManualReply} className="flex gap-2">
          <input type="hidden" name="conversationId" value={conversation.id} />
          <textarea
            name="text"
            placeholder="Type a reply to send on WhatsApp..."
            required
            rows={2}
            className="flex-1 resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <button type="submit" className="self-end rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light">
            Send
          </button>
        </form>
        <p className="mt-1.5 text-xs text-gray-400">
          Sending a reply here automatically pauses the AI for this conversation (so it doesn't also
          reply) — click "Resume AI" above when you're done. Free-text replies only deliver within
          24 hours of the customer's last message (WhatsApp's rule).
        </p>

        {approvedTemplates.length > 0 && (
          <form action={sendTemplateToClient} className="mt-2 flex gap-2">
            <input type="hidden" name="conversationId" value={conversation.id} />
            <select
              name="templateId"
              required
              defaultValue=""
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xs text-gray-700"
            >
              <option value="" disabled>
                Send an approved template instead...
              </option>
              {approvedTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.language})
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="flex-shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50"
            >
              Send Template
            </button>
          </form>
        )}
        <p className="mt-1 text-xs text-gray-400">
          Outside the 24-hour window, only an approved template will actually deliver — use this any
          time instead of waiting for a bulk broadcast.
        </p>
      </div>
    </div>
  );
}
