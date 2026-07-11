import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import AgentStudioClient from "@/components/AgentStudioClient";
import type { AgentProfileData } from "./actions";

export const dynamic = "force-dynamic";

export default async function AgentStudioPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const [profile, documents] = await Promise.all([
    prisma.agentProfile.findUnique({
      where: { organizationId: user.organizationId },
    }),
    prisma.document.findMany({
      where: { organizationId: user.organizationId },
      include: { product: { select: { id: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const initialProfile: AgentProfileData = {
    businessName: profile?.businessName ?? "",
    greetingMessage: profile?.greetingMessage ?? "",
    businessDescription: profile?.businessDescription ?? "",
    tone: profile?.tone ?? "friendly",
    languageStyle: profile?.languageStyle ?? "mixed",
    skillOrderConfirm: profile?.skillOrderConfirm ?? false,
    skillReminders: profile?.skillReminders ?? false,
  };

  const initialDocuments = documents.map((d) => ({
    id: d.id,
    title: d.title,
    status: d.status,
    createdAt: d.createdAt.toISOString(),
    linkedToProduct: !!d.product,
  }));

  return (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0">
        <h1 className="text-xl font-semibold text-gray-900">Agent Studio</h1>
        <p className="mt-1 max-w-2xl text-sm text-gray-500">
          Configure how the WhatsApp AI presents itself, sounds, and what it knows. Changes take effect
          immediately for real customers once saved — use the Test Sandbox to try things first.
        </p>
      </div>

      <div className="mt-5 flex-1">
        <AgentStudioClient initialProfile={initialProfile} initialDocuments={initialDocuments} />
      </div>
    </div>
  );
}
