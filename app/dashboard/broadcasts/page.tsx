import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { sendWhatsAppTemplateMessage } from "@/lib/whatsapp";
import { revalidatePath } from "next/cache";
import { formatDate } from "@/lib/formatDate";
import ClientCheckboxList from "./ClientCheckboxList";

// Vercel: allow this action longer than the default 10s, since it sends
// one WhatsApp message per recipient in a loop.
export const maxDuration = 60;

async function createBroadcast(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const name = formData.get("name") as string;
  const templateId = formData.get("templateId") as string;
  const clientIds = formData.getAll("clientIds") as string[];
  if (!name || !templateId || clientIds.length === 0) return;

  const template = await prisma.messageTemplate.findFirst({
    where: { id: templateId, organizationId: user.organizationId, status: "APPROVED" },
  });
  if (!template) return; // only Meta-approved templates can be broadcast

  const broadcast = await prisma.broadcast.create({
    data: {
      organizationId: user.organizationId,
      templateId: template.id,
      name,
      status: "SENDING",
    },
  });

  const clients = await prisma.client.findMany({
    where: { id: { in: clientIds }, organizationId: user.organizationId },
  });

  const hasVariable = template.bodyText.includes("{{1}}");
  let anyFailed = false;

  for (const client of clients) {
    const recipient = await prisma.broadcastRecipient.create({
      data: { broadcastId: broadcast.id, clientId: client.id, status: "PENDING" },
    });
    try {
      await sendWhatsAppTemplateMessage(
        client.phone,
        template.metaTemplateName,
        template.language,
        hasVariable ? [client.name] : [],
        template.headerType === "IMAGE" ? template.headerImageUrl ?? undefined : undefined
      );
      await prisma.broadcastRecipient.update({
        where: { id: recipient.id },
        data: { status: "SENT", sentAt: new Date() },
      });
    } catch (err) {
      anyFailed = true;
      await prisma.broadcastRecipient.update({
        where: { id: recipient.id },
        data: { status: "FAILED", errorMessage: String(err) },
      });
      console.error("Broadcast send failed for client", client.id, err);
    }
  }

  await prisma.broadcast.update({
    where: { id: broadcast.id },
    data: { status: anyFailed ? "FAILED" : "SENT" },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "BROADCAST_SENT",
    metadata: { broadcastId: broadcast.id, templateId: template.id, recipientCount: clients.length },
  });

  revalidatePath("/dashboard/broadcasts");
}

function statusBadgeClass(status: string) {
  if (status === "SENT") return "bg-emerald-100 text-emerald-700";
  if (status === "FAILED") return "bg-red-100 text-red-700";
  return "bg-amber-100 text-amber-700";
}

export default async function BroadcastsPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const [approvedTemplates, clients, broadcasts] = await Promise.all([
    prisma.messageTemplate.findMany({
      where: { organizationId: user.organizationId, status: "APPROVED" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.client.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { name: "asc" },
    }),
    prisma.broadcast.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: "desc" },
      include: {
        template: true,
        recipients: true,
      },
    }),
  ]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">Broadcasts</h1>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">
        Send an approved template message to many customers at once. Only templates approved by
        Meta show up below — <a href="/dashboard/templates" className="text-primary underline">create/check templates here</a>.
      </p>

      {approvedTemplates.length === 0 ? (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          No approved templates yet. Create one on the Templates page and wait for Meta approval
          before you can send a broadcast.
        </p>
      ) : (
        <div className="mt-5 max-w-xl rounded-xl border border-gray-200 bg-white p-4">
          <form action={createBroadcast}>
            <div className="flex flex-col gap-2">
              <input name="name" placeholder="Broadcast name (e.g. Eid Offer - July)" required className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              <select name="templateId" required defaultValue="" className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="" disabled>
                  Select an approved template
                </option>
                {approvedTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.language})
                  </option>
                ))}
              </select>
            </div>

            <h4 className="mb-2 mt-4 text-sm font-semibold text-gray-900">Recipients</h4>
            <ClientCheckboxList clients={clients} />

            <button type="submit" className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light">
              Send Broadcast
            </button>
          </form>
        </div>
      )}

      <h3 className="mt-6 text-sm font-semibold text-gray-900">Past broadcasts</h3>
      <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-xs text-gray-500">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Template</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Sent / Failed / Total</th>
              <th className="px-4 py-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {broadcasts.map((b) => {
              const sent = b.recipients.filter((r) => r.status === "SENT").length;
              const failed = b.recipients.filter((r) => r.status === "FAILED").length;
              return (
                <tr key={b.id} className="border-b border-gray-50 last:border-0">
                  <td className="px-4 py-3 font-medium text-gray-900">{b.name}</td>
                  <td className="px-4 py-3 text-gray-600">{b.template.name}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusBadgeClass(b.status)}`}>{b.status}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {sent} / {failed} / {b.recipients.length}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(b.createdAt)}</td>
                </tr>
              );
            })}
            {broadcasts.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-gray-500" colSpan={5}>
                  No broadcasts yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
