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
  type ToolDefinition,
  type ChatHistoryMessage,
} from "@/lib/llm";

// Sandbox tool execution never touches the real database — it just describes
// what would happen, so staff can preview the skill without creating fake
// clients/reminders. Matches the "nothing here reaches real customers or gets
// logged" promise shown in the Test Sandbox UI.
async function simulateTool(name: string, args: Record<string, any>): Promise<string> {
  if (name === "request_human_handoff") {
    return `[Sandbox only — not actually paused] Would hand off to a staff member. Reason: ${args.reason}`;
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
      SELECT dc.content as content, d.title as "documentTitle"
      FROM "DocumentChunk" dc
      JOIN "Document" d ON d.id = dc."documentId"
      WHERE dc."organizationId" = ${organizationId}
      ORDER BY dc.embedding <=> ${vectorLiteral}::vector ASC
      LIMIT 5
    `) as { content: string; documentTitle: string }[];

    const tools: ToolDefinition[] = [REQUEST_HANDOFF_TOOL];
    if (body.skillSaveAddress) tools.push(SAVE_ADDRESS_TOOL);
    if (body.skillReminders) tools.push(SET_REMINDER_TOOL);
    if (body.skillTrackInterest) tools.push(RECORD_INTEREST_TOOL);
    if (body.skillTakeOrders) tools.push(PLACE_ORDER_TOOL);

    const answer = await askAIWithTools(
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
      history
    );

    return NextResponse.json({ answer, sourcesUsed: results.length });
  } catch (err) {
    console.error("Agent test sandbox failed:", err);
    return NextResponse.json({ error: "Test failed — check server logs." }, { status: 500 });
  }
}
