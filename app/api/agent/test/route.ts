import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import type { ChatHistoryMessage } from "@/lib/llm";
import { runSandboxReply } from "@/lib/sandbox-reply";

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
    const { answer, sourcesUsed } = await runSandboxReply(organizationId, question, body, history);
    return NextResponse.json({ answer, sourcesUsed });
  } catch (err) {
    console.error("Agent test sandbox failed:", err);
    return NextResponse.json({ error: "Test failed — check server logs." }, { status: 500 });
  }
}
