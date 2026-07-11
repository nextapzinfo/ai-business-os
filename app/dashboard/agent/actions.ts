"use server";

import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

export type AgentProfileData = {
  businessName: string;
  greetingMessage: string;
  businessDescription: string;
  tone: string;
  languageStyle: string;
  skillOrderConfirm: boolean;
  skillReminders: boolean;
};

export async function saveAgentProfile(data: AgentProfileData) {
  const user = await getCurrentUser();
  if (!user) return;

  await prisma.agentProfile.upsert({
    where: { organizationId: user.organizationId },
    update: { ...data },
    create: { organizationId: user.organizationId, ...data },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "AGENT_PROFILE_UPDATED",
  });

  revalidatePath("/dashboard/agent");
}
