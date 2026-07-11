import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import AgentStudioClient from "@/components/AgentStudioClient";
import type { AgentProfileData } from "./actions";

export const dynamic = "force-dynamic";

export default async function AgentStudioPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const profile = await prisma.agentProfile.findUnique({
    where: { organizationId: user.organizationId },
  });

  const initialProfile: AgentProfileData = {
    businessName: profile?.businessName ?? "",
    greetingMessage: profile?.greetingMessage ?? "",
    businessDescription: profile?.businessDescription ?? "",
    tone: profile?.tone ?? "friendly",
    languageStyle: profile?.languageStyle ?? "mixed",
    skillOrderConfirm: profile?.skillOrderConfirm ?? false,
    skillReminders: profile?.skillReminders ?? false,
  };

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">Agent Studio</h1>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">
        Configure how the WhatsApp AI presents itself and behaves. Changes take effect immediately for real
        customers once saved — use the Test Sandbox on the right to try things first.
      </p>

      <div className="mt-5">
        <AgentStudioClient initialProfile={initialProfile} />
      </div>
    </div>
  );
}
