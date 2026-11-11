import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { formatDate, formatDateTime } from "@/lib/formatDate";
import { computeClientMetrics, formatRupees, unifyOrders } from "@/lib/client-metrics";
import { AUTO_TAG_HELP, AUTO_TAG_STYLES } from "@/lib/auto-tags";

// /dashboard/clients/[id] — Customer Profile (CRM Step 1, owner's full-CRM
// plan, 2026-11-11). Everything about one customer on one page: details &
// tags, lifetime numbers (total spent, orders, average order, last order,
// how often they buy), favourite products, every order from BOTH WhatsApp
// and banglardoi.com, AI-tracked product interests, reminders, chats and
// broadcasts received. Numbers come from lib/client-metrics.ts so later CRM
// steps (auto-tags, segments, reports) use exactly the same definitions.

function parseTags(input: string | null): string[] {
  if (!input) return [];
  return Array.from(
    new Set(
      input
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    )
  );
}

async function updateProfile(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;
  const clientId = formData.get("clientId") as string;
  const existing = await prisma.client.findFirst({ where: { id: clientId, organizationId: user.organizationId } });
  if (!existing) return;

  const name = (formData.get("name") as string)?.trim();
  if (!name) return;
  const text = (key: string) => ((formData.get(key) as string) ?? "").trim() || null;

  // Phone is deliberately NOT editable here either — it's the key that
  // matches this client to WhatsApp chats and website orders (same rule as
  // the Clients table, see ClientRow.tsx).
  await prisma.client.update({
    where: { id: clientId },
    data: {
      name,
      email: text("email"),
      address: text("address"),
      pinCode: text("pinCode"),
      interestedIn: text("interestedIn"),
      notes: text("notes"),
      tags: parseTags(formData.get("tags") as string),
    },
  });
  await logAudit({ organizationId: user.organizationId, userId: user.id, action: "CLIENT_UPDATED", metadata: { clientId, from: "profile" } });
  revalidatePath(`/dashboard/clients/${clientId}`);
  revalidatePath("/dashboard/clients");
}

async function addReminder(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;
  const clientId = formData.get("clientId") as string;
  const title = ((formData.get("title") as string) ?? "").trim();
  const dueDate = formData.get("dueDate") as string;
  if (!title || !dueDate) return;
  const client = await prisma.client.findFirst({ where: { id: clientId, organizationId: user.organizationId } });
  if (!client) return;
  const reminder = await prisma.reminder.create({
    data: { organizationId: user.organizationId, clientId, title, dueDate: new Date(dueDate) },
  });
  await logAudit({ organizationId: user.organizationId, userId: user.id, action: "REMINDER_CREATED", metadata: { reminderId: reminder.id, clientId, title } });
  revalidatePath(`/dashboard/clients/${clientId}`);
  revalidatePath("/dashboard/reminders");
}

async function completeReminder(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;
  const reminderId = formData.get("reminderId") as string;
  const reminder = await prisma.reminder.findFirst({ where: { id: reminderId, organizationId: user.organizationId } });
  if (!reminder) return;
  await prisma.reminder.update({ where: { id: reminderId }, data: { status: "DONE" } });
  revalidatePath(`/dashboard/clients/${reminder.clientId}`);
  revalidatePath("/dashboard/reminders");
}

const SOURCE_LABELS: Record<string, string> = {
  WHATSAPP_DIRECT: "WhatsApp",
  FACEBOOK_AD: "Facebook Ad",
  FACEBOOK_POST: "Facebook Post",
  INSTAGRAM_AD: "Instagram Ad",
  INSTAGRAM_POST: "Instagram Post",
  WEBSITE: "Website",
  MANUAL: "Manual",
  IMPORTED: "Imported",
};

function statusClass(status: string) {
  const s = status.toUpperCase();
  if (["DELIVERED", "FULFILLED", "DONE", "SENT"].includes(s)) return "bg-accent-light text-accent";
  if (["CANCELLED", "PAYMENT_FAILED", "REFUNDED", "RETURNED", "RTO", "FAILED"].includes(s)) return "bg-red-50 text-red-600";
  if (["PENDING", "PENDING_PAYMENT"].includes(s)) return "bg-amber-50 text-amber-700";
  return "bg-sky-50 text-sky-700";
}

function relativeDays(days: number | null) {
  if (days === null) return "—";
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months} month${months > 1 ? "s" : ""} ago` : `${Math.floor(days / 365)} yr ago`;
}

const input =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 focus:border-primary focus:outline-none";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-gray-900">{value}</p>
      {sub && <p className="text-[11px] text-gray-500">{sub}</p>}
    </div>
  );
}

function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export default async function ClientProfilePage({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return null;

  const client = await prisma.client.findFirst({
    where: { id: params.id, organizationId: user.organizationId },
    include: {
      orders: { orderBy: { createdAt: "desc" }, select: { id: true, items: true, status: true, totalAmount: true, createdAt: true } },
      websiteOrders: {
        orderBy: { placedAt: "desc" },
        select: { id: true, orderNumber: true, status: true, totalInRupees: true, placedAt: true, itemsJson: true },
      },
      productInterests: { include: { product: { select: { name: true } } }, orderBy: { updatedAt: "desc" } },
      reminders: { orderBy: { dueDate: "asc" } },
      conversations: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          createdAt: true,
          conversationStage: true,
          _count: { select: { messages: true } },
          messages: { orderBy: { createdAt: "desc" }, take: 1, select: { content: true, sender: true, createdAt: true } },
        },
      },
      broadcastRecipients: {
        orderBy: { sentAt: "desc" },
        take: 10,
        select: { id: true, status: true, sentAt: true, broadcast: { select: { name: true, createdAt: true } } },
      },
      groupMemberships: { select: { group: { select: { name: true } } } },
    },
  });
  if (!client) notFound();

  const orders = unifyOrders(client.orders, client.websiteOrders);
  const m = computeClientMetrics(orders);
  const openReminders = client.reminders.filter((r) => r.status !== "DONE");
  const doneReminders = client.reminders.filter((r) => r.status === "DONE").slice(-5).reverse();
  const latestConversation = client.conversations[0];
  const chatHref = latestConversation
    ? `/dashboard/conversations/${latestConversation.id}`
    : `/dashboard/conversations?phone=${encodeURIComponent(client.phone)}`;
  const lastMessage = client.conversations.flatMap((c) => c.messages).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

  return (
    <div className="space-y-4">
      <Link href="/dashboard/clients" className="text-sm text-gray-500 hover:text-gray-800">
        ← All clients
      </Link>

      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-xl font-semibold text-white">
            {(client.name.trim()[0] ?? "?").toUpperCase()}
          </div>
          <div>
            <h1 className="text-xl font-semibold text-gray-900">{client.name}</h1>
            <p className="text-sm text-gray-600">
              {client.phone}
              <span className="mx-2 text-gray-300">·</span>
              <span title={client.sourceDetail ?? ""}>{SOURCE_LABELS[client.source] ?? client.source}</span>
              <span className="mx-2 text-gray-300">·</span>
              Customer since {formatDate(client.createdAt)}
            </p>
            {(client.autoTags.length > 0 || client.tags.length > 0 || client.groupMemberships.length > 0) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {client.autoTags.map((t) => (
                  <span key={`auto-${t}`} title={`Automatic: ${AUTO_TAG_HELP[t] ?? ""}`} className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${AUTO_TAG_STYLES[t] ?? "bg-gray-100 text-gray-700"}`}>
                    {t}
                  </span>
                ))}
                {client.tags.map((t) => (
                  <span key={t} className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                    {t}
                  </span>
                ))}
                {client.groupMemberships.map((g) => (
                  <span key={g.group.name} className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-600">
                    Group: {g.group.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={chatHref} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light">
            Open chat
          </Link>
          <a
            href={`https://wa.me/${client.phone.replace(/\D/g, "")}`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            WhatsApp ↗
          </a>
        </div>
      </div>

      {/* ── Lifetime numbers ───────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Total spent" value={formatRupees(m.totalSpent)} sub={m.orderCount ? `${m.websiteOrderCount} website · ${m.whatsappOrderCount} WhatsApp` : "No orders yet"} />
        <Stat label="Orders" value={String(m.orderCount)} />
        <Stat label="Average order" value={m.averageOrder !== null ? formatRupees(m.averageOrder) : "—"} />
        <Stat label="Last order" value={relativeDays(m.daysSinceLastOrder)} sub={m.lastOrderAt ? formatDate(m.lastOrderAt) : undefined} />
        <Stat label="First order" value={m.firstOrderAt ? formatDate(m.firstOrderAt) : "—"} />
        <Stat label="Buys every" value={m.averageGapDays !== null ? `${m.averageGapDays} days` : "—"} sub={m.averageGapDays !== null ? "on average" : "needs 2+ orders"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* ── Left: details + reminders ───────────────────── */}
        <div className="space-y-4 lg:col-span-1">
          <Card title="Details & tags">
            <form action={updateProfile} className="space-y-3">
              <input type="hidden" name="clientId" value={client.id} />
              <label className="block text-xs font-medium text-gray-600">
                Name
                <input name="name" defaultValue={client.name} required className={`${input} mt-1`} />
              </label>
              <label className="block text-xs font-medium text-gray-600">
                Email
                <input name="email" type="email" defaultValue={client.email ?? ""} className={`${input} mt-1`} />
              </label>
              <label className="block text-xs font-medium text-gray-600">
                Address
                <textarea name="address" rows={2} defaultValue={client.address ?? ""} className={`${input} mt-1`} />
              </label>
              <label className="block text-xs font-medium text-gray-600">
                PIN code
                <input name="pinCode" defaultValue={client.pinCode ?? ""} className={`${input} mt-1`} />
              </label>
              <label className="block text-xs font-medium text-gray-600">
                Tags <span className="font-normal text-gray-400">(comma-separated, e.g. Regular, Corporate)</span>
                <input name="tags" defaultValue={client.tags.join(", ")} className={`${input} mt-1`} />
              </label>
              <label className="block text-xs font-medium text-gray-600">
                Interested in
                <input name="interestedIn" defaultValue={client.interestedIn ?? ""} className={`${input} mt-1`} />
              </label>
              <label className="block text-xs font-medium text-gray-600">
                Staff notes <span className="font-normal text-gray-400">(only staff see this)</span>
                <textarea name="notes" rows={3} defaultValue={client.notes ?? ""} placeholder="e.g. Prefers delivery after 6 pm" className={`${input} mt-1`} />
              </label>
              <button type="submit" className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light">
                Save
              </button>
            </form>
          </Card>

          <Card title={`Reminders (${openReminders.length})`}>
            <div className="space-y-2">
              {openReminders.map((r) => (
                <div key={r.id} className="flex items-start justify-between gap-2 rounded-lg border border-gray-100 p-2">
                  <div>
                    <p className="text-sm text-gray-800">{r.title}</p>
                    <p className="text-[11px] text-gray-500">
                      Due {formatDate(r.dueDate)} · <span className={`rounded-full px-1.5 py-0.5 ${statusClass(r.status)}`}>{r.status}</span>
                    </p>
                  </div>
                  <form action={completeReminder}>
                    <input type="hidden" name="reminderId" value={r.id} />
                    <button className="whitespace-nowrap rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50">Done ✓</button>
                  </form>
                </div>
              ))}
              {openReminders.length === 0 && <p className="text-xs text-gray-500">No open reminders.</p>}
              {doneReminders.length > 0 && (
                <p className="pt-1 text-[11px] text-gray-400">Done: {doneReminders.map((r) => r.title).join(" · ")}</p>
              )}
            </div>
            <form action={addReminder} className="mt-3 space-y-2 border-t border-gray-100 pt-3">
              <input type="hidden" name="clientId" value={client.id} />
              <input name="title" required placeholder="e.g. Call about Durga Puja bulk order" className={input} />
              <div className="flex gap-2">
                <input name="dueDate" type="date" required className={input} />
                <button className="whitespace-nowrap rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-light">Add</button>
              </div>
            </form>
          </Card>
        </div>

        {/* ── Right: orders, interests, chats ─────────────── */}
        <div className="space-y-4 lg:col-span-2">
          <Card title="What they like">
            <div className="space-y-3">
              <div>
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-500">Most ordered</p>
                {m.favouriteProducts.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {m.favouriteProducts.map((p) => (
                      <span key={p.name} className="rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-800">
                        {p.name} <span className="text-amber-600">· {p.orders} order{p.orders > 1 ? "s" : ""}</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-500">No website orders with item details yet.</p>
                )}
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-500">Asked about (tracked by the AI)</p>
                {client.productInterests.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {client.productInterests.map((pi) => (
                      <span key={pi.id} title={pi.note ?? ""} className="rounded-full bg-sky-50 px-2.5 py-1 text-xs text-sky-700">
                        {pi.product.name}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-500">Nothing tracked yet.</p>
                )}
                {client.interestedIn && <p className="mt-1.5 text-xs text-gray-600">Staff note: {client.interestedIn}</p>}
              </div>
            </div>
          </Card>

          <Card title={`Orders (${orders.length})`} right={<span className="text-xs text-gray-500">WhatsApp + banglardoi.com</span>}>
            {orders.length === 0 ? (
              <p className="text-sm text-gray-500">No orders yet.</p>
            ) : (
              <div className="space-y-2">
                {orders.map((o) => (
                  <details key={`${o.kind}-${o.id}`} className="group rounded-lg border border-gray-100">
                    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${o.kind === "WEBSITE" ? "bg-violet-50 text-violet-700" : "bg-emerald-50 text-emerald-700"}`}>
                        {o.kind === "WEBSITE" ? "WEBSITE" : "WHATSAPP"}
                      </span>
                      <span className="font-medium text-gray-800">{o.label}</span>
                      <span className="text-gray-500">{formatDate(o.placedAt)}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusClass(o.status)}`}>{o.status}</span>
                      <span className={`ml-auto font-semibold ${o.counted ? "text-gray-900" : "text-gray-400 line-through"}`}>
                        {o.total !== null ? formatRupees(o.total) : "—"}
                      </span>
                    </summary>
                    <div className="border-t border-gray-100 bg-gray-50/60 px-3 py-2 text-xs text-gray-600">
                      {o.items.length > 0
                        ? o.items.map((it, i) => (
                            <div key={i} className="flex justify-between gap-2">
                              <span>
                                {it.name}
                                {it.variant ? ` (${it.variant})` : ""} × {it.quantity}
                              </span>
                              <span>{it.total !== null ? formatRupees(it.total) : ""}</span>
                            </div>
                          ))
                        : o.itemsText || "No item details."}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </Card>

          <Card title={`Chats (${client.conversations.length})`} right={lastMessage ? <span className="text-xs text-gray-500">Last message {formatDateTime(lastMessage.createdAt)}</span> : undefined}>
            {client.conversations.length === 0 ? (
              <p className="text-sm text-gray-500">No WhatsApp chats yet.</p>
            ) : (
              <div className="space-y-2">
                {client.conversations.map((c) => (
                  <Link key={c.id} href={`/dashboard/conversations/${c.id}`} className="block rounded-lg border border-gray-100 px-3 py-2 hover:bg-gray-50">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                      <span>Started {formatDate(c.createdAt)}</span>
                      <span>· {c._count.messages} messages</span>
                      <span className={`rounded-full px-2 py-0.5 ${statusClass(c.status)}`}>{c.status}</span>
                      {c.conversationStage && <span className="rounded-full bg-gray-100 px-2 py-0.5">{c.conversationStage.replace(/_/g, " ")}</span>}
                    </div>
                    {c.messages[0] && (
                      <p className="mt-1 line-clamp-2 text-sm text-gray-700">
                        <span className="font-medium text-gray-500">{c.messages[0].sender === "CLIENT" ? "Customer" : c.messages[0].sender === "AI" ? "AI" : "Staff"}: </span>
                        {c.messages[0].content}
                      </p>
                    )}
                  </Link>
                ))}
              </div>
            )}
          </Card>

          <Card title="Broadcasts received">
            {client.broadcastRecipients.length === 0 ? (
              <p className="text-sm text-gray-500">None yet.</p>
            ) : (
              <div className="space-y-1">
                {client.broadcastRecipients.map((b) => (
                  <div key={b.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-gray-800">{b.broadcast.name}</span>
                    <span className="flex items-center gap-2 text-xs text-gray-500">
                      {formatDate(b.sentAt ?? b.broadcast.createdAt)}
                      <span className={`rounded-full px-2 py-0.5 ${statusClass(b.status)}`}>{b.status}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
