import { prisma } from "@/lib/prisma";

// Business Analyst (2026-11-20) — owner-only internal analysis of Banglar
// Doi's own sales (owner: "amar business r analysis korbe sale dekhe ar
// amader sales e help korbe"). Priority order the owner gave: Sales, then
// Marketing, then Finance. Only the owner uses it (dashboard page + his own
// WhatsApp owner-assistant number).
//
// Data: every night the cron copies each day's summary from Banglar Doi OS
// (app.banglardoi.com → /wp-json/bdos/v1/analytics/day, authorised with the
// same BMS_INTEGRATION_SECRET the Event Shop already uses) into BizDay /
// BizSale. Website orders come from ClientOrder (already synced from
// banglardoi.com). Every answer the analyst gives is computed here from
// those rows — never guessed by the model.

const BMS_URL = (process.env.BMS_API_URL || "https://app.banglardoi.com").replace(/\/+$/, "");

/** Today in India (YYYY-MM-DD). */
export function istToday(): string {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
export function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const asDate = (s: string) => new Date(s + "T00:00:00Z");
const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const rupees = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

type BmsLocation = {
  location_id: number;
  location: string;
  type: string;
  start_date: string | null;
  end_date: string | null;
  sales: number;
  closed: boolean;
  money_entered: boolean;
  cash_sale: number;
  online: number;
  expense: number;
  fund_transfer: number;
  collected: number;
  short: number | null;
  expenses: { purpose: string; amount: number }[];
  items: {
    product_id: number;
    product: string;
    sku: string;
    vendor: string;
    cost_price: number;
    qty: number;
    value: number;
    pos_qty: number;
    counter_qty: number;
    wastage_qty: number;
  }[];
};

export function bmsSyncConfigured(): boolean {
  return Boolean(process.env.BMS_INTEGRATION_SECRET || process.env.BANGLARDOI_INTEGRATION_SECRET);
}

/** Copy one day from Banglar Doi OS (replaces whatever was stored for it). */
export async function syncBizDay(organizationId: string, date: string): Promise<{ locations: number; sales: number }> {
  const secret = process.env.BMS_INTEGRATION_SECRET || process.env.BANGLARDOI_INTEGRATION_SECRET;
  if (!secret) throw new Error("BMS_INTEGRATION_SECRET is not set");
  const res = await fetch(`${BMS_URL}/wp-json/bdos/v1/analytics/day?date=${date}&_=${Date.now()}`, {
    headers: { Authorization: `Bearer ${secret}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Banglar Doi OS answered ${res.status} for ${date}`);
  const body = (await res.json()) as { locations?: BmsLocation[] };
  const locations = Array.isArray(body.locations) ? body.locations : [];
  const day = asDate(date);

  await prisma.$transaction([
    prisma.bizSale.deleteMany({ where: { organizationId, date: day } }),
    prisma.bizDay.deleteMany({ where: { organizationId, date: day } }),
    prisma.bizDay.createMany({
      data: locations.map((l) => ({
        organizationId,
        date: day,
        locationId: l.location_id,
        location: l.location,
        locationType: l.type,
        startDate: l.start_date,
        endDate: l.end_date,
        sales: l.sales,
        cashSale: l.cash_sale,
        online: l.online,
        expense: l.expense,
        fundTransfer: l.fund_transfer,
        collected: l.collected,
        short: l.short,
        closed: l.closed,
        moneyEntered: l.money_entered,
        expensesJson: l.expenses,
      })),
    }),
    prisma.bizSale.createMany({
      data: locations.flatMap((l) =>
        l.items.map((i) => ({
          organizationId,
          date: day,
          locationId: l.location_id,
          location: l.location,
          locationType: l.type,
          productId: i.product_id,
          product: i.product,
          sku: i.sku || "",
          vendor: i.vendor || "",
          costPrice: i.cost_price || 0,
          qty: i.qty,
          value: i.value,
          posQty: i.pos_qty,
          counterQty: i.counter_qty,
          wastageQty: i.wastage_qty,
        }))
      ),
    }),
  ]);
  return { locations: locations.length, sales: locations.reduce((s, l) => s + l.sales, 0) };
}

/** Sync a range (oldest first). Stops early when time runs short. */
export async function syncBizRange(organizationId: string, from: string, to: string, budgetMs = 50_000) {
  const started = Date.now();
  let done = 0;
  let last = from;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (Date.now() - started > budgetMs) break;
    await syncBizDay(organizationId, d);
    done++;
    last = d;
  }
  const note = `Synced ${done} day(s) ${from} → ${last}`;
  await prisma.bizSettings.upsert({
    where: { organizationId },
    update: { lastSyncAt: new Date(), lastSyncNote: note },
    create: { organizationId, lastSyncAt: new Date(), lastSyncNote: note },
  });
  return { done, last, complete: last >= to };
}

// ---------------------------------------------------------------- analytics

export type SalesGroup = "location" | "product" | "day" | "vendor" | "channel";

export async function websiteSales(organizationId: string, from: string, to: string) {
  const orders = await prisma.clientOrder.findMany({
    where: {
      organizationId,
      NOT: { channel: "EVENT" },
      placedAt: { gte: asDate(from), lt: asDate(addDays(to, 1)) },
      status: { notIn: ["CANCELLED", "FAILED", "PENDING_PAYMENT", "REFUNDED", "RETURNED", "RTO"] },
    },
    select: { totalInRupees: true, placedAt: true },
  });
  return { orders: orders.length, value: orders.reduce((s, o) => s + o.totalInRupees, 0), rows: orders };
}

/**
 * Sales between two dates, grouped. Store/event figures come from Banglar
 * Doi OS (closing-based, same as its Closing Sale Report); "Website" is
 * banglardoi.com online orders. Cost = qty x product cost price.
 */
export async function salesReport(
  organizationId: string,
  from: string,
  to: string,
  groupBy: SalesGroup,
  locationQuery?: string,
  limit = 15
) {
  const where = {
    organizationId,
    date: { gte: asDate(from), lte: asDate(to) },
    ...(locationQuery ? { location: { contains: locationQuery, mode: "insensitive" as const } } : {}),
  };
  const sales = await prisma.bizSale.findMany({ where });
  const days = await prisma.bizDay.findMany({ where });
  const web = locationQuery ? { orders: 0, value: 0, rows: [] as { totalInRupees: number; placedAt: Date }[] } : await websiteSales(organizationId, from, to);

  const groups = new Map<string, { key: string; value: number; qty: number; cost: number; days: Set<string>; wastage: number }>();
  const bump = (key: string, value: number, qty: number, cost: number, date: string, wastage = 0) => {
    const g = groups.get(key) ?? { key, value: 0, qty: 0, cost: 0, days: new Set<string>(), wastage: 0 };
    g.value += value;
    g.qty += qty;
    g.cost += cost;
    g.wastage += wastage;
    g.days.add(date);
    groups.set(key, g);
  };
  for (const s of sales) {
    const date = ymd(s.date);
    const key =
      groupBy === "location" ? s.location
      : groupBy === "product" ? s.product
      : groupBy === "vendor" ? s.vendor || "No vendor"
      : groupBy === "day" ? date
      : s.locationType === "event" ? "Events" : "Shops / Counter";
    bump(key, s.value, s.qty, s.qty * s.costPrice, date, s.wastageQty);
  }
  if (groupBy === "location" || groupBy === "channel") {
    if (web.value > 0) for (const o of web.rows) bump(groupBy === "channel" ? "Website" : "Website (online)", o.totalInRupees, 1, 0, ymd(o.placedAt));
  } else if (groupBy === "day") {
    for (const o of web.rows) bump(ymd(new Date(o.placedAt.getTime() + 5.5 * 3600 * 1000)), o.totalInRupees, 0, 0, "");
  }

  const storeSales = sales.reduce((s, r) => s + r.value, 0);
  const rows = [...groups.values()]
    .map((g) => ({ name: g.key, sales: Math.round(g.value), qty: Math.round(g.qty * 100) / 100, cost: Math.round(g.cost), grossProfit: Math.round(g.value - g.cost), sellingDays: [...g.days].filter(Boolean).length, wastageQty: g.wastage }))
    .sort((a, b) => (groupBy === "day" ? a.name.localeCompare(b.name) : b.sales - a.sales));
  return {
    from,
    to,
    groupBy,
    totalSales: Math.round(storeSales + web.value),
    storeAndEventSales: Math.round(storeSales),
    websiteSales: Math.round(web.value),
    websiteOrders: web.orders,
    collected: Math.round(days.reduce((s, d) => s + d.collected, 0)),
    short: Math.round(days.reduce((s, d) => s + (d.short ?? 0), 0)),
    daysWithoutClosing: days.filter((d) => !d.closed).map((d) => `${ymd(d.date)} ${d.location}`),
    rows: groupBy === "day" ? rows : rows.slice(0, limit),
    moreRows: Math.max(0, rows.length - limit),
  };
}

export async function getTarget(organizationId: string, month: string) {
  return prisma.bizTarget.findUnique({ where: { organizationId_month: { organizationId, month } } });
}

export async function setTarget(organizationId: string, month: string, amount: number) {
  return prisma.bizTarget.upsert({
    where: { organizationId_month: { organizationId, month } },
    update: { amount },
    create: { organizationId, month, amount },
  });
}

/** Month-to-date vs target, with the daily pace needed for the rest. */
export async function targetProgress(organizationId: string, month = istToday().slice(0, 7)) {
  const first = `${month}-01`;
  const lastDay = addDays(addDays(first, 32).slice(0, 8) + "01", -1);
  const today = istToday();
  const upTo = today < lastDay ? (today > first ? addDays(today, -1) : first) : lastDay;
  const report = await salesReport(organizationId, first, upTo, "channel");
  const target = await getTarget(organizationId, month);
  const totalDays = Number(lastDay.slice(8, 10));
  const daysDone = Math.max(0, Math.min(totalDays, Number(upTo.slice(8, 10))));
  const daysLeft = Math.max(0, totalDays - daysDone);
  const achieved = report.totalSales;
  return {
    month,
    target: target?.amount ?? null,
    achieved,
    percent: target?.amount ? Math.round((achieved / target.amount) * 1000) / 10 : null,
    remaining: target?.amount ? Math.max(0, Math.round(target.amount - achieved)) : null,
    daysDone,
    daysLeft,
    neededPerDay: target?.amount && daysLeft > 0 ? Math.round(Math.max(0, target.amount - achieved) / daysLeft) : null,
    averagePerDaySoFar: daysDone > 0 ? Math.round(achieved / daysDone) : 0,
    byChannel: report.rows,
  };
}

/** Same-length period just before [from, to], for "vs last period". */
export async function comparePeriods(organizationId: string, from: string, to: string, groupBy: SalesGroup = "location") {
  const len = Math.round((asDate(to).getTime() - asDate(from).getTime()) / 86400000) + 1;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(len - 1));
  const [now, prev] = await Promise.all([
    salesReport(organizationId, from, to, groupBy, undefined, 30),
    salesReport(organizationId, prevFrom, prevTo, groupBy, undefined, 30),
  ]);
  const prevMap = new Map(prev.rows.map((r) => [r.name, r.sales]));
  return {
    current: { from, to, total: now.totalSales },
    previous: { from: prevFrom, to: prevTo, total: prev.totalSales },
    changePercent: prev.totalSales ? Math.round(((now.totalSales - prev.totalSales) / prev.totalSales) * 1000) / 10 : null,
    rows: now.rows.slice(0, 15).map((r) => ({ name: r.name, now: r.sales, before: prevMap.get(r.name) ?? 0 })),
  };
}

/** Every event (optionally matching a name) with totals, best first. */
export async function eventPerformance(organizationId: string, nameQuery?: string) {
  const days = await prisma.bizDay.findMany({
    where: { organizationId, locationType: "event", ...(nameQuery ? { location: { contains: nameQuery, mode: "insensitive" as const } } : {}) },
  });
  const map = new Map<number, { name: string; start: string | null; end: string | null; sales: number; days: number; short: number; expense: number }>();
  for (const d of days) {
    const e = map.get(d.locationId) ?? { name: d.location, start: d.startDate, end: d.endDate, sales: 0, days: 0, short: 0, expense: 0 };
    e.sales += d.sales;
    if (d.sales > 0) e.days += 1;
    e.short += d.short ?? 0;
    e.expense += d.expense;
    map.set(d.locationId, e);
  }
  const ids = [...map.keys()];
  const costRows = ids.length ? await prisma.bizSale.findMany({ where: { organizationId, locationId: { in: ids } }, select: { locationId: true, qty: true, costPrice: true } }) : [];
  const costBy = new Map<number, number>();
  for (const r of costRows) costBy.set(r.locationId, (costBy.get(r.locationId) ?? 0) + r.qty * r.costPrice);
  return [...map.entries()]
    .map(([id, e]) => ({
      event: e.name,
      dates: [e.start, e.end].filter(Boolean).join(" → "),
      sellingDays: e.days,
      sales: Math.round(e.sales),
      perDay: e.days ? Math.round(e.sales / e.days) : 0,
      goodsCost: Math.round(costBy.get(id) ?? 0),
      expenses: Math.round(e.expense),
      roughProfit: Math.round(e.sales - (costBy.get(id) ?? 0) - e.expense),
      cashShort: Math.round(e.short),
    }))
    .sort((a, b) => b.sales - a.sales);
}

/**
 * How much of each product to take to an event: average sold per selling
 * day at past events (matching nameQuery if given, else all events),
 * x planned days, +10% buffer, minus nothing (the owner decides).
 */
export async function suggestEventStock(organizationId: string, plannedDays: number, nameQuery?: string) {
  const days = await prisma.bizDay.findMany({
    where: { organizationId, locationType: "event", sales: { gt: 0 }, ...(nameQuery ? { location: { contains: nameQuery, mode: "insensitive" as const } } : {}) },
    select: { date: true, locationId: true },
  });
  if (!days.length) return { basedOnDays: 0, rows: [] as { product: string; avgPerDay: number; suggestedQty: number; wastagePerDay: number }[] };
  const keys = new Set(days.map((d) => `${ymd(d.date)}|${d.locationId}`));
  const sales = await prisma.bizSale.findMany({
    where: { organizationId, locationType: "event", locationId: { in: [...new Set(days.map((d) => d.locationId))] } },
  });
  const per = new Map<string, { qty: number; waste: number }>();
  for (const s of sales) {
    if (!keys.has(`${ymd(s.date)}|${s.locationId}`)) continue;
    const p = per.get(s.product) ?? { qty: 0, waste: 0 };
    p.qty += s.qty;
    p.waste += s.wastageQty;
    per.set(s.product, p);
  }
  const n = keys.size;
  return {
    basedOnDays: n,
    rows: [...per.entries()]
      .map(([product, p]) => ({
        product,
        avgPerDay: Math.round((p.qty / n) * 10) / 10,
        suggestedQty: Math.ceil((p.qty / n) * plannedDays * 1.1),
        wastagePerDay: Math.round((p.waste / n) * 10) / 10,
      }))
      .filter((r) => r.avgPerDay > 0)
      .sort((a, b) => b.suggestedQty - a.suggestedQty),
  };
}

/** Short text for the morning brief / "aaj er report". */
export async function dailyBriefText(organizationId: string, date = addDays(istToday(), -1)) {
  const day = await salesReport(organizationId, date, date, "location", undefined, 8);
  const tp = await targetProgress(organizationId, date.slice(0, 7));
  const lines = [
    `📊 *Banglar Doi — ${date.split("-").reverse().join("/")}*`,
    `Total sale: *${rupees(day.totalSales)}*` + (day.websiteSales ? ` (website ${rupees(day.websiteSales)})` : ""),
    ...day.rows.map((r) => `• ${r.name}: ${rupees(r.sales)}`),
  ];
  if (day.short > 0.5) lines.push(`⚠️ Cash short: ${rupees(day.short)}`);
  if (day.daysWithoutClosing.length) lines.push(`⏳ Closing not done: ${day.daysWithoutClosing.map((x) => x.slice(11)).join(", ")}`);
  lines.push("");
  lines.push(`This month: *${rupees(tp.achieved)}*` + (tp.target ? ` of ${rupees(tp.target)} (${tp.percent}%)` : ""));
  if (tp.neededPerDay) lines.push(`Need ${rupees(tp.neededPerDay)}/day for the next ${tp.daysLeft} days`);
  return { text: lines.join("\n"), totalSales: day.totalSales, month: tp };
}
