import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { askTeachAI, UPDATE_PRODUCT_INFO_TOOL, ADD_KNOWLEDGE_NOTE_TOOL, type ChatHistoryMessage } from "@/lib/llm";
import { processKnowledgeContent } from "@/app/dashboard/agent/actions";
import { logAudit } from "@/lib/audit";
import { logAiUsage } from "@/lib/billing";

// Teach AI chat (Training page) — lets the owner update products/knowledge by
// chatting naturally, same idea as Meta's own built-in Business Agent chat.
// Unlike the Test Sandbox, tool calls here are REAL — they write to the
// actual Product/Document tables that the live WhatsApp AI reads from.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const user = session?.user as { organizationId?: string; id?: string } | undefined;
  const organizationId = user?.organizationId;
  if (!organizationId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

    return "Unknown tool.";
  }

  try {
    const { answer, usage } = await askTeachAI(
      message,
      history,
      [UPDATE_PRODUCT_INFO_TOOL, ADD_KNOWLEDGE_NOTE_TOOL],
      executeTool
    );
    await logAiUsage(organizationId, "teach_ai_chat", usage);

    return NextResponse.json({ answer, actionsTaken });
  } catch (err) {
    console.error("Teach AI chat failed:", err);
    return NextResponse.json({ error: "Something went wrong — check server logs." }, { status: 500 });
  }
}
