import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  askTeachAI,
  UPDATE_PRODUCT_INFO_TOOL,
  ADD_KNOWLEDGE_NOTE_TOOL,
  UPDATE_STYLE_RULE_TOOL,
  ADD_QA_PAIR_TOOL,
  type ChatHistoryMessage,
} from "@/lib/llm";
import { createTeachToolExecutor } from "@/lib/teach-tools";
import { logAiUsage } from "@/lib/billing";

// Teach AI chat (Training page) — lets the owner update products/knowledge by
// chatting naturally, same idea as Meta's own built-in Business Agent chat.
// Unlike the Test Sandbox, tool calls here are REAL — they write to the
// actual Product/Document tables that the live WhatsApp AI reads from.
//
// 2026-10-02: the 4 tools' real write logic (update_product_info,
// add_knowledge_note, update_style_rule, add_qa_pair) moved to
// lib/teach-tools.ts's createTeachToolExecutor() so the new Owner Assistant
// WhatsApp channel (lib/owner-assistant.ts) can reuse the exact same,
// already-working logic instead of a second hand-copied version — nothing
// about this route's own behavior changed in that move.
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

  const { executeTool, actionsTaken } = createTeachToolExecutor(organizationId, user?.id, "dashboard");

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
