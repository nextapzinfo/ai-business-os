import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { analyzeConversationForInsights } from "@/lib/llm";
import { logAiUsage } from "@/lib/billing";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Called once a day by Vercel Cron (see vercel.json). Protected by CRON_SECRET.
// For every org with AI Self-Review enabled, finds CLOSED conversations that
// don't have a ConversationInsight yet, asks the AI to self-critique each one,
// and stores the result — never per-chat (that's an OpenAI call every single
// conversation), and never auto-applied to Knowledge Base/Custom Instructions;
// owner reviews everything on the Training page. Capped per org per run so a
// backlog can't blow past the serverless function's time limit.
const MAX_PER_ORG_PER_RUN = 15;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profiles = await prisma.agentProfile.findMany({
    where: { skillSelfAnalysis: true },
  });

  let analyzed = 0;
  let failed = 0;

  for (const profile of profiles) {
    const conversations = await prisma.conversation.findMany({
      where: {
        organizationId: profile.organizationId,
        status: "CLOSED",
        insight: null,
      },
      include: { messages: { orderBy: { createdAt: "asc" } } },
      take: MAX_PER_ORG_PER_RUN,
    });

    for (const conversation of conversations) {
      if (conversation.messages.length === 0) continue; // nothing to review

      try {
        const transcript = conversation.messages.map((m) => ({ sender: m.sender, content: m.content }));
        const { result, usage } = await analyzeConversationForInsights(transcript, profile.businessName);
        await logAiUsage(profile.organizationId, "self_analysis", usage);
        if (!result) continue; // malformed JSON from the model — skip, try again next run isn't possible since insight stays absent, which is fine

        await prisma.conversationInsight.create({
          data: {
            organizationId: profile.organizationId,
            conversationId: conversation.id,
            mistakes: result.mistakes || null,
            unanswered: result.unanswered || null,
            suggestedKnowledge: result.suggestedKnowledge || null,
            suggestedRules: result.suggestedRules || null,
          },
        });
        analyzed++;
      } catch (err) {
        console.error("Self-analysis failed for conversation", conversation.id, err);
        failed++;
      }
    }
  }

  return NextResponse.json({ status: "ok", analyzed, failed });
}
