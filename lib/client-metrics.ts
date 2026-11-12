// Per-customer CRM numbers — total spend, order count, average order value,
// first/last order, favourite products — computed from BOTH order sources
// this app knows about:
//   - Order:       orders taken inside WhatsApp (by the AI's record_order
//                  tool or by staff on the Orders page). Status vocabulary:
//                  PENDING, CONFIRMED, FULFILLED, CANCELLED.
//   - ClientOrder: real banglardoi.com website orders synced in by
//                  app/api/integrations/banglardoi/order-sync. Status is the
//                  website's own vocabulary (PENDING_PAYMENT, CONFIRMED, …,
//                  DELIVERED, CANCELLED, REFUNDED, RTO …).
//
// CRM Step 1 (owner's full-CRM plan, 2026-11-11): the Customer Profile page
// shows these; later steps (auto-tags, segments, reports) reuse the same
// function so every screen agrees on what "spent ₹X" or "last ordered" means.

// Orders that never turned into a real sale — excluded from spend/counts.
const NOT_A_SALE = new Set([
  "CANCELLED",
  "PAYMENT_FAILED",
  "REFUNDED",
  "RETURNED",
  "RTO",
  "PENDING_PAYMENT",
]);

export function isCountedSale(status: string): boolean {
  return !NOT_A_SALE.has(status.toUpperCase());
}

export type OrderSourceKind = "WEBSITE" | "WHATSAPP" | "EVENT";

export type UnifiedOrderItem = { name: string; variant: string | null; quantity: number; total: number | null };

export type UnifiedOrder = {
  id: string;
  kind: OrderSourceKind;
  label: string; // website order number, or a short "WhatsApp order" label
  status: string;
  total: number | null; // ₹ — null when a WhatsApp order was recorded without an amount
  placedAt: Date;
  items: UnifiedOrderItem[];
  itemsText: string | null; // WhatsApp orders keep a free-text item list instead of structured items
  counted: boolean;
};

// ClientOrder.itemsJson is a plain JSON array (see order-sync) — parsed
// defensively, same as the Clients page does.
export function parseWebsiteItems(raw: unknown): UnifiedOrderItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null && typeof (i as Record<string, unknown>).productName === "string")
    .map((i) => ({
      name: String(i.productName),
      variant: typeof i.variantLabel === "string" ? i.variantLabel : null,
      quantity: Number(i.quantity) || 0,
      total: Number.isFinite(Number(i.totalPriceInRupees)) ? Number(i.totalPriceInRupees) : null,
    }));
}

export function unifyOrders(
  whatsappOrders: { id: string; items: string; status: string; totalAmount: number | null; createdAt: Date }[],
  websiteOrders: { id: string; orderNumber: string; status: string; totalInRupees: number; placedAt: Date; itemsJson: unknown; channel?: string | null }[]
): UnifiedOrder[] {
  const list: UnifiedOrder[] = [
    ...websiteOrders.map((o) => ({
      id: o.id,
      // ClientOrder also holds Banglar Doi OS Event Shop bills (channel EVENT).
      kind: (o.channel === "EVENT" ? "EVENT" : "WEBSITE") as OrderSourceKind,
      label: o.orderNumber,
      status: o.status,
      total: o.totalInRupees,
      placedAt: o.placedAt,
      items: parseWebsiteItems(o.itemsJson),
      itemsText: null,
      counted: isCountedSale(o.status),
    })),
    ...whatsappOrders.map((o) => ({
      id: o.id,
      kind: "WHATSAPP" as const,
      label: "WhatsApp order",
      status: o.status,
      total: o.totalAmount,
      placedAt: o.createdAt,
      items: [],
      itemsText: o.items,
      counted: isCountedSale(o.status),
    })),
  ];
  return list.sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime());
}

export type ClientMetrics = {
  orderCount: number; // counted (real) orders only
  totalSpent: number; // ₹, counted orders with a known amount
  averageOrder: number | null;
  firstOrderAt: Date | null;
  lastOrderAt: Date | null;
  daysSinceLastOrder: number | null;
  // Average gap between consecutive orders, in days (null with < 2 orders).
  averageGapDays: number | null;
  favouriteProducts: { name: string; quantity: number; orders: number }[];
  websiteOrderCount: number;
  whatsappOrderCount: number;
  eventOrderCount: number;
};

const DAY = 24 * 60 * 60 * 1000;

export function computeClientMetrics(orders: UnifiedOrder[], now = new Date()): ClientMetrics {
  const real = orders.filter((o) => o.counted);
  const withAmount = real.filter((o) => o.total !== null && Number.isFinite(o.total));
  const totalSpent = withAmount.reduce((sum, o) => sum + (o.total ?? 0), 0);
  const dates = real.map((o) => o.placedAt.getTime()).sort((a, b) => a - b);

  let averageGapDays: number | null = null;
  if (dates.length >= 2) {
    averageGapDays = Math.round((dates[dates.length - 1] - dates[0]) / DAY / (dates.length - 1));
  }

  // Favourite products — only website orders have structured items.
  const fav = new Map<string, { quantity: number; orders: number }>();
  for (const o of real) {
    const seen = new Set<string>();
    for (const item of o.items) {
      const key = item.name.trim();
      if (!key) continue;
      const cur = fav.get(key) ?? { quantity: 0, orders: 0 };
      cur.quantity += item.quantity || 1;
      if (!seen.has(key)) {
        cur.orders += 1;
        seen.add(key);
      }
      fav.set(key, cur);
    }
  }

  const last = dates.length ? new Date(dates[dates.length - 1]) : null;
  return {
    orderCount: real.length,
    totalSpent: Math.round(totalSpent),
    averageOrder: withAmount.length ? Math.round(totalSpent / withAmount.length) : null,
    firstOrderAt: dates.length ? new Date(dates[0]) : null,
    lastOrderAt: last,
    daysSinceLastOrder: last ? Math.floor((now.getTime() - last.getTime()) / DAY) : null,
    averageGapDays,
    favouriteProducts: [...fav.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.orders - a.orders || b.quantity - a.quantity)
      .slice(0, 5),
    websiteOrderCount: real.filter((o) => o.kind === "WEBSITE").length,
    whatsappOrderCount: real.filter((o) => o.kind === "WHATSAPP").length,
    eventOrderCount: real.filter((o) => o.kind === "EVENT").length,
  };
}

export function formatRupees(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}
