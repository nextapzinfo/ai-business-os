import { prisma } from "@/lib/prisma";

// GPT-5.6 Luna published per-token pricing (USD) — verified via web search,
// Aug 2026 (post the Jul 30, 2026 price cut). Switched from gpt-4o-mini to
// Luna 2026-08-29 (owner's own request, see lib/llm.ts's OPENAI_MODEL
// comment) — if the model changes again (e.g. mixing in Terra for complex
// replies later), update these rates in the SAME commit, or this function
// will silently keep billing every call at Luna's rate even for a different,
// more expensive model. Historical AiUsageLog rows keep whatever cost was
// computed at the time, so past days stay accurate regardless.
export const LUNA_INPUT_RATE_USD = 0.2 / 1_000_000;
export const LUNA_OUTPUT_RATE_USD = 1.2 / 1_000_000;

export function calcOpenAiCostUsd(promptTokens: number, completionTokens: number): number {
  return promptTokens * LUNA_INPUT_RATE_USD + completionTokens * LUNA_OUTPUT_RATE_USD;
}

// Logs the REAL cost of one OpenAI call, computed from the actual token counts
// OpenAI returned — not an estimate. Swallows its own errors so a logging
// failure never breaks the actual customer-facing reply.
export async function logAiUsage(
  organizationId: string,
  source: "webhook_reply" | "sandbox_test" | "self_analysis" | "teach_ai_chat",
  usage: { promptTokens: number; completionTokens: number } | null | undefined
) {
  if (!usage) return;
  try {
    await prisma.aiUsageLog.create({
      data: {
        organizationId,
        source,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        costUsd: calcOpenAiCostUsd(usage.promptTokens, usage.completionTokens),
      },
    });
  } catch (err) {
    console.error("logAiUsage failed:", err);
  }
}

// Logs an ESTIMATED WhatsApp template send cost, using the organization's
// configured per-category rate (Organization.costPerMarketingMsg etc.) — this
// is NOT the exact Meta bill. Meta charges based on the recipient's country
// and the rate can change; the authoritative number is always Meta's own
// Billing dashboard (business.facebook.com). Swallows its own errors so a
// logging failure never blocks the actual send.
export async function logWhatsAppTemplateCost(organizationId: string, category: string) {
  try {
    const org = await prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org) return;
    const rate =
      category === "MARKETING"
        ? org.costPerMarketingMsg
        : category === "AUTHENTICATION"
        ? org.costPerAuthMsg
        : org.costPerUtilityMsg; // UTILITY and anything else falls back to the utility rate
    await prisma.whatsAppCostLog.create({
      data: { organizationId, kind: "TEMPLATE", category, costUsd: rate },
    });
  } catch (err) {
    console.error("logWhatsAppTemplateCost failed:", err);
  }
}
