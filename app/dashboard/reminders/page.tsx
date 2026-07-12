import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { formatDate } from "@/lib/formatDate";

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

function statusBadgeClass(status: string) {
  if (status === "DONE") return "bg-accent-light text-accent";
  if (status === "SENT") return "bg-sky-100 text-sky-700";
  return "bg-amber-100 text-amber-700"; // PENDING
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
      <h1 className="text-xl font-semibold text-gray-900">Reminders</h1>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">
        Follow-ups to action for your clients — add one manually below, or the AI creates one automatically
        (from a WhatsApp chat) when a customer asks to be reminded or followed up about something.
      </p>

      <div className="mt-5 rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Add a reminder</h3>
        <form action={addReminder} className="mt-3 flex flex-wrap gap-2">
          <select
            name="clientId"
            required
            className="flex-1 basis-40 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700"
          >
            <option value="">Select client</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            name="title"
            placeholder="e.g. Follow up about delivery"
            required
            className="flex-1 basis-48 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <input
            name="dueDate"
            type="date"
            required
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600"
          />
          <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light">
            Add Reminder
          </button>
        </form>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-xs text-gray-500">
              <th className="px-4 py-3 font-medium">Client</th>
              <th className="px-4 py-3 font-medium">Reminder</th>
              <th className="px-4 py-3 font-medium">Due Date</th>
              <th className="px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {reminders.map((r) => (
              <tr key={r.id} className="border-b border-gray-50 last:border-0">
                <td className="px-4 py-3 font-medium text-gray-900">{r.client.name}</td>
                <td className="px-4 py-3 text-gray-600">{r.title}</td>
                <td className="px-4 py-3 text-gray-600">{formatDate(r.dueDate)}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(r.status)}`}>
                    {r.status}
                  </span>
                </td>
              </tr>
            ))}
            {reminders.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-gray-500" colSpan={4}>
                  No reminders yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
