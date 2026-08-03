import { prisma } from "@/lib/prisma";

// gpt-4o-mini published per-token pricing (USD) — verified via web search,
// July 2026. If OpenAI changes this, update here; historical AiUsageLog rows
// keep whatever cost was computed at the time, so past days stay accurate.
export const GPT4O_MINI_INPUT_RATE_USD = 0.15 / 1_000_000;
export const GPT4O_MINI_OUTPUT_RATE_USD = 0.6 / 1_000_000;

export function calcOpenAiCostUsd(promptTokens: number, completionTokens: number): number {
  return promptTokens * GPT4O_MINI_INPUT_RATE_USD + completionTokens * GPT4O_MINI_OUTPUT_RATE_USD;
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
