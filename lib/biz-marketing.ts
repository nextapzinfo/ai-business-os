import { prisma } from "@/lib/prisma";
import { addDays, istToday } from "@/lib/biz-analyst";

// Business Analyst — Marketing (2026-11-21). Reads the CRM that AI Business
// OS already keeps (Client + ClientOrder + auto/chat/manual tags) to answer
// "who are my best customers", "who stopped buying", "which area orders
// most", and to put a chosen set of customers into a Client Group the owner
// can then broadcast to from the Broadcasts page. It never messages anyone
// itself.

const DONE = { notIn: ["CANCELLED", "FAILED", "PENDING_PAYMENT", "REFUNDED", "RETURNED", "RTO"] };
const day = (s: string) => new Date(s + "T00:00:00Z");

type Profile = {
  id: string;
  name: string;
  phone: string;
  pinCode: string | null;
  source: string;
  tags: string[];
  autoTags: string[];
  chatTags: string[];
  createdAt: Date;
  orders: number;
  spend: number;
  lastOrder: Date | null;
  channels: Set<string>;
  interests: string[];
};

async function profiles(organizationId: string): Promise<Profile[]> {
  const [clients, orders, interests] = await Promise.all([
    prisma.client.findMany({
      where: { organizationId, NOT: { source: "OWNER_ASSISTANT" } },
      select: { id: true, name: true, phone: true, pinCode: true, source: true, tags: true, autoTags: true, chatTags: true, createdAt: true },
    }),
    prisma.clientOrder.findMany({ where: { organizationId, status: DONE }, select: { clientId: true, totalInRupees: true, placedAt: true, channel: true } }),
    prisma.clientProductInterest.findMany({ where: { organizationId }, select: { clientId: true, product: { select: { name: true } } } }),
  ]);
  const byId = new Map<string, Profile>();
  for (const c of clients) byId.set(c.id, { ...c, orders: 0, spend: 0, lastOrder: null, channels: new Set(), interests: [] });
  for (const o of orders) {
    const p = o.clientId ? byId.get(o.clientId) : undefined;
    if (!p) continue;
    p.orders += 1;
    p.spend += o.totalInRupees;
    p.channels.add(o.channel || "WEBSITE");
    if (!p.lastOrder || o.placedAt > p.lastOrder) p.lastOrder = o.placedAt;
  }
  for (const i of interests) byId.get(i.clientId)?.interests.push(i.product.name);
  return [...byId.values()];
}

const brief = (p: Profile) => ({
  name: p.name,
  phone: p.phone,
  orders: p.orders,
  spend: Math.round(p.spend),
  lastOrder: p.lastOrder ? p.lastOrder.toISOString().slice(0, 10) : null,
  tags: [...p.autoTags, ...p.chatTags, ...p.tags].slice(0, 5),
});

export async function customerInsights(organizationId: string) {
  const all = await profiles(organizationId);
  const today = istToday();
  const monthStart = day(`${today.slice(0, 7)}-01`);
  const lastMonthStart = day(`${addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`);
  const count = (f: (p: Profile) => boolean) => all.filter(f).length;
  const tally = (keys: (p: Profile) => string[]) => {
    const m = new Map<string, number>();
    for (const p of all) for (const k of keys(p)) if (k) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, customers]) => ({ name, customers }));
  };
  const buyers = all.filter((p) => p.orders > 0);
  const since = (d: number) => new Date(Date.now() - d * 86400000);
  const templates = await prisma.messageTemplate.findMany({ where: { organizationId, status: "APPROVED" }, select: { metaTemplateName: true, category: true } });
  return {
    totalCustomers: all.length,
    buyers: buyers.length,
    repeatBuyers: count((p) => p.orders >= 2),
    repeatRatePercent: buyers.length ? Math.round((count((p) => p.orders >= 2) / buyers.length) * 1000) / 10 : 0,
    newThisMonth: count((p) => p.createdAt >= monthStart),
    newLastMonth: count((p) => p.createdAt >= lastMonthStart && p.createdAt < monthStart),
    boughtLast30Days: count((p) => !!p.lastOrder && p.lastOrder >= since(30)),
    noOrderFor60DaysButBoughtBefore: count((p) => p.orders > 0 && !!p.lastOrder && p.lastOrder < since(60)),
    neverOrdered: count((p) => p.orders === 0),
    byAutoTag: tally((p) => p.autoTags),
    bySource: tally((p) => [p.source]),
    topChatTags: tally((p) => p.chatTags),
    eventCustomers: tally((p) => p.tags.filter((t) => t.startsWith("Event:"))),
    topPinCodes: tally((p) => [p.pinCode || ""]),
    topInterests: tally((p) => p.interests),
    topSpenders: buyers.sort((a, b) => b.spend - a.spend).slice(0, 10).map(brief),
    approvedTemplates: templates.map((t) => `${t.metaTemplateName} (${t.category})`),
  };
}

export type CustomerFilter = {
  auto_tag?: string;
  tag_contains?: string;
  source?: string;
  pin_code_starts?: string;
  inactive_days_min?: number;
  ordered_within_days?: number;
  min_spend?: number;
  min_orders?: number;
  max_orders?: number;
  interested_in?: string;
  joined_within_days?: number;
};

export async function findCustomers(organizationId: string, f: CustomerFilter, saveAsGroup?: string) {
  const all = await profiles(organizationId);
  const now = Date.now();
  const ago = (p: Profile) => (p.lastOrder ? (now - p.lastOrder.getTime()) / 86400000 : Infinity);
  const lc = (s?: string) => (s || "").trim().toLowerCase();
  const match = all.filter((p) => {
    const tags = [...p.autoTags, ...p.chatTags, ...p.tags].map((t) => t.toLowerCase());
    if (f.auto_tag && !p.autoTags.some((t) => t.toLowerCase() === lc(f.auto_tag))) return false;
    if (f.tag_contains && !tags.some((t) => t.includes(lc(f.tag_contains)))) return false;
    if (f.source && lc(p.source) !== lc(f.source)) return false;
    if (f.pin_code_starts && !(p.pinCode || "").startsWith(f.pin_code_starts)) return false;
    if (f.inactive_days_min && !(p.orders > 0 && ago(p) >= f.inactive_days_min)) return false;
    if (f.ordered_within_days && !(ago(p) <= f.ordered_within_days)) return false;
    if (f.min_spend && p.spend < f.min_spend) return false;
    if (f.min_orders && p.orders < f.min_orders) return false;
    if (f.max_orders !== undefined && f.max_orders !== null && p.orders > f.max_orders) return false;
    if (f.interested_in && !p.interests.some((i) => i.toLowerCase().includes(lc(f.interested_in)))) return false;
    if (f.joined_within_days && now - p.createdAt.getTime() > f.joined_within_days * 86400000) return false;
    return true;
  });
  let group: { id: string; name: string; members: number } | null = null;
  if (saveAsGroup && match.length) {
    const name = `AI • ${saveAsGroup}`.slice(0, 80);
    const g = await prisma.clientGroup.create({ data: { organizationId, name } });
    await prisma.clientGroupMember.createMany({ data: match.slice(0, 2000).map((p) => ({ groupId: g.id, clientId: p.id })), skipDuplicates: true });
    group = { id: g.id, name, members: Math.min(2000, match.length) };
  }
  return {
    count: match.length,
    totalSpend: Math.round(match.reduce((s, p) => s + p.spend, 0)),
    sample: match.sort((a, b) => b.spend - a.spend).slice(0, 10).map(brief),
    savedGroup: group,
    howToSend: group ? `Open Broadcasts, pick an approved template, choose the group "${group.name}" and send.` : undefined,
  };
}
