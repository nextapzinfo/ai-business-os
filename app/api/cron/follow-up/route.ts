import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendWhatsAppTemplateMessage } from "@/lib/whatsapp";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Called once a day by Vercel Cron (see vercel.json). Protected by CRON_SECRET
// so a random request can't trigger real WhatsApp sends. For every org with
// AI Follow-up enabled, finds conversations where the AI/staff sent the last
// message and the customer went quiet for followUpHours, and nudges them —
// always via an APPROVED TEMPLATE (never free text), since by the time this
// runs the 24-hour customer-service window may already be closed. Sends at
// most once per conversation (Conversation.lastFollowUpAt gates re-sends).
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profiles = await prisma.agentProfile.findMany({
    where: { skillFollowUp: true, followUpTemplateId: { not: null } },
  });

  let sent = 0;
  let failed = 0;

  for (const profile of profiles) {
    const template = await prisma.messageTemplate.findFirst({
      where: { id: profile.followUpTemplateId!, organizationId: profile.organizationId, status: "APPROVED" },
    });
    if (!template) continue; // template was deleted/rejected since being selected — skip until owner picks a new one

    const cutoff = new Date(Date.now() - profile.followUpHours * 60 * 60 * 1000);

    const candidates = await prisma.conversation.findMany({
      where: {
        organizationId: profile.organizationId,
        status: "OPEN",
        aiPaused: false, // respect staff actively handling a conversation — don't auto-nudge those
        lastFollowUpAt: null, // only ever one follow-up per conversation
      },
      include: {
        client: true,
        messages: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });

    for (const conversation of candidates) {
      const lastMessage = conversation.messages[0];
      if (!lastMessage) continue; // no messages yet — nothing to follow up on
      if (lastMessage.sender === "CLIENT") continue; // customer already replied last — not waiting on them
      if (lastMessage.createdAt > cutoff) continue; // not quiet long enough yet

      const hasVariable = template.bodyText.includes("{{1}}");
      try {
        await sendWhatsAppTemplateMessage(
          conversation.client.phone,
          template.metaTemplateName,
          template.language,
          hasVariable ? [conversation.client.name] : [],
          template.headerType === "IMAGE" ? template.headerImageUrl ?? undefined : undefined
        );

        const sentBodyText = hasVariable
          ? template.bodyText.replace("{{1}}", conversation.client.name)
          : template.bodyText;

        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            sender: "AI",
            content: `[Follow-up: ${template.name}] ${sentBodyText}`,
            imageUrl: template.headerType === "IMAGE" ? template.headerImageUrl : null,
          },
        });
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastFollowUpAt: new Date() },
        });
        await logAudit({
          organizationId: profile.organizationId,
          action: "FOLLOW_UP_SENT",
          metadata: { conversationId: conversation.id, clientId: conversation.clientId, templateId: template.id },
        });
        sent++;
      } catch (err) {
        console.error("Follow-up send failed:", err);
        failed++;
      }
    }
  }

  return NextResponse.json({ status: "ok", sent, failed });
}
