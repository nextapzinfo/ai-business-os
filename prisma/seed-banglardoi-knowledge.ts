// One-time (re-runnable) script that loads Banglar Doi's product/policy/brand
// knowledge straight into the Knowledge Base — same Document + DocumentChunk +
// embedding pipeline as the Agent Studio "paste text" form
// (app/dashboard/agent/actions.ts's processKnowledgeContent), just run from a
// script instead of clicked through the UI one section at a time.
//
// Run locally after `git pull` (needs your real .env with DATABASE_URL and
// OPENAI_API_KEY filled in — this project only ships .env.example, the real
// values are never committed):
//
//   npm run seed:knowledge
//
// Safe to re-run — it deletes and recreates its own six seeded documents
// each time (matched by the SEEDED_BY marker in fileUrl below), so re-running
// after editing the CONTENT further down just refreshes them instead of
// duplicating. It never touches documents you added yourself through the
// Knowledge tab UI.
//
// If your database has more than one Organization row, set ORG_SLUG in your
// .env (or inline: ORG_SLUG=your-slug npm run seed:knowledge) to pick which
// one gets this content — with just one org (the normal case today) it's
// found automatically.

import { PrismaClient } from "@prisma/client";
import { chunkText } from "../lib/chunk";
import { embedText, toVectorLiteral } from "../lib/embeddings";

const prisma = new PrismaClient();

const SEEDED_BY = "seeded:banglardoi-knowledge-script";

const SECTIONS: { title: string; content: string }[] = [
  {
    title: "Products & Pricing",
    content: `Banglar Doi sells authentic Bengali sweets, doi (yoghurt), ghee, and honey. Current catalog (name — pack/variant — price):

- Laal Kheer Doi — 500g (Approx.) — ₹180
- Sorbhoja — Per piece — ₹50
- Baked Rosogolla — Per piece — ₹30
- Baked Kheer Malai — Per piece — ₹60
- Premium Desi Cow Ghee — 100ml — ₹110
- Baked Kheer Patisapta — Per piece — ₹50
- Chanabhaja — Per piece — ₹25
- Kheer Gulab Jamun — Standard Pack — ₹20
- Kamolabhog — Standard Pack, per piece — ₹25
- Malai Chop — Per piece — ₹30
- 2 in 1 Rosogolla — Standard Pack, per piece — ₹25
- Chana Vapa Paturi — Standard Pack, per piece — ₹60
- Dudh Puli — Standard Pack, per piece — ₹30
- Kalojam — Standard Pack, per piece — ₹30
- Jaggery Powder (Nalen Gur) — Standard Pack — ₹300
- Sundarbon Raw Honey — Standard Pack — ₹70
- Rosogolla — Standard Pack — ₹20
- Laddu — Standard Pack — ₹15

Some products also have larger pack sizes (e.g. 500g / 1kg / 2.5kg) shown on their individual product pages on the site — prices and stock change over time, so for the most current price/availability point the customer to the live site (banglardoi.com) or the exact product page rather than quoting an old number with full confidence. For live, real-time stock/price on a specific pack size, or a specific customer's order status, use the Banglar Doi order-status/product-stock integration tools instead of this document.`,
  },
  {
    title: "Categories",
    content: `Banglar Doi's products are organized into these categories: All, Mishti (sweets), Doi (yoghurt), Ghee, Pithe-Puli, Combo, Gift Box.`,
  },
  {
    title: "Delivery, Minimum Order & Payment",
    content: `- Free delivery on orders above ₹500.
- Delivery in 1–2 days across Kolkata.
- Orders are packed with cold chain packing to keep sweets/doi fresh in transit.
- Cash on Delivery (COD) may or may not be available depending on the delivery area — this is set per delivery zone by the admin and can change, so confirm COD availability for the customer's specific pincode rather than assuming it's always on.
- Delivery fee, minimum order value, and estimated delivery days can vary by area/pincode — these are configured in Banglar Doi's Admin → Delivery panel and may differ from the ₹500 free-delivery figure above for specific zones. Treat the ₹500 / 1–2 day figures as the general/default case, not a guarantee for every pincode.`,
  },
  {
    title: "Ordering Process & Account",
    content: `- Customers can browse and add items to cart without logging in.
- Placing an order requires mobile number + OTP verification (mandatory login) — there is no guest checkout past the "Place Order" step.
- After OTP verification, the customer fills in their delivery address, then completes payment.
- Orders can be tracked at banglardoi.com/track-order, and logged-in customers can see their order history and saved addresses under Account.
- Each order gets an order number (format like BD + digits, e.g. BD2608179585) that customers can reference when asking about order status. For a specific customer's real order status, use the Banglar Doi order-status integration tool rather than guessing.`,
  },
  {
    title: "Brand Story / Why Choose Banglar Doi",
    content: `Banglar Doi (by M M SHOPPE) makes authentic Bengali sweets and doi using traditional recipes, made fresh with no artificial preservatives and hygienic packing. Tagline: "Heritage of Bengal." Why customers choose Banglar Doi: pure ingredients, traditional recipes, no artificial preservatives, hygienically packed, delivered across India, premium quality, 100% authentic, made fresh daily.

The brand's fuller story: it started with a simple belief that the authentic taste of Bengal deserves to be preserved — what began in a small kitchen with age-old recipes is now loved by thousands of families, with every recipe carrying forward that legacy: no shortcuts, no compromises, honest ingredients, age-old methods.`,
  },
  {
    title: "Contact & Support",
    content: `For questions the AI can't confidently answer (real-time stock for a specific pack size, delivery to a specific pincode, order-specific issues), it should offer to connect the customer with a real person on Banglar Doi's WhatsApp number, or point them to banglardoi.com/track-order for order status.`,
  },
];

async function resolveOrganization() {
  const slugOverride = process.env.ORG_SLUG?.trim();
  if (slugOverride) {
    const org = await prisma.organization.findUnique({ where: { slug: slugOverride } });
    if (!org) throw new Error(`No Organization found with slug "${slugOverride}" (from ORG_SLUG).`);
    return org;
  }

  const orgs = await prisma.organization.findMany({ select: { id: true, name: true, slug: true } });
  if (orgs.length === 0) throw new Error("No Organization rows exist yet — create one first (e.g. via prisma/seed.ts).");
  if (orgs.length === 1) return orgs[0];

  throw new Error(
    `Found ${orgs.length} Organizations — set ORG_SLUG to pick one: ${orgs.map((o) => o.slug).join(", ")}`
  );
}

async function processContent(organizationId: string, documentId: string, content: string) {
  const pieces = chunkText(content.trim());
  for (let i = 0; i < pieces.length; i++) {
    const chunk = await prisma.documentChunk.create({
      data: { organizationId, documentId, content: pieces[i], chunkIndex: i },
    });
    const embedding = await embedText(pieces[i], "document");
    const vectorLiteral = toVectorLiteral(embedding);
    await prisma.$executeRaw`
      UPDATE "DocumentChunk" SET embedding = ${vectorLiteral}::vector WHERE id = ${chunk.id}
    `;
  }
  await prisma.document.update({ where: { id: documentId }, data: { status: "PROCESSED", content: content.trim() } });
}

async function main() {
  const org = await resolveOrganization();
  console.log(`Seeding Banglar Doi knowledge into organization "${org.name}" (${org.slug})...`);

  // Remove any previous run's seeded docs first, so re-running this script
  // after editing SECTIONS above replaces rather than duplicates them.
  const previous = await prisma.document.findMany({
    where: { organizationId: org.id, fileUrl: SEEDED_BY },
    select: { id: true },
  });
  if (previous.length > 0) {
    await prisma.document.deleteMany({ where: { id: { in: previous.map((d) => d.id) } } });
    console.log(`Removed ${previous.length} previously-seeded document(s).`);
  }

  for (const section of SECTIONS) {
    const document = await prisma.document.create({
      data: { organizationId: org.id, title: section.title, fileUrl: SEEDED_BY, status: "PENDING" },
    });
    try {
      await processContent(org.id, document.id, section.content);
      console.log(`✓ ${section.title}`);
    } catch (err) {
      await prisma.document.update({ where: { id: document.id }, data: { status: "FAILED" } });
      console.error(`✗ ${section.title} —`, err);
    }
  }

  console.log("Done. Check Agent Studio → Knowledge tab to see the new entries.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
