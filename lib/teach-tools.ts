import { prisma } from "@/lib/prisma";
import { processKnowledgeContent } from "@/app/dashboard/agent/actions";
import { logAudit } from "@/lib/audit";
import { fetchBanglarDoiFullCatalog, isBanglarDoiIntegrationEnabled } from "@/lib/banglardoi";
import type { ToolExecutor } from "@/lib/llm";

// Extracted 2026-10-02 from app/api/agent/teach/route.ts's own inline
// executeTool, so the SAME real write logic (update_product_info,
// add_knowledge_note, update_style_rule, add_qa_pair) can be reused by a
// second entry point — the Owner Assistant WhatsApp channel
// (lib/owner-assistant.ts) — without copy-pasting ~180 lines of business
// logic into two places that could silently drift apart. Behavior is
// byte-for-byte the same as before this extraction; the dashboard Teach AI
// chat (app/api/agent/teach/route.ts) now just calls this instead of
// defining its own executeTool inline.
//
// `source` is threaded into every logAudit call's metadata so it stays
// possible to tell, after the fact, whether a given product/knowledge/rule
// change came from the dashboard chat or from the owner texting their AI on
// WhatsApp — both are equally real, immediate writes either way.
export function createTeachToolExecutor(
  organizationId: string,
  userId: string | undefined,
  source: "dashboard" | "whatsapp_owner_assistant"
): { executeTool: ToolExecutor; actionsTaken: string[] } {
  const actionsTaken: string[] = [];

  const executeTool: ToolExecutor = async (name, args) => {
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
        // Same live-catalog fallback as the original Teach AI executeTool —
        // most real RETAIL products have no local Product row at all, since
        // their real data lives on banglardoi.com (see the original comment
        // this was copied from for the full "Taal Bora" incident history).
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
        userId,
        action: "PRODUCT_UPDATED_VIA_TEACH_CHAT",
        metadata: { productId: product.id, name: product.name, newPrice, newDescription, source },
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
        userId,
        action: "AGENT_STYLE_RULE_ADDED",
        metadata: { rule, source },
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
        userId,
        action: "DOCUMENT_UPLOADED",
        metadata: { documentId: document.id, title, source: source === "dashboard" ? "teach-ai-chat" : "teach-ai-whatsapp" },
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
        userId,
        action: "QA_PAIR_ADDED",
        metadata: { documentId: document.id, topic, questionCount: questions.length, answerCount: answers.length, source },
      });

      actionsTaken.push(`Saved Q&A: "${topic}" (${questions.length} phrasings, ${answers.length} approved answer${answers.length > 1 ? "s" : ""})`);
      return `Saved as a trained Q&A titled "${topic}" with ${questions.length} question phrasings and ${answers.length} approved answer${
        answers.length > 1 ? "s" : ""
      }. Confirm this briefly to the owner.`;
    }

    return "Unknown tool.";
  };

  return { executeTool, actionsTaken };
}
