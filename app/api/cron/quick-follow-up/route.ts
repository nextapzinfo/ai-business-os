import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { generateFollowUpNudge } from "@/lib/llm";
import { logAudit } from "@/lib/audit";
import { logAiUsage } from "@/lib/billing";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Called every few minutes by Vercel Cron (see vercel.json) — deliberately
// far more often than the once-daily AI Follow-up cron (api/cron/follow-up),
// since this is meant to fire within minutes, not the next day. Added
// 2026-08-30, owner's own request: "AI katha bolar por CUStomer ar kono
// katha bolche na. kintu AI o ar kichu bolche na - ekahne ami followup
// kortei pari - seta ami nije korchi... amar behaviour dekhe seirokom bhave
// 10 min or 30 min pore conversation chalie jabe" — mirrors the owner's own
// habit of glancing back at a chat that's gone quiet and sending a short,
// natural nudge, rather than the formal once-a-day templated follow-up.
// Protected by CRON_SECRET like every other cron route here.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profiles = await prisma.agentProfile.findMany({
    where: { skillQuickFollowUp: true },
  });

  let sent = 0;
  let failed = 0;

  for (const profile of profiles) {
    const cutoff = new Date(Date.now() - profile.quickFollowUpMinutes * 60 * 1000);

    const candidates = await prisma.conversation.findMany({
      where: {
        organizationId: profile.organizationId,
        status: "OPEN",
        aiPaused: false, // staff is actively handling this one — don't auto-nudge on top of them
      },
      include: {
        client: true,
        messages: { orderBy: { createdAt: "desc" }, take: 10 },
      },
    });

    for (const conversation of candidates) {
      const latest = conversation.messages[0];
      if (!latest) continue; // no messages yet
      if (latest.sender !== "AI") continue; // only follow up when the AI's OWN last message went unanswered — not staff's (that's what item 4's handoff self-training already covers) and not the customer's (nothing to nudge, they already replied)
      if (latest.createdAt > cutoff) continue; // not quiet long enough yet
      // Already sent a quick nudge for THIS SAME unanswered AI message —
      // compares against the message's own timestamp (not just "is this
      // set at all") so a later, newer unanswered AI message can still
      // trigger a fresh nudge even though one was sent earlier in this
      // same conversation's life.
      if (conversation.lastQuickFollowUpAt && conversation.lastQuickFollowUpAt >= latest.createdAt) continue;

      try {
        const transcript = conversation.messages
          .slice()
          .reverse()
          .map((m) => ({ sender: m.sender, content: m.content }));
        const { message, usage } = await generateFollowUpNudge(transcript, profile.businessName);
        await logAiUsage(profile.organizationId, "self_analysis", usage); // reuses this category rather than adding a 5th — see the same note on the handoff self-training call in conversations/[id]/page.tsx
        if (!message) continue;

        await sendWhatsAppMessage(conversation.client.phone, message);

        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            sender: "AI",
            content: `[Quick follow-up] ${message}`,
          },
        });
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastQuickFollowUpAt: new Date() },
        });
        await logAudit({
          organizationId: profile.organizationId,
          action: "QUICK_FOLLOW_UP_SENT",
          metadata: { conversationId: conversation.id, clientId: conversation.clientId },
        });
        sent++;
      } catch (err) {
        console.error("Quick follow-up send failed:", err);
        failed++;
      }
    }
  }

  return NextResponse.json({ status: "ok", sent, failed });
}
