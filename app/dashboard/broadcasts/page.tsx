import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { sendWhatsAppTemplateMessage } from "@/lib/whatsapp";
import { revalidatePath } from "next/cache";
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
        hasVariable ? [client.name] : []
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
      <h1>Broadcasts</h1>
      <p style={{ color: "#666", fontSize: 14 }}>
        Send an approved template message to many customers at once. Only
        templates approved by Meta show up below —{" "}
        <a href="/dashboard/templates">create/check templates here</a>.
      </p>

      {approvedTemplates.length === 0 ? (
        <p style={{ marginTop: 16, color: "#991b1b" }}>
          No approved templates yet. Create one on the Templates page and wait
          for Meta approval before you can send a broadcast.
        </p>
      ) : (
        <form action={createBroadcast} style={{ marginTop: 24, maxWidth: 600 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input name="name" placeholder="Broadcast name (e.g. Eid Offer - July)" required style={inputStyle} />
            <select name="templateId" required style={inputStyle} defaultValue="">
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

          <h4 style={{ marginTop: 20, marginBottom: 8 }}>Recipients</h4>
          <ClientCheckboxList clients={clients} />

          <button type="submit" style={{ ...buttonStyle, marginTop: 12 }}>
            Send Broadcast
          </button>
        </form>
      )}

      <h3 style={{ marginTop: 32 }}>Past broadcasts</h3>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          background: "#fff",
          marginTop: 8,
        }}
      >
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e5e5" }}>
            <th style={thStyle}>Name</th>
            <th style={thStyle}>Template</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Sent / Failed / Total</th>
            <th style={thStyle}>Created</th>
          </tr>
        </thead>
        <tbody>
          {broadcasts.map((b) => {
            const sent = b.recipients.filter((r) => r.status === "SENT").length;
            const failed = b.recipients.filter((r) => r.status === "FAILED").length;
            return (
              <tr key={b.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td style={tdStyle}>{b.name}</td>
                <td style={tdStyle}>{b.template.name}</td>
                <td style={tdStyle}>{b.status}</td>
                <td style={tdStyle}>
                  {sent} / {failed} / {b.recipients.length}
                </td>
                <td style={tdStyle}>{b.createdAt.toLocaleDateString()}</td>
              </tr>
            );
          })}
          {broadcasts.length === 0 && (
            <tr>
              <td style={tdStyle} colSpan={5}>
                No broadcasts yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const inputStyle = {
  padding: 8,
  border: "1px solid #ccc",
  borderRadius: 6,
};
const buttonStyle = {
  padding: "8px 16px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
};
const thStyle = { padding: "10px 12px", fontSize: 13, color: "#666" };
const tdStyle = { padding: "10px 12px", fontSize: 14 };