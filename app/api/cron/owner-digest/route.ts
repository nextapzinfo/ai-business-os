import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendWhatsAppTemplateMessage } from "@/lib/whatsapp";
import { logAudit } from "@/lib/audit";
import { logWhatsAppTemplateCost } from "@/lib/billing";
import { getOwnerStatusSnapshot } from "@/lib/owner-assistant";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Called once a day by Vercel Cron (see vercel.json). Protected by
// CRON_SECRET, same pattern as every other cron in this app.
//
// Proactively nudges the owner on WhatsApp when something actually needs
// their attention (owner's own request — see lib/owner-assistant.ts for the
// full context). WhatsApp only lets a business INITIATE contact with an
// approved template, never free text — even to an org's own owner — so this
// is necessarily a template send, unlike the free-text back-and-forth the
// owner gets any time THEY message the AI first (that's inbound-initiated,
// so the 24-hour customer-service window applies and free text is fine
// there; see the owner-branch in app/api/whatsapp/webhook/route.ts).
//
// Skips the send entirely when there's nothing pending, rather than sending
// an empty "all clear" template every single morning — the point is saving
// the owner a dashboard check, not adding a daily ritual message they start
// ignoring. Requires the owner to have created and gotten Meta's approval on
// a template (any wording works — {{1}}/{{2}}/{{3}} map to "needs a human"
// count, "unread" count, "self-review findings" count, in that order; fewer
// placeholders than that is fine too, the extra values are just dropped) and
// picked it as "Owner Daily Digest template" in Agent Studio → Skills.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profiles = await prisma.agentProfile.findMany({
    where: { skillOwnerAssistant: true, ownerAssistantPhone: { not: null }, ownerDigestTemplateId: { not: null } },
  });

  let sent = 0;
  let skippedAllClear = 0;
  let failed = 0;

  for (const profile of profiles) {
    if (!profile.ownerAssistantPhone) continue; // the where-clause above already guarantees this; narrows the type

    const template = await prisma.messageTemplate.findFirst({
      where: { id: profile.ownerDigestTemplateId!, organizationId: profile.organizationId, status: "APPROVED" },
    });
    if (!template) continue; // template deleted/rejected since being selected — skip until the owner picks a new one

    try {
      const snapshot = await getOwnerStatusSnapshot(profile.organizationId);
      if (snapshot.totalNeedsAttention === 0) {
        skippedAllClear++;
        continue;
      }

      const needsHuman = snapshot.escalatedCount + snapshot.staffHandlingCount;
      const bodyVariables = [
        String(needsHuman),
        String(snapshot.unreadCount),
        String(snapshot.pendingInsightCount + snapshot.pendingHandoffInsightCount),
      ];
      // Only pass as many variables as the template actually has
      // placeholders for — sending more than a template defines gets
      // rejected by Meta for an argument-count mismatch.
      const placeholderCount = (template.bodyText.match(/\{\{\d+\}\}/g) || []).length;

      await sendWhatsAppTemplateMessage(
        profile.ownerAssistantPhone,
        template.metaTemplateName,
        template.language,
        bodyVariables.slice(0, placeholderCount),
        template.headerType === "IMAGE" ? template.headerImageUrl ?? undefined : undefined
      );

      await logAudit({
        organizationId: profile.organizationId,
        action: "OWNER_DIGEST_SENT",
        metadata: {
          templateId: template.id,
          escalatedCount: snapshot.escalatedCount,
          staffHandlingCount: snapshot.staffHandlingCount,
          unreadCount: snapshot.unreadCount,
          pendingInsightCount: snapshot.pendingInsightCount,
          pendingHandoffInsightCount: snapshot.pendingHandoffInsightCount,
        },
      });
      await logWhatsAppTemplateCost(profile.organizationId, template.category);
      sent++;
    } catch (err) {
      console.error("Owner digest send failed:", err);
      failed++;
    }
  }

  return NextResponse.json({ status: "ok", sent, skippedAllClear, failed });
}
