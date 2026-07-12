import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { readSheetRange } from "@/lib/googleSheets";
import { revalidatePath } from "next/cache";
import { formatDate } from "@/lib/formatDate";
import ConfirmSubmitButton from "@/components/ConfirmSubmitButton";

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
  const dobRaw = (formData.get("dateOfBirth") as string) || "";
  const tagsRaw = (formData.get("tags") as string) || "";

  if (!name || !phone) return;

  const dob = dobRaw ? new Date(dobRaw) : undefined;

  const client = await prisma.client.create({
    data: {
      organizationId: user.organizationId, // always from session, never from form input
      name,
      phone,
      email,
      address,
      dateOfBirth: dob && !isNaN(dob.getTime()) ? dob : undefined,
      tags: parseTags(tagsRaw),
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
  const dobRaw = (formData.get("dateOfBirth") as string) || "";
  const tagsRaw = (formData.get("tags") as string) || "";
  if (!clientId || !name || !phone) return;

  const existing = await prisma.client.findFirst({
    where: { id: clientId, organizationId: user.organizationId },
  });
  if (!existing) return;

  const dob = dobRaw ? new Date(dobRaw) : undefined;

  await prisma.client.update({
    where: { id: clientId },
    data: {
      name,
      phone,
      email: email || null,
      address: address || null,
      dateOfBirth: dob && !isNaN(dob.getTime()) ? dob : null,
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

function initialOf(name: string) {
  return (name?.trim()?.[0] ?? "?").toUpperCase();
}

const AVATAR_COLORS = ["bg-emerald-500", "bg-sky-500", "bg-amber-500", "bg-violet-500", "bg-rose-500"];
function avatarColor(seed: string) {
  const idx = seed.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % AVATAR_COLORS.length;
  return AVATAR_COLORS[idx];
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
        <form action={addClient} className="mt-3 flex flex-wrap gap-2">
          <input name="name" placeholder="Name" required className="flex-1 basis-40 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <input name="phone" placeholder="Phone (with country code)" required className="flex-1 basis-40 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <input name="email" placeholder="Email (optional)" className="flex-1 basis-40 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <input name="address" placeholder="Address (optional)" className="flex-1 basis-48 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <input name="dateOfBirth" type="date" title="Date of birth (optional)" className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600" />
          <input name="tags" placeholder="Tags, comma separated (optional)" className="flex-1 basis-40 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light">
            Add Client
          </button>
        </form>
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

      <div className="mt-4 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-xs text-gray-500">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Phone</th>
              <th className="px-4 py-3 font-medium">Address</th>
              <th className="px-4 py-3 font-medium">Date of Birth</th>
              <th className="px-4 py-3 font-medium">Tags</th>
              <th className="px-4 py-3 font-medium">Interested In</th>
              <th className="px-4 py-3 font-medium">Added</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} className="border-b border-gray-50 align-top last:border-0">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${avatarColor(c.name)}`}>
                      {initialOf(c.name)}
                    </div>
                    <span className="font-medium text-gray-900">{c.name}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-gray-600">{c.phone}</td>
                <td className="max-w-[180px] truncate px-4 py-3 text-gray-600" title={c.address ?? ""}>
                  {c.address || "—"}
                </td>
                <td className="px-4 py-3 text-gray-600">{c.dateOfBirth ? formatDate(c.dateOfBirth) : "—"}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {c.tags.length > 0
                      ? c.tags.map((t) => (
                          <span key={t} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                            {t}
                          </span>
                        ))
                      : <span className="text-gray-400">—</span>}
                  </div>
                </td>
                <td className="max-w-[200px] px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {c.productInterests.length > 0
                      ? c.productInterests.map((pi) => (
                          <span
                            key={pi.id}
                            title={pi.note ?? ""}
                            className="rounded-full bg-sky-50 px-2 py-0.5 text-xs text-sky-700"
                          >
                            {pi.product.name}
                          </span>
                        ))
                      : <span className="text-gray-400">—</span>}
                  </div>
                </td>
                <td className="px-4 py-3 text-gray-500">{formatDate(c.createdAt)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <details className="relative">
                      <summary className="cursor-pointer select-none rounded-lg border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50">
                        Edit
                      </summary>
                      <form
                        action={updateClient}
                        className="absolute right-0 z-10 mt-1 flex w-64 flex-col gap-1.5 rounded-lg border border-gray-200 bg-white p-3 shadow-lg"
                      >
                        <input type="hidden" name="clientId" value={c.id} />
                        <input name="name" defaultValue={c.name} required placeholder="Name" className="rounded border border-gray-300 px-2 py-1 text-xs" />
                        <input name="phone" defaultValue={c.phone} required placeholder="Phone" className="rounded border border-gray-300 px-2 py-1 text-xs" />
                        <input name="email" defaultValue={c.email ?? ""} placeholder="Email" className="rounded border border-gray-300 px-2 py-1 text-xs" />
                        <input name="address" defaultValue={c.address ?? ""} placeholder="Address" className="rounded border border-gray-300 px-2 py-1 text-xs" />
                        <input
                          name="dateOfBirth"
                          type="date"
                          defaultValue={c.dateOfBirth ? c.dateOfBirth.toISOString().slice(0, 10) : ""}
                          className="rounded border border-gray-300 px-2 py-1 text-xs"
                        />
                        <input name="tags" defaultValue={c.tags.join(", ")} placeholder="Tags, comma separated" className="rounded border border-gray-300 px-2 py-1 text-xs" />
                        <button type="submit" className="mt-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-white hover:bg-primary-light">
                          Save Changes
                        </button>
                      </form>
                    </details>
                    <form action={deleteClient}>
                      <input type="hidden" name="clientId" value={c.id} />
                      <ConfirmSubmitButton
                        label="Delete"
                        confirmText={`Delete "${c.name}"? This can't be undone. (Clients with conversation/reminder history can't be deleted.)`}
                        className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                      />
                    </form>
                  </div>
                </td>
              </tr>
            ))}
            {clients.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-gray-500" colSpan={8}>
                  {q ? "No clients match your search." : "No clients yet — add your first one above."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
