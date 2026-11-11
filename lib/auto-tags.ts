import { prisma } from "@/lib/prisma";
import { computeClientMetrics, unifyOrders, type ClientMetrics } from "@/lib/client-metrics";

// ── Automatic customer tags (CRM Step 2, owner's rules, 2026-11-11) ──────
// Calculated by the system from each customer's real orders (WhatsApp +
// banglardoi.com, see lib/client-metrics.ts) and stored in Client.autoTags —
// kept SEPARATE from Client.tags, which stays exactly what staff type by
// hand. Nothing here ever touches a staff-typed tag.
//
//   VIP      — total spent ≥ ₹ crmVipSpend (default ₹5,000)
//   Regular  — buys about once a month: 2+ orders, average gap between
//              orders ≤ crmRegularGapDays (default 35 days — "monthly" with a
//              few days' slack), and still buying (last order within that
//              gap + 15 days)
//   New      — first and only order in the last 30 days
//   Inactive — has ordered before, but nothing for crmInactiveDays (60)
//   Lead     — has chatted on WhatsApp but never ordered
//
// Owner's own wording for Regular: "Monthly 1 ta kore order korle - regular".
// Thresholds are editable on the Clients page (Organization.crm* fields).
//
// Refreshed: whenever an order is created/updated (order-sync, WhatsApp
// orders, Orders page), every night by /api/cron/auto-tags (so "Inactive"
// kicks in on its own as days pass), and on demand via "Recalculate now".

export const AUTO_TAGS = ["VIP", "Regular", "New", "Inactive", "Lead"] as const;
export type AutoTag = (typeof AUTO_TAGS)[number];

export const AUTO_TAG_STYLES: Record<string, string> = {
  VIP: "bg-amber-100 text-amber-800 ring-1 ring-amber-300",
  Regular: "bg-emerald-100 text-emerald-800",
  New: "bg-sky-100 text-sky-800",
  Inactive: "bg-gray-200 text-gray-700",
  Lead: "bg-violet-100 text-violet-800",
};

export const AUTO_TAG_HELP: Record<string, string> = {
  VIP: "Total spent above the VIP amount",
  Regular: "Orders about once a month and is still buying",
  New: "First order in the last 30 days",
  Inactive: "Ordered before, but not for a long time",
  Lead: "Chatted but never ordered",
};

export type AutoTagRules = { regularGapDays: number; vipSpend: number; inactiveDays: number };

export const DEFAULT_RULES: AutoTagRules = { regularGapDays: 35, vipSpend: 5000, inactiveDays: 60 };

export function computeAutoTags(m: ClientMetrics, hasChatted: boolean, rules: AutoTagRules): AutoTag[] {
  const tags: AutoTag[] = [];
  if (m.orderCount === 0) return hasChatted ? ["Lead"] : [];

  if (m.totalSpent >= rules.vipSpend) tags.push("VIP");

  const days = m.daysSinceLastOrder ?? 0;
  if (days > rules.inactiveDays) {
    tags.push("Inactive");
    return tags;
  }

  if (
    m.orderCount >= 2 &&
    m.averageGapDays !== null &&
    m.averageGapDays <= rules.regularGapDays &&
    days <= rules.regularGapDays + 15
  ) {
    tags.push("Regular");
  }

  if (m.orderCount === 1 && days <= 30) tags.push("New");
  return tags;
}

export async function getAutoTagRules(organizationId: string): Promise<AutoTagRules> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { crmRegularGapDays: true, crmVipSpend: true, crmInactiveDays: true },
  });
  if (!org) return DEFAULT_RULES;
  return { regularGapDays: org.crmRegularGapDays, vipSpend: org.crmVipSpend, inactiveDays: org.crmInactiveDays };
}

const orderSelect = {
  orders: { select: { id: true, items: true, status: true, totalAmount: true, createdAt: true } },
  websiteOrders: { select: { id: true, orderNumber: true, status: true, totalInRupees: true, placedAt: true, itemsJson: true } },
  _count: { select: { conversations: true } },
} as const;

function sameTags(a: string[], b: string[]) {
  return a.length === b.length && a.every((t) => b.includes(t));
}

// One customer — called right after any order write. Never throws (an
// auto-tag problem must never break taking an order).
export async function refreshClientAutoTags(clientId: string): Promise<void> {
  try {
    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, organizationId: true, autoTags: true, ...orderSelect } });
    if (!client) return;
    const rules = await getAutoTagRules(client.organizationId);
    const m = computeClientMetrics(unifyOrders(client.orders, client.websiteOrders));
    const next = computeAutoTags(m, client._count.conversations > 0, rules);
    await prisma.client.update({
      where: { id: client.id },
      data: sameTags(client.autoTags, next) ? { autoTagsUpdatedAt: new Date() } : { autoTags: next, autoTagsUpdatedAt: new Date() },
    });
  } catch (err) {
    console.error("refreshClientAutoTags failed", clientId, err);
  }
}

// Every customer of one organization — nightly cron and "Recalculate now".
// Reads in pages so a large customer list stays within memory/time limits;
// only writes rows whose tags actually changed.
export async function refreshOrgAutoTags(organizationId: string): Promise<{ checked: number; changed: number }> {
  const rules = await getAutoTagRules(organizationId);
  const now = new Date();
  let checked = 0;
  let changed = 0;
  let cursor: string | undefined;
  const PAGE = 200;

  for (;;) {
    const batch = await prisma.client.findMany({
      where: { organizationId },
      select: { id: true, autoTags: true, ...orderSelect },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) break;

    const updates = [];
    for (const c of batch) {
      checked++;
      const m = computeClientMetrics(unifyOrders(c.orders, c.websiteOrders), now);
      const next = computeAutoTags(m, c._count.conversations > 0, rules);
      if (!sameTags(c.autoTags, next)) {
        changed++;
        updates.push(prisma.client.update({ where: { id: c.id }, data: { autoTags: next, autoTagsUpdatedAt: now } }));
      }
    }
    if (updates.length) await prisma.$transaction(updates);
    cursor = batch[batch.length - 1].id;
    if (batch.length < PAGE) break;
  }
  return { checked, changed };
}
