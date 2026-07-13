"use server";

import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { sendWhatsAppTemplateMessage } from "@/lib/whatsapp";
import { revalidatePath } from "next/cache";

// Free-text replies only deliver within WhatsApp's 24-hour customer-service
// window. Outside that window (or any time staff wants a guaranteed-delivery
// message), an approved template is the only thing Meta will actually send —
// this lets staff fire one off to a single customer without going through
// the bulk Broadcasts flow.
export async function sendTemplateToClient(formData: FormData) {
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
      imageUrl: template.headerType === "IMAGE" ? template.headerImageUrl : null,
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

// Staff taps a thumbs-down on an AI reply that was wrong — this just flags it
// so it shows up on the Training Dashboard for review; nothing about the AI's
// behavior changes until staff actually writes a correction there.
export async function flagMessageWrong(messageId: string) {
  const user = await getCurrentUser();
  if (!user) return;

  const message = await prisma.message.findFirst({
    where: { id: messageId, sender: "AI", conversation: { organizationId: user.organizationId } },
  });
  if (!message) return;

  await prisma.message.update({
    where: { id: messageId },
    data: { flaggedWrong: true },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "AI_MESSAGE_FLAGGED_WRONG",
    metadata: { messageId },
  });
}
