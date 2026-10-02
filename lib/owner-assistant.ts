import { prisma } from "@/lib/prisma";
import {
  askOwnerAssistant,
  GET_PENDING_ITEMS_TOOL,
  UPDATE_PRODUCT_INFO_TOOL,
  ADD_KNOWLEDGE_NOTE_TOOL,
  UPDATE_STYLE_RULE_TOOL,
  ADD_QA_PAIR_TOOL,
  type ChatHistoryMessage,
  type ToolExecutor,
} from "@/lib/llm";
import { createTeachToolExecutor } from "@/lib/teach-tools";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { logAiUsage } from "@/lib/billing";

// Owner Assistant (2026-10-02) — a personal, privileged WhatsApp channel for
// the business owner, separate from the customer-facing sales-agent flow
// this same app runs on the same number. Owner's own request, verbatim:
// "amar personal AI assistant amake help korbe, ki ki chat baki ache -
// bcoze ei chat gulo computer e thake, or software r modhe - direct wts app
// e thake na - tai segulo amar personal akta selected no 8017011018 e AI
// bolbe - kono Human interface r darkar ache kina, ba kichu update korle
// ami sekhane ai ke bolbo - seta thik kore debe."
//
// Routing: app/api/whatsapp/webhook/route.ts checks, right after it resolves
// `organization`/`agentProfile` and BEFORE any customer Client/Conversation
// logic runs, whether the inbound message's `from` matches
// AgentProfile.ownerAssistantPhone exactly (digits-only, country-code
// normalized — see normalizeOwnerPhone below) AND skillOwnerAssistant is on.
// If so, it calls handleOwnerAssistantMessage below and returns immediately
// — the owner's own number NEVER becomes a Client, NEVER enters the customer
// Conversations list, and NEVER reaches the customer sales-agent prompt.
//
// The owner's side of this conversation is still logged (its own
// Client+Conversation row, channel "OWNER_ASSISTANT") purely so multi-turn
// context works ("he already told it the price change two messages ago") —
// this is an internal admin thread, not a customer record.

// Matches banglardoi.com's own toWhatsAppId() convention (src/lib/whatsapp.ts)
// so a phone typed into Agent Studio in any common format ("8017011018",
// "+91 8017011018", "91-8017011018"...) still compares equal to what Meta
// sends as message.from (digits only, country code first, no "+").
export function normalizeOwnerPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

const OWNER_ASSISTANT_CHANNEL = "OWNER_ASSISTANT";
const OWNER_ASSISTANT_CLIENT_SOURCE = "OWNER_ASSISTANT";
const OWNER_HISTORY_LIMIT = 20;
const STATUS_SAMPLE_LIMIT = 8;

export type OwnerStatusSnapshot = {
  escalatedCount: number;
  staffHandlingCount: number;
  unreadCount: number;
  pendingInsightCount: number;
  pendingHandoffInsightCount: number;
  escalatedSamples: { name: string; phone: string; reason: string | null }[];
  unreadSamples: { name: string; phone: string }[];
  totalNeedsAttention: number;
};

// The single source of truth both the on-demand get_pending_items tool AND
// the daily digest cron (app/api/cron/owner-digest/route.ts) read from —
// deliberately real queries against Conversation/ConversationInsight/
// HandoffInsight, never anything estimated or cached, since the whole point
// is the owner trusting these numbers over having to open the dashboard.
export async function getOwnerStatusSnapshot(organizationId: string): Promise<OwnerStatusSnapshot> {
  const [escalatedConvos, staffHandlingCount, openNonPaused, pendingInsightCount, pendingHandoffInsightCount] =
    await Promise.all([
      prisma.conversation.findMany({
        where: { organizationId, status: "ESCALATED" },
        include: { client: { select: { name: true, phone: true } } },
        orderBy: { createdAt: "desc" },
      }),
      // "Staff actively handling" (aiPaused=true) is its own bucket from
      // "escalated" (the AI itself asked for a human) — a conversation can be
      // aiPaused without ever having been ESCALATED (staff can pause any
      // time), so these two counts are NOT mutually exclusive subsets of one
      // another and are reported separately rather than summed blindly.
      prisma.conversation.count({ where: { organizationId, aiPaused: true, status: { not: "CLOSED" } } }),
      // No stored "is this conversation unread" boolean exists (see the
      // Conversation.lastReadAt comment in schema.prisma) — same
      // last-message-vs-lastReadAt comparison the Conversations list sidebar
      // itself uses, just computed here instead of only in the UI.
      prisma.conversation.findMany({
        where: { organizationId, status: "OPEN", aiPaused: false },
        select: {
          lastReadAt: true,
          client: { select: { name: true, phone: true } },
          messages: { orderBy: { createdAt: "desc" }, take: 1, select: { sender: true, createdAt: true } },
        },
      }),
      prisma.conversationInsight.count({ where: { organizationId, status: "PENDING" } }),
      prisma.handoffInsight.count({ where: { organizationId, status: "PENDING" } }),
    ]);

  const unreadConvos = openNonPaused.filter((c) => {
    const last = c.messages[0];
    if (!last || last.sender !== "CLIENT") return false;
    return !c.lastReadAt || last.createdAt > c.lastReadAt;
  });

  const escalatedCount = escalatedConvos.length;
  const unreadCount = unreadConvos.length;

  return {
    escalatedCount,
    staffHandlingCount,
    unreadCount,
    pendingInsightCount,
    pendingHandoffInsightCount,
    escalatedSamples: escalatedConvos.slice(0, STATUS_SAMPLE_LIMIT).map((c) => ({
      name: c.client.name,
      phone: c.client.phone,
      reason: c.handoffReason,
    })),
    unreadSamples: unreadConvos.slice(0, STATUS_SAMPLE_LIMIT).map((c) => ({
      name: c.client.name,
      phone: c.client.phone,
    })),
    totalNeedsAttention: escalatedCount + staffHandlingCount + unreadCount + pendingInsightCount + pendingHandoffInsightCount,
  };
}

// Turns a snapshot into the plain-text tool result the model sees after
// calling get_pending_items — it then writes the owner a short natural-
// language reply from this, in whichever language they're using.
export function formatOwnerStatusForTool(snapshot: OwnerStatusSnapshot): string {
  if (snapshot.totalNeedsAttention === 0) {
    return "Nothing needs attention right now: no escalated conversations, no staff-handling conversations, no unread customer messages, and no pending self-review findings. Tell the owner everything looks clear.";
  }

  const lines: string[] = [];
  lines.push(`${snapshot.escalatedCount} conversation(s) the AI itself escalated (asked for a human):`);
  if (snapshot.escalatedSamples.length > 0) {
    for (const s of snapshot.escalatedSamples) {
      lines.push(`  - ${s.name} (${s.phone})${s.reason ? ` — ${s.reason}` : ""}`);
    }
    if (snapshot.escalatedCount > snapshot.escalatedSamples.length) {
      lines.push(`  ...and ${snapshot.escalatedCount - snapshot.escalatedSamples.length} more.`);
    }
  }
  lines.push(`${snapshot.staffHandlingCount} conversation(s) currently paused for staff to handle personally.`);
  lines.push(`${snapshot.unreadCount} conversation(s) with an unread customer message, no reply sent yet:`);
  if (snapshot.unreadSamples.length > 0) {
    for (const s of snapshot.unreadSamples) {
      lines.push(`  - ${s.name} (${s.phone})`);
    }
    if (snapshot.unreadCount > snapshot.unreadSamples.length) {
      lines.push(`  ...and ${snapshot.unreadCount - snapshot.unreadSamples.length} more.`);
    }
  }
  lines.push(
    `${snapshot.pendingInsightCount + snapshot.pendingHandoffInsightCount} self-review finding(s) not yet reviewed (AI's own notes on mistakes/knowledge gaps — check the Training page on the dashboard for full detail, this channel can only give the count, not the content).`
  );
  lines.push(
    "Summarize this for the owner in a short, clear, natural message in whichever language they're writing in — don't just dump this raw list, but do mention the real numbers and name a couple of the most important items if there are any."
  );
  return lines.join("\n");
}

// Entry point called from the WhatsApp webhook once it's confirmed `from`
// matches the configured owner number. Mirrors the dashboard Teach AI
// route's shape (log message in, run the AI with tools, log message out,
// send the reply) but over WhatsApp instead of a dashboard fetch — and with
// one extra read-only tool (get_pending_items) the dashboard chat has no
// reason to offer.
export async function handleOwnerAssistantMessage(params: {
  organizationId: string;
  from: string;
  text: string;
  contactName: string;
}): Promise<void> {
  const { organizationId, from, text, contactName } = params;

  let client = await prisma.client.findFirst({
    where: { organizationId, phone: from, source: OWNER_ASSISTANT_CLIENT_SOURCE },
  });
  if (!client) {
    client = await prisma.client.create({
      data: {
        organizationId,
        name: contactName?.trim() || "Owner",
        phone: from,
        source: OWNER_ASSISTANT_CLIENT_SOURCE,
      },
    });
  }

  let conversation = await prisma.conversation.findFirst({
    where: { organizationId, clientId: client.id, channel: OWNER_ASSISTANT_CHANNEL },
  });
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { organizationId, clientId: client.id, channel: OWNER_ASSISTANT_CHANNEL, status: "OPEN" },
    });
  }

  const priorMessages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "desc" },
    take: OWNER_HISTORY_LIMIT,
  });
  const history: ChatHistoryMessage[] = priorMessages
    .slice()
    .reverse()
    .map((m) => ({ role: m.sender === "AI" ? "assistant" : "user", content: m.content }));

  await prisma.message.create({ data: { conversationId: conversation.id, sender: "CLIENT", content: text } });

  const { executeTool: teachExecute } = createTeachToolExecutor(organizationId, undefined, "whatsapp_owner_assistant");
  const executeTool: ToolExecutor = async (name, args) => {
    if (name === "get_pending_items") {
      const snapshot = await getOwnerStatusSnapshot(organizationId);
      return formatOwnerStatusForTool(snapshot);
    }
    return teachExecute(name, args);
  };

  let answer = "Sorry, something went wrong on my end — please try again in a moment.";
  try {
    const result = await askOwnerAssistant(
      text,
      history,
      [GET_PENDING_ITEMS_TOOL, UPDATE_PRODUCT_INFO_TOOL, ADD_KNOWLEDGE_NOTE_TOOL, UPDATE_STYLE_RULE_TOOL, ADD_QA_PAIR_TOOL],
      executeTool
    );
    if (result.answer) answer = result.answer;
    await logAiUsage(organizationId, "owner_assistant", result.usage);
  } catch (err) {
    console.error("Owner Assistant reply failed:", err);
  }

  await prisma.message.create({ data: { conversationId: conversation.id, sender: "AI", content: answer } });

  try {
    await sendWhatsAppMessage(from, answer);
  } catch (err) {
    console.error("Owner Assistant WhatsApp send failed:", err);
  }
}
