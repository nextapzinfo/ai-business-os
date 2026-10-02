import { prisma } from "@/lib/prisma";

// Owner Assistant (2026-10-02 follow-up) — owner's own request: "kon kon
// product customer besi ask korche seta ki bolte parbe" (can it tell which
// products customers ask about most). See the ProductMentionLog model comment
// in prisma/schema.prisma for the full design rationale — short version: one
// row per product genuinely named in a customer's own incoming message,
// logged from the webhook's existing findAllProductMatches() result (never
// from the AI's own reply, which can mention products the customer never
// actually asked about), aggregated all-time (owner's own choice when asked —
// no rolling window) by name rather than only by Product.id, since a RETAIL
// org on the live banglardoi.com catalog can have real customer-named
// products with no local Product row at all.

// Called once per incoming customer message with every product confidently
// matched in it (can be zero, one, or several — e.g. "sorbhaja ar baked
// rosogolla koto?" names two). Deliberately swallows its own errors — this is
// a secondary analytics log, never allowed to break the actual customer
// reply if the write fails for any reason (e.g. a transient DB hiccup).
export async function logProductMentions(
  organizationId: string,
  products: { id: string; name: string }[],
  conversationId?: string
): Promise<void> {
  if (products.length === 0) return;
  try {
    await prisma.productMentionLog.createMany({
      data: products.map((p) => ({
        organizationId,
        productId: p.id,
        productName: p.name,
        conversationId,
      })),
    });
  } catch (err) {
    console.error("logProductMentions failed (non-fatal):", err);
  }
}

export type TopAskedProduct = { productName: string; count: number };

// All-time cumulative count, grouped by productName (not productId — see the
// schema comment for why) so a product gets one combined count even if it was
// matched via a local Product row on some messages, or appears without one
// for a live-catalog-only item. Deliberately raw SQL via groupBy rather than
// pulling every row into Node and counting there — this log can legitimately
// grow into the tens of thousands of rows over a busy season, and groupBy
// pushes the aggregation to Postgres instead.
export async function getTopAskedProducts(organizationId: string, limit = 5): Promise<TopAskedProduct[]> {
  const rows = await prisma.productMentionLog.groupBy({
    by: ["productName"],
    where: { organizationId },
    _count: { productName: true },
    orderBy: { _count: { productName: "desc" } },
    take: limit,
  });
  // Explicit element type rather than relying on groupBy()'s inferred return
  // type — this sandbox's local Prisma Client is stale (can't reach
  // binaries.prisma.sh to regenerate against the new ProductMentionLog model,
  // same well-documented environment limitation as every other TS7006 in this
  // repo), so the inferred type isn't trustworthy here. Vercel's own build
  // regenerates the client correctly on deploy.
  type GroupByRow = { productName: string; _count: { productName: number } };
  return (rows as GroupByRow[]).map((r) => ({ productName: r.productName, count: r._count.productName }));
}

// Plain-text tool result for the Owner Assistant's get_top_asked_products
// tool (lib/llm.ts) — same "hand the model real numbers, let it phrase the
// reply naturally" pattern as formatOwnerStatusForTool in owner-assistant.ts.
export function formatTopAskedProductsForTool(products: TopAskedProduct[]): string {
  if (products.length === 0) {
    return "No product mentions have been logged yet (this count only started tracking from 2026-10-02 onward — it has no data from before that). Tell the owner there's nothing to report yet, not that something is broken.";
  }
  const lines: string[] = [
    "All-time count of how many customer messages have named each product (counted only when a customer's own message clearly named it, not when the AI merely mentioned it in a reply):",
  ];
  products.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.productName} — asked about ${p.count} time(s)`);
  });
  lines.push(
    "Summarize this for the owner as a short, natural ranked list in whichever language they're writing in — real numbers, no need to repeat this instruction."
  );
  return lines.join("\n");
}
