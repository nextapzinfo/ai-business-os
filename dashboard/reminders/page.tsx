import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

async function addReminder(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const clientId = formData.get("clientId") as string;
  const title = formData.get("title") as string;
  const dueDate = formData.get("dueDate") as string;

  if (!clientId || !title || !dueDate) return;

  // Confirm the client actually belongs to this org before attaching a reminder —
  // never trust a form-submitted clientId on its own (tenant isolation "forbidden rule").
  const client = await prisma.client.findFirst({
    where: { id: clientId, organizationId: user.organizationId },
  });
  if (!client) return;

  const reminder = await prisma.reminder.create({
    data: {
      organizationId: user.organizationId,
      clientId,
      title,
      dueDate: new Date(dueDate),
    },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "REMINDER_CREATED",
    metadata: { reminderId: reminder.id, clientId, title },
  });

  revalidatePath("/dashboard/reminders");
}

export default async function RemindersPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const [reminders, clients] = await Promise.all([
    prisma.reminder.findMany({
      where: { organizationId: user.organizationId },
      include: { client: true },
      orderBy: { dueDate: "asc" },
    }),
    prisma.client.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, name: true },
    }),
  ]);

  return (
    <div>
      <h1>Reminders</h1>
      <p style={{ color: "#666", fontSize: 14 }}>
        GST/ITR deadlines and other client reminders. Automatic WhatsApp sending
        comes in Phase 4 — for now these are tracked here.
      </p>

      <form
        action={addReminder}
        style={{ display: "flex", gap: 8, margin: "16px 0", flexWrap: "wrap" }}
      >
        <select name="clientId" required style={inputStyle}>
          <option value="">Select client</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input name="title" placeholder="e.g. GST Return Due" required style={inputStyle} />
        <input name="dueDate" type="date" required style={inputStyle} />
        <button type="submit" style={buttonStyle}>
          Add Reminder
        </button>
      </form>

      <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e5e5" }}>
            <th style={thStyle}>Client</th>
            <th style={thStyle}>Title</th>
            <th style={thStyle}>Due Date</th>
            <th style={thStyle}>Status</th>
          </tr>
        </thead>
        <tbody>
          {reminders.map((r) => (
            <tr key={r.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
              <td style={tdStyle}>{r.client.name}</td>
              <td style={tdStyle}>{r.title}</td>
              <td style={tdStyle}>{r.dueDate.toLocaleDateString()}</td>
              <td style={tdStyle}>{r.status}</td>
            </tr>
          ))}
          {reminders.length === 0 && (
            <tr>
              <td style={tdStyle} colSpan={4}>
                No reminders yet.
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
  flex: "1 1 160px",
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
