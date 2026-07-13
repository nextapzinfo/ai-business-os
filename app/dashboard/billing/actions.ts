"use server";

import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

// Only the assumptions an owner can actually change: the manual USD->INR
// conversion, and the per-message WhatsApp template rates used to ESTIMATE
// cost (Meta's true bill depends on the recipient's country and can change —
// this is deliberately editable so the estimate can be kept close to reality
// without a code change). OpenAI cost is never editable here since it's
// computed exactly from real token usage at the published per-token rate.
export async function updateBillingRates(formData: FormData) {
  const user = await getCurrentUser();
  if (!user || user.role === "STAFF") return; // rate assumptions are an owner/admin decision

  const usdToInrRate = parseFloat(formData.get("usdToInrRate") as string);
  const costPerMarketingMsg = parseFloat(formData.get("costPerMarketingMsg") as string);
  const costPerUtilityMsg = parseFloat(formData.get("costPerUtilityMsg") as string);
  const costPerAuthMsg = parseFloat(formData.get("costPerAuthMsg") as string);
  const costPerConversation = parseFloat(formData.get("costPerConversation") as string);

  const values = [usdToInrRate, costPerMarketingMsg, costPerUtilityMsg, costPerAuthMsg, costPerConversation];
  if (values.some((n) => Number.isNaN(n) || n < 0)) return;

  await prisma.organization.update({
    where: { id: user.organizationId },
    data: { usdToInrRate, costPerMarketingMsg, costPerUtilityMsg, costPerAuthMsg, costPerConversation },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "BILLING_RATES_UPDATED",
    metadata: { usdToInrRate, costPerMarketingMsg, costPerUtilityMsg, costPerAuthMsg, costPerConversation },
  });

  revalidatePath("/dashboard/billing");
}
