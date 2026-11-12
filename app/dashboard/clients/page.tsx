import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { readSheetRange } from "@/lib/googleSheets";
import { revalidatePath } from "next/cache";
import { formatDateTime } from "@/lib/formatDate";
import AddClientForm from "@/components/AddClientForm";
import ClientRow from "@/components/ClientRow";
import { AUTO_TAGS, AUTO_TAG_HELP, AUTO_TAG_STYLES, refreshOrgAutoTags } from "@/lib/auto-tags";
import { chatTagBackfillStatus } from "@/lib/chat-tags";
import { chatTagHelp, chatTagRank, chatTagStyle } from "@/lib/chat-tag-styles";
import ChatTagBackfillButton from "@/components/ChatTagBackfillButton";

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

// CRM Step 2 — save the auto-tag rules (Organization.crm*) and recalculate.
async function saveAutoTagRules(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;
  const num = (key: string, min: number, max: number, fallback: number) => {
    const n = Math.round(Number(formData.get(key)));
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  };
  await prisma.organization.update({
    where: { id: user.organizationId },
    data: {
      crmRegularGapDays: num("crmRegularGapDays", 7, 365, 35),
      crmVipSpend: num("crmVipSpend", 100, 10000000, 5000),
      crmInactiveDays: num("crmInactiveDays", 14, 730, 60),
    },
  });
  await refreshOrgAutoTags(user.organizationId);
  await logAudit({ organizationId: user.organizationId, userId: user.id, action: "CRM_AUTO_TAG_RULES_UPDATED", metadata: {} });
  revalidatePath("/dashboard/clients");
}

async function recalculateAutoTags() {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;
  await refreshOrgAutoTags(user.organizationId);
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
  EVENT: { label: "Event", className: "bg-amber-50 text-amber-800" },
  MANUAL: { label: "Manual", className: "bg-gray-100 text-gray-600" },
  IMPORTED: { label: "Imported", className: "bg-gray-100 text-gray-600" },
};
function formatSource(source: string) {
  return SOURCE_LABELS[source] ?? { label: source, className: "bg-gray-100 text-gray-600" };
}

// ClientOrder.itemsJson is stored as a plain JSON array (see
// app/api/integrations/banglardoi/order-sync/route.ts) — reshaped into a
// typed array here the same way parseFeeTiers-style helpers elsewhere in
// this codebase guard against malformed/legacy rows rather than trusting
// `Json` at face value.
function parseOrderItems(raw: unknown): { productName: string; variantLabel: string | null; quantity: number; unitPriceInRupees: number; totalPriceInRupees: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (i): i is Record<string, unknown> =>
        typeof i === "object" && i !== null && typeof (i as Record<string, unknown>).productName === "string"
    )
    .map((i) => ({
      productName: String(i.productName),
      variantLabel: typeof i.variantLabel === "string" ? i.variantLabel : null,
      quantity: Number(i.quantity) || 0,
      unitPriceInRupees: Number(i.unitPriceInRupees) || 0,
      totalPriceInRupees: Number(i.totalPriceInRupees) || 0,
    }));
}

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: { q?: string; tag?: string };
}) {
  const user = await getCurrentUser();
  if (!user) return null;

  const q = searchParams?.q?.trim();
  // ?tag=VIP — show only customers carrying that tag (automatic or typed).
  const tag = searchParams?.tag?.trim();

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
      ...(tag ? { AND: [{ OR: [{ autoTags: { has: tag } }, { chatTags: { has: tag } }, { tags: { has: tag } }] }] } : {}),
    },
    include: {
      productInterests: {
        include: { product: { select: { name: true } } },
        orderBy: { updatedAt: "desc" },
      },
      // Most recent conversation only (request 3 — clicking a client's phone
      // number jumps straight into their WhatsApp chat). Conversation has no
      // updatedAt column; a client's conversation is reopened/reused across
      // many days rather than a fresh row per chat (see
      // conversations/layout.tsx), so in practice there's rarely more than
      // one anyway — createdAt desc + take 1 is "most recent" either way.
      conversations: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true } },
      // Real banglardoi.com order history (request 2) — synced in by
      // src/lib/ai-business-os-sync.ts on that repo's side; see ClientOrder
      // in schema.prisma for why this is a separate model from the existing
      // (unrelated, in-WhatsApp) Order.
      websiteOrders: {
        orderBy: { placedAt: "desc" },
        select: { id: true, orderNumber: true, status: true, totalInRupees: true, placedAt: true, itemsJson: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const clientRows = clients.map((c) => ({
    ...c,
    conversationId: c.conversations[0]?.id ?? null,
    orders: c.websiteOrders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      totalInRupees: o.totalInRupees,
      placedAt: o.placedAt,
      items: parseOrderItems(o.itemsJson),
    })),
  }));

  // Auto-tag counts for the filter chips (whole org) and the current rules.
  const [tagCounts, org, totalClients, lastTagRun, chatTagRows, chatStatus] = await Promise.all([
    Promise.all(
      AUTO_TAGS.map(async (t) => ({
        tag: t,
        count: await prisma.client.count({ where: { organizationId: user.organizationId, autoTags: { has: t } } }),
      }))
    ),
    prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { crmRegularGapDays: true, crmVipSpend: true, crmInactiveDays: true },
    }),
    prisma.client.count({ where: { organizationId: user.organizationId } }),
    prisma.client.findFirst({
      where: { organizationId: user.organizationId, autoTagsUpdatedAt: { not: null } },
      orderBy: { autoTagsUpdatedAt: "desc" },
      select: { autoTagsUpdatedAt: true },
    }),
    prisma.client.findMany({
      where: { organizationId: user.organizationId, NOT: { chatTags: { isEmpty: true } } },
      select: { chatTags: true },
    }),
    chatTagBackfillStatus(user.organizationId),
  ]);

  // Chat-tag chips (CRM Step 2b): count every tag, then show action tags
  // first and only the most common products / areas so the row stays short.
  const chatCounts = new Map<string, number>();
  for (const r of chatTagRows) for (const t of r.chatTags) chatCounts.set(t, (chatCounts.get(t) ?? 0) + 1);
  const chatChips = (() => {
    const all = [...chatCounts.entries()].map(([t, count]) => ({ tag: t, count }));
    const pick = (prefix: string, max: number) =>
      all.filter((c) => c.tag.startsWith(prefix)).sort((a, b) => b.count - a.count).slice(0, max);
    const fixed = all.filter((c) => !c.tag.startsWith("Interested:") && !c.tag.startsWith("Area:"));
    return [...fixed, ...pick("Interested:", 8), ...pick("Area:", 6)].sort(
      (a, b) => chatTagRank(a.tag) - chatTagRank(b.tag) || b.count - a.count
    );
  })();
  const chipHref = (t?: string) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (t) params.set("tag", t);
    const qs = params.toString();
    return `/dashboard/clients${qs ? `?${qs}` : ""}`;
  };

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
          {tag && <input type="hidden" name="tag" value={tag} />}
          <button type="submit" className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50">
            Search
          </button>
        </form>
      </div>

      {/* CRM Step 2 — automatic tag filters */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <a
          href={chipHref()}
          className={`rounded-full px-3 py-1 text-xs font-medium ${!tag ? "bg-primary text-white" : "border border-gray-300 bg-white text-gray-600 hover:bg-gray-50"}`}
        >
          All ({totalClients})
        </a>
        {tagCounts.map(({ tag: t, count }) => (
          <a
            key={t}
            href={chipHref(t)}
            title={AUTO_TAG_HELP[t]}
            className={`rounded-full px-3 py-1 text-xs font-medium ${tag === t ? "bg-primary text-white" : AUTO_TAG_STYLES[t]}`}
          >
            {t} ({count})
          </a>
        ))}
        {tag && !(AUTO_TAGS as readonly string[]).includes(tag) && !chatChips.some((c) => c.tag === tag) && (
          <span className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-white">Tag: {tag}</span>
        )}
      </div>

      {/* CRM Step 2b — tags the AI read from WhatsApp chats */}
      {chatChips.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-gray-500">From chats:</span>
          {chatChips.map(({ tag: t, count }) => (
            <a
              key={t}
              href={chipHref(t)}
              title={chatTagHelp(t)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${tag === t ? "bg-primary text-white" : chatTagStyle(t)}`}
            >
              {t} ({count})
            </a>
          ))}
        </div>
      )}

      <details className="mt-3 rounded-xl border border-gray-200 bg-white" open={chatStatus.pending > 0}>
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-gray-900">
          Chat tags — AI reads WhatsApp chats
          <span className="ml-2 text-xs font-normal text-gray-500">
            {chatStatus.pending > 0 ? `${chatStatus.pending} customers' old chats not read yet` : "all chats read · new messages are tagged instantly"}
          </span>
        </summary>
        <div className="border-t border-gray-100 p-4">
          <p className="mb-3 text-xs text-gray-500">
            The AI reads each customer&apos;s WhatsApp chat and tags what they asked about:{" "}
            <b>Interested: product</b> · <b>Price asked – not bought</b> · <b>Bulk / Corporate</b> · <b>Occasion</b> (wedding, birthday, puja…) ·{" "}
            <b>Complaint</b> (until it&apos;s resolved) · <b>Area</b>. Press the button once to read all old chats; after that every new customer
            message updates the tags straight away. &quot;Price asked – not bought&quot; disappears by itself when they order.
          </p>
          <ChatTagBackfillButton total={chatStatus.total} pending={chatStatus.pending} />
        </div>
      </details>

      <details className="mt-3 rounded-xl border border-gray-200 bg-white">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-gray-900">
          Automatic tag rules
          <span className="ml-2 text-xs font-normal text-gray-500">
            {lastTagRun?.autoTagsUpdatedAt ? `last updated ${formatDateTime(lastTagRun.autoTagsUpdatedAt)}` : "not calculated yet — press Recalculate now"}
          </span>
        </summary>
        <div className="border-t border-gray-100 p-4">
          <p className="mb-3 text-xs text-gray-500">
            These tags are set by the system from real orders (WhatsApp + website) and refresh every night and after every order.
            Your own typed tags are never changed. <b>New</b> = first order in the last 30 days · <b>Lead</b> = chatted but never ordered.
          </p>
          <form action={saveAutoTagRules} className="grid gap-3 sm:grid-cols-4 sm:items-end">
            <label className="text-xs font-medium text-gray-600">
              <span className={`mr-1 rounded-full px-2 py-0.5 ${AUTO_TAG_STYLES.Regular}`}>Regular</span> orders at least every
              <span className="mt-1 flex items-center gap-1">
                <input name="crmRegularGapDays" type="number" min={7} max={365} defaultValue={org?.crmRegularGapDays ?? 35} className="w-20 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
                days
              </span>
            </label>
            <label className="text-xs font-medium text-gray-600">
              <span className={`mr-1 rounded-full px-2 py-0.5 ${AUTO_TAG_STYLES.VIP}`}>VIP</span> total spent at least
              <span className="mt-1 flex items-center gap-1">
                ₹<input name="crmVipSpend" type="number" min={100} defaultValue={org?.crmVipSpend ?? 5000} className="w-28 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
              </span>
            </label>
            <label className="text-xs font-medium text-gray-600">
              <span className={`mr-1 rounded-full px-2 py-0.5 ${AUTO_TAG_STYLES.Inactive}`}>Inactive</span> no order for more than
              <span className="mt-1 flex items-center gap-1">
                <input name="crmInactiveDays" type="number" min={14} max={730} defaultValue={org?.crmInactiveDays ?? 60} className="w-20 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
                days
              </span>
            </label>
            <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light">
              Save rules &amp; recalculate
            </button>
          </form>
          <form action={recalculateAutoTags} className="mt-3">
            <button type="submit" className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
              Recalculate now
            </button>
          </form>
        </div>
      </details>

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
                <th className="px-4 py-3 font-medium">Orders</th>
                <th className="px-4 py-3 font-medium">Added</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {clientRows.map((c) => (
                <ClientRow
                  key={c.id}
                  client={c}
                  sourceLabel={formatSource(c.source)}
                  autoTagStyles={AUTO_TAG_STYLES}
                  sourceDetail={c.sourceDetail}
                  conversationId={c.conversationId}
                  updateClient={updateClient}
                  deleteClient={deleteClient}
                />
              ))}
              {clientRows.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-gray-500" colSpan={11}>
                    {q || tag ? "No clients match this search / tag." : "No clients yet — add your first one above."}
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
