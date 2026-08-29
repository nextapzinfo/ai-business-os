import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  askTeachAI,
  UPDATE_PRODUCT_INFO_TOOL,
  ADD_KNOWLEDGE_NOTE_TOOL,
  UPDATE_STYLE_RULE_TOOL,
  ADD_QA_PAIR_TOOL,
  type ChatHistoryMessage,
} from "@/lib/llm";
import { processKnowledgeContent } from "@/app/dashboard/agent/actions";
import { logAudit } from "@/lib/audit";
import { logAiUsage } from "@/lib/billing";
import { fetchBanglarDoiFullCatalog, isBanglarDoiIntegrationEnabled } from "@/lib/banglardoi";

// Teach AI chat (Training page) — lets the owner update products/knowledge by
// chatting naturally, same idea as Meta's own built-in Business Agent chat.
// Unlike the Test Sandbox, tool calls here are REAL — they write to the
// actual Product/Document tables that the live WhatsApp AI reads from.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const user = session?.user as { organizationId?: string; id?: string } | undefined;
  const organizationIdMaybe = user?.organizationId;
  if (!organizationIdMaybe) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Re-bound to a definitely-string const — TypeScript's narrowing from the
  // guard above doesn't carry into the nested executeTool closure otherwise.
  const organizationId: string = organizationIdMaybe;

  const body = await req.json();
  const message = (body.message as string)?.trim();
  if (!message) {
    return NextResponse.json({ error: "Missing message" }, { status: 400 });
  }

  const historyIn = Array.isArray(body.history) ? body.history : [];
  const history: ChatHistoryMessage[] = historyIn
    .filter((m: any) => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
    .map((m: any) => ({ role: m.role, content: m.content }));

  const actionsTaken: string[] = [];

  async function executeTool(name: string, args: Record<string, any>): Promise<string> {
    if (name === "update_product_info") {
      const productName = (args.productName as string)?.trim();
      if (!productName) return "No product name given — nothing updated.";

      const product = await prisma.product.findFirst({
        where: {
          organizationId,
          OR: [
            { name: { contains: productName, mode: "insensitive" } },
            { description: { contains: productName, mode: "insensitive" } },
          ],
        },
      });
      if (!product) {
        // Added 2026-08-29 — root cause of "Taal Bora" being unfixable from
        // Teach AI even though it's a real, launched, priced product: this
        // lookup only ever checked the local Product table, but a RETAIL org
        // with the live banglardoi.com integration on sources its REAL
        // catalog straight from banglardoi.com instead (see lib/banglardoi.ts
        // / app/api/whatsapp/webhook/route.ts) — most real products, this one
        // included, simply have no local Product row to find. Before giving
        // up, check the live catalog too so the owner isn't told a real,
        // active product "doesn't exist."
        const organization = await prisma.organization.findUnique({ where: { id: organizationId } });
        if (organization?.vertical === "RETAIL" && isBanglarDoiIntegrationEnabled()) {
          const liveCatalog = await fetchBanglarDoiFullCatalog();
          const liveMatch = liveCatalog?.products.find((p) =>
            p.name.toLowerCase().includes(productName.toLowerCase())
          );
          if (liveMatch) {
            const priceText =
              liveMatch.variants.length > 0
                ? liveMatch.variants.map((v) => `${v.label}: ${v.price}`).join(", ")
                : liveMatch.pricePerPiece;
            return `"${liveMatch.name}" is a REAL, currently live product on banglardoi.com (not in the local Products list here) — current price: ${priceText}. Its price/description live on banglardoi.com's own Admin → Products page and can't be edited from this chat. Tell the owner this plainly, quote them the live price above so they know it's correct, and if the issue is that the AI itself was giving a wrong/stale answer about this product (e.g. an old "coming soon" note), offer to fix that by saving a corrected Trained Q&A with add_qa_pair instead — that's what actually controls what the AI says, separately from the real catalog price.`;
          }
        }
        return `No product found matching "${productName}" — tell the owner honestly you couldn't find it, and ask them to check the exact name on the Products page.`;
      }

      const newPrice = (args.newPrice as string)?.trim();
      const newDescription = (args.newDescription as string)?.trim();
      if (!newPrice && !newDescription) {
        return `Found "${product.name}" but no new price or description was given — ask the owner what specifically should change.`;
      }

      const updatedPrice = newPrice || product.price;
      const updatedDescription = newDescription || product.description;

      await prisma.product.update({
        where: { id: product.id },
        data: {
          price: updatedPrice || null,
          description: updatedDescription || null,
        },
      });

      // Re-chunk + re-embed so the AI's WhatsApp answers reflect this immediately.
      await prisma.documentChunk.deleteMany({ where: { documentId: product.documentId } });
      const parts = [product.name];
      if (updatedPrice) parts.push(`Price: ${updatedPrice}`);
      if (updatedDescription) parts.push(updatedDescription);
      await processKnowledgeContent(organizationId, product.documentId, parts.join(". "));

      await logAudit({
        organizationId,
        userId: user?.id,
        action: "PRODUCT_UPDATED_VIA_TEACH_CHAT",
        metadata: { productId: product.id, name: product.name, newPrice, newDescription },
      });

      actionsTaken.push(`Updated "${product.name}"${newPrice ? ` — price: ${newPrice}` : ""}${newDescription ? " — description updated" : ""}`);
      return `Updated "${product.name}" successfully.${newPrice ? ` New price: ${newPrice}.` : ""}${newDescription ? " Description updated." : ""} Confirm this briefly to the owner.`;
    }

    if (name === "update_style_rule") {
      const rule = (args.rule as string)?.trim();
      if (!rule) return "No rule text given — nothing saved.";

      const existing = await prisma.agentProfile.findUnique({ where: { organizationId } });
      const combined = existing?.customInstructions?.trim()
        ? `${existing.customInstructions.trim()}\n- ${rule}`
        : `- ${rule}`;

      await prisma.agentProfile.upsert({
        where: { organizationId },
        update: { customInstructions: combined },
        create: { organizationId, customInstructions: combined },
      });

      await logAudit({
        organizationId,
        userId: user?.id,
        action: "AGENT_STYLE_RULE_ADDED",
        metadata: { rule },
      });

      actionsTaken.push(`Added standing rule: "${rule}"`);
      return `Saved as a standing rule — the AI will follow this on every future reply, not just when a related question is asked: "${rule}". Confirm this briefly to the owner.`;
    }

    if (name === "add_knowledge_note") {
      const title = (args.title as string)?.trim();
      const content = (args.content as string)?.trim();
      if (!title || !content) return "Missing title or content — nothing saved.";

      const document = await prisma.document.create({
        data: {
          organizationId,
          title,
          fileUrl: "teach-ai-chat",
          status: "PENDING",
        },
      });
      await processKnowledgeContent(organizationId, document.id, content);

      await logAudit({
        organizationId,
        userId: user?.id,
        action: "DOCUMENT_UPLOADED",
        metadata: { documentId: document.id, title, source: "teach-ai-chat" },
      });

      actionsTaken.push(`Saved new note: "${title}"`);
      return `Saved as a new knowledge note titled "${title}". Confirm this briefly to the owner.`;
    }

    if (name === "add_qa_pair") {
      const questions = Array.isArray(args.questions)
        ? (args.questions as unknown[]).filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        : [];
      const answers = Array.isArray(args.answers)
        ? (args.answers as unknown[]).filter((a): a is string => typeof a === "string" && a.trim().length > 0)
        : [];
      if (questions.length === 0 || answers.length === 0) {
        return "Missing questions or answers — nothing saved.";
      }

      const topic = (args.topic as string)?.trim() || questions[0].slice(0, 60);

      // One coherent block, run through the SAME chunk+embed pipeline as
      // add_knowledge_note (processKnowledgeContent) — chunkText's 1000-char
      // chunk size comfortably fits a handful of phrasings + answers as one
      // piece, so this stays a single embedded chunk rather than getting
      // split apart. Listing several phrasings together (rather than one
      // freeform sentence) is what makes this reliably findable even when a
      // real customer asks in yet another, slightly different way — the
      // retrieval below is nearest-neighbor over this whole block's meaning,
      // not an exact-string match against any one phrasing.
      const content = `Trained Q&A — "${topic}"

A customer might ask this in different ways, for example:
${questions.map((q) => `- ${q.trim()}`).join("\n")}

Answer using one of these approved answers, in your own natural words — stay faithful to what they say, don't contradict them:
${answers.map((a) => `- ${a.trim()}`).join("\n")}`;

      const document = await prisma.document.create({
        data: {
          organizationId,
          title: `Q&A: ${topic}`,
          fileUrl: "teach-ai-qa",
          status: "PENDING",
        },
      });
      await processKnowledgeContent(organizationId, document.id, content);

      await logAudit({
        organizationId,
        userId: user?.id,
        action: "QA_PAIR_ADDED",
        metadata: { documentId: document.id, topic, questionCount: questions.length, answerCount: answers.length },
      });

      actionsTaken.push(`Saved Q&A: "${topic}" (${questions.length} phrasings, ${answers.length} approved answer${answers.length > 1 ? "s" : ""})`);
      return `Saved as a trained Q&A titled "${topic}" with ${questions.length} question phrasings and ${answers.length} approved answer${
        answers.length > 1 ? "s" : ""
      }. Confirm this briefly to the owner.`;
    }

    return "Unknown tool.";
  }

  try {
    const { answer, usage } = await askTeachAI(
      message,
      history,
      [UPDATE_PRODUCT_INFO_TOOL, ADD_KNOWLEDGE_NOTE_TOOL, UPDATE_STYLE_RULE_TOOL, ADD_QA_PAIR_TOOL],
      executeTool
    );
    await logAiUsage(organizationId, "teach_ai_chat", usage);

    return NextResponse.json({ answer, actionsTaken });
  } catch (err) {
    console.error("Teach AI chat failed:", err);
    return NextResponse.json({ error: "Something went wrong — check server logs." }, { status: 500 });
  }
}
