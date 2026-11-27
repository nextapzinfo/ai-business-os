import { prisma } from "@/lib/prisma";
import { unifyOrders, computeClientMetrics } from "@/lib/client-metrics";

// Customer memory (2026-11-27, owner: "akdom Human r moto chinta bhabna").
// A short note about THIS customer — name, how long they've bought from us,
// what they usually take, last order, where they live, what they asked
// about before — handed to the customer AI so it talks like a shopkeeper
// who remembers a regular. Never shown to the customer as a list.

const DAY = 24 * 60 * 60 * 1000;
const ago = (d: Date) => {
  const days = Math.floor((Date.now() - d.getTime()) / DAY);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 31 ? `${days} days ago` : `${Math.round(days / 30)} month(s) ago`;
};

export async function buildCustomerMemoryNote(organizationId: string, clientId: string, conversationId?: string): Promise<string> {
  const client = await prisma.client.findFirst({
    where: { id: clientId, organizationId },
    include: {
      orders: { orderBy: { createdAt: "desc" }, take: 20, select: { id: true, items: true, status: true, totalAmount: true, createdAt: true } },
      websiteOrders: { orderBy: { placedAt: "desc" }, take: 20, select: { id: true, orderNumber: true, status: true, totalInRupees: true, placedAt: true, itemsJson: true, channel: true } },
      productInterests: { orderBy: { updatedAt: "desc" }, take: 5, include: { product: { select: { name: true } } } },
    },
  });
  if (!client) return "";

  const lines: string[] = [];
  const name = client.name && client.name !== client.phone && !/^\+?\d+$/.test(client.name) ? client.name : "";
  if (name) lines.push(`Name: ${name}`);

  const orders = unifyOrders(client.orders, client.websiteOrders);
  const m = computeClientMetrics(orders);
  if (m.orderCount > 0) {
    lines.push(
      `Has ordered ${m.orderCount} time(s) since ${m.firstOrderAt?.toLocaleDateString("en-IN", { month: "short", year: "numeric" })}` +
        (m.averageGapDays ? `, usually every ~${m.averageGapDays} days` : "")
    );
    const last = orders.find((o) => o.counted);
    if (last) {
      const what = last.items.length ? last.items.map((i) => `${i.quantity} × ${i.name}${i.variant ? ` (${i.variant})` : ""}`).join(", ") : last.itemsText || "";
      const where = last.kind === "EVENT" ? " at an event stall" : last.kind === "WEBSITE" ? " on the website" : " on WhatsApp";
      lines.push(`Last order ${ago(last.placedAt)}${where}: ${what.slice(0, 200)}`);
    }
    if (m.favouriteProducts.length) lines.push(`Usually buys: ${m.favouriteProducts.slice(0, 3).map((f) => f.name).join(", ")}`);
  } else {
    lines.push(client.createdAt.getTime() > Date.now() - 2 * 60 * 1000 ? "New customer — first time messaging us" : "Has not ordered yet");
  }
  const interests = client.productInterests.map((i) => i.product?.name).filter(Boolean);
  if (interests.length) lines.push(`Asked about before: ${interests.join(", ")}`);
  if (client.address || client.pinCode) lines.push(`Saved delivery address: ${[client.address, client.pinCode].filter(Boolean).join(", ").slice(0, 160)}`);
  if (client.notes?.trim()) lines.push(`Staff note: ${client.notes.trim().slice(0, 200)}`);

  if (conversationId) {
    // When they last talked to us before this message (a gap tells the AI to greet a returning customer warmly).
    const prev = await prisma.message.findFirst({
      where: { conversationId, sender: "CLIENT", createdAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (prev) lines.push(`Last chatted with us ${ago(prev.createdAt)}`);
  }
  if (!lines.length) return "";

  return `CUSTOMER MEMORY — what we already know about the person you're talking to:
${lines.map((l) => `• ${l}`).join("\n")}
Use this the way a friendly shopkeeper remembers a regular: greet a returning customer warmly (by name now and then, not in every message), suggest their usual item when it fits, reuse the saved address instead of asking again (just confirm it), and pick up where you left off. Never read this out as a list, never say you "have records", and don't mention past orders unless it genuinely helps right now. If anything here conflicts with what the customer says now, believe the customer.`;
}
