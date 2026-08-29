import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { embedText, toVectorLiteral } from "@/lib/embeddings";
import {
  askAIWithTools,
  SAVE_ADDRESS_TOOL,
  SET_REMINDER_TOOL,
  RECORD_INTEREST_TOOL,
  PLACE_ORDER_TOOL,
  REQUEST_HANDOFF_TOOL,
  SEND_PRODUCT_PHOTO_TOOL,
  applyTerminologySwaps,
  stripHallucinatedProductListings,
  type ToolDefinition,
  type ChatHistoryMessage,
  type CatalogProduct,
} from "@/lib/llm";
import { logAiUsage } from "@/lib/billing";
import { fetchBoostedQAChunk } from "@/lib/qa-retrieval";
import { fetchBanglarDoiFullCatalog, isBanglarDoiIntegrationEnabled } from "@/lib/banglardoi";

// Sandbox tool execution never touches the real database — it just describes
// what would happen, so staff can preview the skill without creating fake
// clients/reminders. Matches the "nothing here reaches real customers or gets
// logged" promise shown in the Test Sandbox UI.
async function simulateTool(name: string, args: Record<string, any>): Promise<string> {
  if (name === "request_human_handoff") {
    return `[Sandbox only — not actually paused] Would hand off to a staff member. Reason: ${args.reason}`;
  }
  if (name === "send_product_photo") {
    return `[SANDBOX SIMULATION — no real photo was sent, this window can't display images at all] In a real WhatsApp chat, a photo of "${args.productName}" would be sent now (if one is saved for that product). Tell the tester plainly and consistently that this is just a sandbox simulation and no image was actually sent here — do NOT say "I've sent the photo" or similar, and do NOT apologize for a delivery failure either, since nothing was attempted. Just state clearly this is a test/simulation.`;
  }
  if (name === "save_customer_address") {
    return `[Sandbox only — not actually saved] Would save address: ${args.address}`;
  }
  if (name === "set_reminder") {
    return `[Sandbox only — not actually created] Would set reminder "${args.title}" on ${args.dueDate}`;
  }
  if (name === "record_product_interest") {
    return `[Sandbox only — not actually recorded] Would note interest in "${args.productName}"${
      args.note ? ` (${args.note})` : ""
    }`;
  }
  if (name === "record_order") {
    return `[Sandbox only — not actually recorded] Would record order: ${args.items}${
      args.deliveryAddress ? ` — deliver to: ${args.deliveryAddress}` : ""
    }${args.note ? ` (${args.note})` : ""}`;
  }
  return "Unknown tool.";
}

// Staff-only sandbox: lets Agent Studio test a question against the real
// knowledge base using whatever profile settings are CURRENTLY TYPED in the
// form (not yet saved), without touching Client/Conversation/Message tables
// or sending anything on WhatsApp. This is how a draft gets tried safely
// before "Save Changes" makes it live for real customers.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const organizationId = (session?.user as { organizationId?: string } | undefined)?.organizationId;
  if (!organizationId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const question = (body.question as string)?.trim();
  if (!question) {
    return NextResponse.json({ error: "Missing question" }, { status: 400 });
  }

  // Prior sandbox turns (sent by AgentStudioClient as {role, text} pairs) —
  // same fix as the live webhook: without this, each test message was
  // answered with zero memory of what was asked/said just before it.
  const historyIn = Array.isArray(body.history) ? body.history : [];
  const history: ChatHistoryMessage[] = historyIn
    .filter((m: any) => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
    .map((m: any) => ({ role: m.role, content: m.content }));

  try {
    const queryEmbedding = await embedText(question, "query");
    const vectorLiteral = toVectorLiteral(queryEmbedding);

    const results = (await prisma.$queryRaw`
      SELECT dc.content as content, d.title as "documentTitle", d.id as "documentId"
      FROM "DocumentChunk" dc
      JOIN "Document" d ON d.id = dc."documentId"
      WHERE dc."organizationId" = ${organizationId}
      ORDER BY dc.embedding <=> ${vectorLiteral}::vector ASC
      LIMIT 5
    `) as { content: string; documentTitle: string; documentId: string }[];

    // Same Trained-Q&A boost as the live webhook (see lib/qa-retrieval.ts) —
    // without this, the sandbox would give a rosier or gloomier preview than
    // what a real customer actually gets, defeating its whole purpose.
    const boostedQA = await fetchBoostedQAChunk(organizationId, vectorLiteral);
    if (boostedQA && !results.some((r) => r.documentId === boostedQA.documentId)) {
      results.push(boostedQA);
    }

    // Same catalog list the live webhook now sends — without this, the sandbox
    // can't actually preview minimum-order enforcement or hallucination
    // stripping, since both depend on this being populated (see webhook
    // route.ts for the full explanation of why this matters).
    const localCatalogProducts: CatalogProduct[] = await prisma.product.findMany({
      where: { organizationId },
      select: { name: true, price: true, description: true },
    });

    // Prefer banglardoi.com's own live, structured catalog here too — same
    // logic as app/api/whatsapp/webhook/route.ts. Added 2026-08-29: this
    // sandbox was ALWAYS using only the bare local Product table above
    // (name/price/description, no variants, no compareAtPrice, no bundle
    // contents), even for RETAIL orgs with the live integration on — so it
    // could never actually preview real per-pack pricing, bulk-discount
    // "was" prices, or Combo/Gift contents the way a real WhatsApp customer
    // sees them. That's exactly why testing "besi nile discount hobe?" here
    // gave a "let me check with the team" answer instead of surfacing the
    // real, already-discounted 3-pack: the sandbox had no variant data at
    // all to work with, live or otherwise. Kept as a getServerSession-scoped
    // read (no caller-supplied organizationId) rather than trusting the
    // request body, matching this route's existing auth pattern.
    let catalogProducts: CatalogProduct[] = localCatalogProducts;
    const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
    if (organization?.vertical === "RETAIL" && isBanglarDoiIntegrationEnabled()) {
      const liveCatalog = await fetchBanglarDoiFullCatalog();
      if (liveCatalog && liveCatalog.products.length > 0) {
        catalogProducts = liveCatalog.products.map((p) => ({
          name: p.name,
          price: p.variants.length > 0 ? p.variants.map((v) => `${v.label}: ${v.price}`).join(", ") : p.pricePerPiece,
          description: p.description,
          category: p.category,
          variants: p.variants.map((v) => ({
            label: v.label,
            price: v.price,
            minOrderQty: v.minOrderQty,
            compareAtPrice: v.compareAtPrice,
          })),
          bundleItems: p.bundleItems.map((b) => ({
            quantity: b.quantity,
            name: b.name,
            variantLabel: b.variantLabel,
          })),
        }));
      }
    }

    const tools: ToolDefinition[] = [REQUEST_HANDOFF_TOOL, SEND_PRODUCT_PHOTO_TOOL];
    if (body.skillSaveAddress) tools.push(SAVE_ADDRESS_TOOL);
    if (body.skillReminders) tools.push(SET_REMINDER_TOOL);
    if (body.skillTrackInterest) tools.push(RECORD_INTEREST_TOOL);
    if (body.skillTakeOrders) tools.push(PLACE_ORDER_TOOL);

    // The live webhook precomputes a real photoNote from an actual RAG/product
    // match — the sandbox has no real conversation/product-matching context to
    // do that with, so without SOME note here the model gets zero information
    // about its photo capability and falls back to a generic "I can't share
    // images" refusal reflex, even with the tool available. This generic note
    // at least tells it the capability exists and how to use it.
    const sandboxPhotoNote = `You have a send_product_photo tool for sending product photos on WhatsApp — you DO have this capability. If the customer asks to see a photo of a specific product (including one mentioned earlier in this test conversation), call send_product_photo with that product's exact name. Never say you're generally unable to share images or photo links. (This is the Test Sandbox — the tool call is simulated, nothing is actually sent.)`;

    const { answer, usage } = await askAIWithTools(
      question,
      results.map((r) => ({ title: r.documentTitle, content: r.content })),
      {
        businessName: body.businessName,
        businessDescription: body.businessDescription,
        coreIdentity: body.coreIdentity,
        customInstructions: body.customInstructions,
        brandLanguage: body.brandLanguage,
        tone: body.tone,
        languageStyle: body.languageStyle,
      },
      tools,
      simulateTool,
      history,
      sandboxPhotoNote,
      catalogProducts
    );
    // Sandbox testing still burns real OpenAI tokens (the model call is real, only
    // the tool side-effects are simulated) — log it so Billing reflects true spend.
    await logAiUsage(organizationId, "sandbox_test", usage);

    // Same deterministic hallucination backstop + guaranteed brand-vocabulary
    // enforcement as the live webhook — so the sandbox reply staff sees is
    // exactly what a real customer would get, not a rosier preview.
    const hallucinationChecked = stripHallucinatedProductListings(answer, catalogProducts);
    const finalAnswer = applyTerminologySwaps(hallucinationChecked, body.brandLanguage);

    return NextResponse.json({ answer: finalAnswer, sourcesUsed: results.length });
  } catch (err) {
    console.error("Agent test sandbox failed:", err);
    return NextResponse.json({ error: "Test failed — check server logs." }, { status: 500 });
  }
}
