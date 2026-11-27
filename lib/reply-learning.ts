import { prisma } from "@/lib/prisma";
import { callJsonCompletion } from "@/lib/llm";
import { embedText, toVectorLiteral } from "@/lib/embeddings";
import { fetchBoostedQAChunk } from "@/lib/qa-retrieval";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { normalizeOwnerPhone } from "@/lib/owner-assistant";
import { applyTrainerChange } from "@/lib/trainer-tools";
import { logAiUsage } from "@/lib/billing";

// Learn from the owner's replies (2026-11-27, step after "Trainer + customer
// memory"). When the owner or staff answers a customer by hand (dashboard or
// swipe-reply on WhatsApp), a small model decides whether the answer is
// something every customer could be told (a price, a policy, how something
// works) — not something about this one order. If so, the owner gets a
// "📚 শিখে রাখব?" message on WhatsApp; replying "হ্যাঁ" saves it as a Trained
// Q&A, "না" drops it, any other text saves THAT as the answer. Nothing is
// learned without the owner's yes, and "undo" removes it again.

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const MIN_GAP_PER_CHAT_MS = 20 * 60 * 1000;
const MAX_PER_DAY = 12;

const SYSTEM = `You help a small Indian sweets shop (Banglar Doi) train its WhatsApp AI assistant.
You get a customer's message(s), the reply the shop owner/staff typed by hand, the AI's earlier reply (if any), and the closest thing the AI already knows.
Decide if the human reply teaches something REUSABLE — true for other customers too: a price, pack size, ingredient, shelf life, delivery area/charge/timing rule, payment/return policy, opening hours, how to order, a better way to answer a common question, or a correction of what the AI said.
NOT reusable: anything about this one customer or order (their order status, "sending now", "your parcel left", their address), greetings/thanks/ok, promises to check, jokes, one-time exceptions, staff names, anything private.
If the AI already knows the same thing (same facts), it's not new — learn=false. If the human contradicts what the AI already knows or said, it IS worth learning (set corrects=true).
Return JSON only:
{"learn": boolean, "corrects": boolean, "topic": "short English topic, 2-5 words", "questions": ["3 short ways a customer might ask this, in the customer's language mix"], "answer": "the reusable answer in the owner's own language mix and tone, with this customer's personal details removed; keep facts exactly as the owner said", "reason": "one short line"}`;

export async function suggestLearningFromStaffReply(params: { organizationId: string; conversationId: string; staffText: string }): Promise<void> {
  const { organizationId, conversationId } = params;
  const staffText = params.staffText.trim();
  if (staffText.length < 12 || staffText.startsWith("[Template:")) return;

  const profile = await prisma.agentProfile.findUnique({ where: { organizationId } });
  if (!profile || profile.learnFromReplies === false) return;
  const ownerPhone = profile.skillOwnerAssistant && profile.ownerAssistantPhone ? normalizeOwnerPhone(profile.ownerAssistantPhone) : "";
  if (!ownerPhone) return;

  const since = new Date(Date.now() - MIN_GAP_PER_CHAT_MS);
  const recentForChat = await prisma.trainerChange.count({
    where: { organizationId, kind: "learn_qa", createdAt: { gte: since }, payload: { path: ["conversationId"], equals: conversationId } },
  });
  if (recentForChat) return;
  const today = await prisma.trainerChange.count({ where: { organizationId, kind: "learn_qa", createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } });
  if (today >= MAX_PER_DAY) return;

  // The customer's message(s) this reply answers: the CLIENT messages right
  // before the reply (after the last AI/staff message before them).
  const recent = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: "desc" }, take: 12 });
  let i = 0;
  while (i < recent.length && recent[i].sender === "STAFF") i++; // the reply we just saved (and any just before it)
  const asked: string[] = [];
  let aiSaid = "";
  for (; i < recent.length; i++) {
    const m = recent[i];
    if (m.sender === "CLIENT") asked.unshift(m.content || "");
    else if (asked.length) break; // older turn — stop
    else if (m.sender === "AI" && !aiSaid) aiSaid = m.content || ""; // the AI's answer the owner is following up / correcting
  }
  const question = asked.filter(Boolean).join("\n").trim();
  if (!question) return; // the owner started the chat — nothing was asked

  let known = "";
  try {
    const vec = toVectorLiteral(await embedText(question, "query"));
    const best = await fetchBoostedQAChunk(organizationId, vec);
    if (best) known = clip(best.content, 1200);
  } catch {
    /* no embedding → just skip the duplicate hint */
  }

  const user = `CUSTOMER:\n${clip(question, 800)}\n\nOWNER/STAFF REPLIED:\n${clip(staffText, 800)}\n\nAI SAID EARLIER:\n${aiSaid ? clip(aiSaid, 600) : "(nothing)"}\n\nAI ALREADY KNOWS:\n${known || "(nothing close)"}`;
  const { json, usage } = await callJsonCompletion(SYSTEM, user, 700);
  await logAiUsage(organizationId, "reply_learning", usage).catch(() => undefined);
  const r = (json || {}) as { learn?: boolean; corrects?: boolean; topic?: string; questions?: unknown; answer?: string; reason?: string };
  const questions = (Array.isArray(r.questions) ? r.questions : []).map((q) => String(q).trim()).filter(Boolean).slice(0, 4);
  const answer = String(r.answer || "").trim();
  if (!r.learn || !answer) return;
  if (!questions.includes(clip(question.replace(/\s+/g, " "), 160))) questions.unshift(clip(question.replace(/\s+/g, " "), 160));
  const topic = clip(String(r.topic || "").trim() || questions[0], 60);

  const change = await prisma.trainerChange.create({
    data: {
      organizationId,
      kind: "learn_qa",
      summary: `Learned from your reply: ${topic}`,
      payload: { kind: "learn_qa", topic, questions, answer, conversationId, corrects: !!r.corrects },
    },
  });

  const text = [
    r.corrects ? "📚 *AI ভুল জানত — ঠিকটা শিখে রাখব?*" : "📚 *এটা শিখে রাখব?*",
    `\nক্রেতা: "${clip(question.replace(/\s+/g, " "), 200)}"`,
    `আপনি: "${clip(staffText.replace(/\s+/g, " "), 300)}"`,
    `\nপরের বার কেউ এমন জিজ্ঞেস করলে AI বলবে:\n"${clip(answer, 500)}"`,
    `\n↩️ _এই মেসেজে Reply করে লিখুন:_ *হ্যাঁ* _(শিখে নাও) /_ *না* _— বা ঠিক উত্তরটা লিখে দিন।_`,
  ].join("\n");
  try {
    const wamid = await sendWhatsAppMessage(ownerPhone, text);
    if (wamid) {
      await prisma.ownerNotice.create({ data: { organizationId, wamid, conversationId, kind: "LEARN", trainerChangeId: change.id } });
    }
  } catch (err) {
    // 24-hour window to the owner closed — leave it pending; a plain "হ্যাঁ" later still works.
    console.error("Learning suggestion not delivered:", err);
  }
}

const YES = /^\s*(হ্যাঁ|হ্যা|হা|ha+n?|haa?|yes|y|ok|okay|ঠিক আছে|thik ache|শিখে নাও|shikhe nao|✅|👍)\s*[.!]*\s*$/i;
const NO = /^\s*(না|na+|no|n|নাহ|dorkar nei|দরকার নেই|❌|👎)\s*[.!]*\s*$/i;

// Owner swipe-replied to a "📚 শিখে রাখব?" message.
export async function handleLearnNoticeReply(params: { organizationId: string; ownerPhone: string; contextId: string; text: string }): Promise<boolean> {
  const notice = await prisma.ownerNotice.findUnique({ where: { wamid: params.contextId } });
  if (!notice || notice.organizationId !== params.organizationId || notice.kind !== "LEARN" || !notice.trainerChangeId) return false;
  const ch = await prisma.trainerChange.findFirst({ where: { id: notice.trainerChangeId, organizationId: params.organizationId } });
  const say = (t: string) => sendWhatsAppMessage(params.ownerPhone, t).catch(() => undefined);
  if (!ch || ch.status !== "PENDING") {
    await say(ch?.status === "APPLIED" ? "✓ এটা আগেই শেখা হয়ে গেছে।" : "এই প্রস্তাবটা আর নেই।");
    return true;
  }
  const text = params.text.trim();
  if (NO.test(text)) {
    await prisma.trainerChange.update({ where: { id: ch.id }, data: { status: "CANCELLED" } });
    await say("ঠিক আছে, এটা শিখছি না।");
    return true;
  }
  const corrected = YES.test(text) ? undefined : text;
  const result = await applyTrainerChange(params.organizationId, ch.id, corrected);
  if (result.startsWith("APPLIED")) {
    await say(`✅ শিখে নিলাম${corrected ? " (আপনার লেখা উত্তরটা)" : ""}। এখন থেকে ক্রেতারা এটা জিজ্ঞেস করলে AI নিজেই বলবে।\nভুল হলে লিখুন *undo*।`);
  } else {
    await say("সেভ করা গেল না, আর একবার চেষ্টা করুন।");
  }
  return true;
}
