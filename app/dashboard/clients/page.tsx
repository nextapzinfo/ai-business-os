import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { readSheetRange } from "@/lib/googleSheets";
import { revalidatePath } from "next/cache";
import AddClientForm from "@/components/AddClientForm";
import ClientRow from "@/components/ClientRow";

// Vercel: importing many customer rows can take a moment.
export const maxDuration = 60;

function parseTags(input: string | null): string[] {
  if (!input) return [];
  return input
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

async function importClientsFromSheet(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const spreadsheetId = formData.get("spreadsheetId") as string;
  const range = formData.get("range") as string;
  if (!spreadsheetId || !range) return;

  let rows: string[][] = [];
  try {
    rows = await readSheetRange(spreadsheetId, range);
  } catch (err) {
    console.error("Customer Sheet import failed:", err);
    return;
  }

  // Expected columns: Name | Phone | Email | Date of Birth (YYYY-MM-DD) | Tags (comma-separated) — last two optional
  let imported = 0;
  for (const row of rows) {
    const [name, phone, email, dob, tagsRaw] = row;
    if (!name?.trim() || !phone?.trim()) continue;

    const existing = await prisma.client.findFirst({
      where: { organizationId: user.organizationId, phone: phone.trim() },
    });
    if (existing) continue; // skip duplicates by phone

    const parsedDob = dob?.trim() ? new Date(dob.trim()) : undefined;

    await prisma.client.create({
      data: {
        organizationId: user.organizationId,
        name: name.trim(),
        phone: phone.trim(),
        email: email?.trim() || undefined,
        dateOfBirth: parsedDob && !isNaN(parsedDob.getTime()) ? parsedDob : undefined,
        tags: parseTags(tagsRaw),
        source: "IMPORTED",
      },
    });
    imported++;
  }

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "CUSTOMER_SHEET_IMPORTED",
    metadata: { spreadsheetId, range, imported, totalRows: rows.length },
  });

  revalidatePath("/dashboard/clients");
}

async function addClient(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const name = formData.get("name") as string;
  const phone = formData.get("phone") as string;
  const email = (formData.get("email") as string) || undefined;
  const address = (formData.get("address") as string)?.trim() || undefined;
  const pinCode = (formData.get("pinCode") as string)?.trim() || undefined;
  const interestedIn = (formData.get("interestedIn") as string)?.trim() || undefined;
  const tagsRaw = (formData.get("tags") as string) || "";

  if (!name || !phone) return;

  const client = await prisma.client.create({
    data: {
      organizationId: user.organizationId, // always from session, never from form input
      name,
      phone,
      email,
      address,
      pinCode,
      interestedIn,
      tags: parseTags(tagsRaw),
      source: "MANUAL",
    },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "CLIENT_CREATED",
    metadata: { clientId: client.id, name, phone },
  });

  revalidatePath("/dashboard/clients");
}

async function updateClient(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const clientId = formData.get("clientId") as string;
  const name = (formData.get("name") as string)?.trim();
  const phone = (formData.get("phone") as string)?.trim();
  const email = (formData.get("email") as string)?.trim();
  const address = (formData.get("address") as string)?.trim();
  const pinCode = (formData.get("pinCode") as string)?.trim();
  const interestedIn = (formData.get("interestedIn") as string)?.trim();
  const tagsRaw = (formData.get("tags") as string) || "";
  if (!clientId || !name || !phone) return;

  const existing = await prisma.client.findFirst({
    where: { id: clientId, organizationId: user.organizationId },
  });
  if (!existing) return;

  await prisma.client.update({
    where: { id: clientId },
    data: {
      name,
      phone,
      email: email || null,
      address: address || null,
      pinCode: pinCode || null,
      interestedIn: interestedIn || null,
      tags: parseTags(tagsRaw),
    },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "CLIENT_UPDATED",
    metadata: { clientId },
  });

  revalidatePath("/dashboard/clients");
}

async function deleteClient(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const clientId = formData.get("clientId") as string;
  const client = await prisma.client.findFirst({
    where: { id: clientId, organizationId: user.organizationId },
  });
  if (!client) return;

  // Clients with existing conversations/reminders/broadcast history are kept
  // (deleting would either fail on the foreign key or silently lose records)
  // — only clean, unused client rows can be removed this way.
  const [conversationCount, reminderCount, broadcastCount] = await Promise.all([
    prisma.conversation.count({ where: { clientId } }),
    prisma.reminder.count({ where: { clientId } }),
    prisma.broadcastRecipient.count({ where: { clientId } }),
  ]);
  if (conversationCount > 0 || reminderCount > 0 || broadcastCount > 0) {
    console.error(`Client ${clientId} not deleted — has existing conversation/reminder/broadcast history.`);
    return;
  }

  await prisma.client.delete({ where: { id: clientId } });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "CLIENT_DELETED",
    metadata: { clientId, name: client.name },
  });

  revalidatePath("/dashboard/clients");
}

// Human-readable label + badge color for Client.source. Falls back to
// treating any unrecognized value (or old rows from before this field
// existed, which default to "WHATSAPP_DIRECT" at the DB level) sensibly.
const SOURCE_LABELS: Record<string, { label: string; className: string }> = {
  WHATSAPP_DIRECT: { label: "WhatsApp", className: "bg-emerald-50 text-emerald-700" },
  FACEBOOK_AD: { label: "Facebook Ad", className: "bg-blue-50 text-blue-700" },
  FACEBOOK_POST: { label: "Facebook Post", className: "bg-blue-50 text-blue-700" },
  INSTAGRAM_AD: { label: "Instagram Ad", className: "bg-pink-50 text-pink-700" },
  INSTAGRAM_POST: { label: "Instagram Post", className: "bg-pink-50 text-pink-700" },
  WEBSITE: { label: "Website", className: "bg-violet-50 text-violet-700" },
  MANUAL: { label: "Manual", className: "bg-gray-100 text-gray-600" },
  IMPORTED: { label: "Imported", className: "bg-gray-100 text-gray-600" },
};
function formatSource(source: string) {
  return SOURCE_LABELS[source] ?? { label: source, className: "bg-gray-100 text-gray-600" };
}

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const user = await getCurrentUser();
  if (!user) return null;

  const q = searchParams?.q?.trim();

  const clients = await prisma.client.findMany({
    where: {
      organizationId: user.organizationId,
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { phone: { contains: q } },
            ],
          }
        : {}),
    },
    include: {
      productInterests: {
        include: { product: { select: { name: true } } },
        orderBy: { updatedAt: "desc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">Clients</h1>
        <form action="/dashboard/clients" className="flex items-center gap-2">
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="Search name or phone..."
            className="w-56 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-primary focus:outline-none"
          />
          <button type="submit" className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">
            Search
          </button>
        </form>
      </div>

      <div className="mt-5 rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Add a client</h3>
        <AddClientForm action={addClient} />
      </div>

      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Bulk import from Google Sheet</h3>
        <form action={importClientsFromSheet} className="mt-3 flex flex-wrap gap-2">
          <input
            name="spreadsheetId"
            placeholder="Spreadsheet ID (from the Sheet's URL)"
            required
            className="flex-1 basis-56 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <input
            name="range"
            placeholder="Range, e.g. Sheet1!A2:E200 (skip header row)"
            required
            className="flex-1 basis-56 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light">
            Import Customers
          </button>
        </form>
        <p className="mt-2 text-xs text-gray-500">
          Column order: Name | Phone | Email | Date of Birth (optional, YYYY-MM-DD) | Tags (optional,
          comma-separated). Existing phone numbers are skipped automatically.
        </p>
      </div>

      {/* Every field below is directly editable in place (2026-08-28, owner's
          own request — see ClientRow.tsx for the full reasoning), so this
          table is naturally wider than a phone screen. `overflow-hidden`
          above (kept for the rounded corners) was clipping the table
          entirely on mobile with no way to reach it — owner's own report:
          "Client : Mobile e sob dakha jachhe na - Source r pore ar asche
          na" (on mobile, everything after Source isn't showing). Fix: the
          rounding/border stays on this outer div, and a nested
          `overflow-x-auto` div lets the table itself scroll horizontally
          instead of being cut off. */}
      <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs text-gray-500">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Phone</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Address</th>
                <th className="px-4 py-3 font-medium">Pin Code</th>
                <th className="px-4 py-3 font-medium">Tags</th>
                <th className="px-4 py-3 font-medium">Interested In</th>
                <th className="px-4 py-3 font-medium">Added</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <ClientRow
                  key={c.id}
                  client={c}
                  sourceLabel={formatSource(c.source)}
                  sourceDetail={c.sourceDetail}
                  updateClient={updateClient}
                  deleteClient={deleteClient}
                />
              ))}
              {clients.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-gray-500" colSpan={10}>
                    {q ? "No clients match your search." : "No clients yet — add your first one above."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
