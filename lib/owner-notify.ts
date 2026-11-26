import webpush from "web-push";
import { prisma } from "@/lib/prisma";
import { sendWhatsAppMessage, sendWhatsAppTemplateMessage } from "@/lib/whatsapp";
import { normalizeOwnerPhone } from "@/lib/owner-assistant";

// Owner alerts (2026-11-26). Owner: "AI business OS e conversation e kau
// message korle instant ami take reply dite pachhi na ... mobile e sathe
// sathe notification and open kore reply dite / bolte pari".
//
// 1) WhatsApp: after a customer message is handled, the owner's own number
//    (AgentProfile.ownerAssistantPhone) gets "💬 Riya: … / 🤖 AI: …". The
//    owner swipe-replies to that message (text or voice) → it goes straight
//    to the customer from the business number, is logged as a STAFF message,
//    and the AI stays quiet in that chat for AI_QUIET_HOURS (or until the
//    owner replies "AI on").
// 2) Phone push: every phone/browser that turned on notifications on the
//    Notifications page gets a push; tapping it opens that conversation.
//
// Which messages: AgentProfile.ownerNotifyMode — ALL, IMPORTANT (default:
// new customer, AI could not answer / handed over / is paused, photo,
// order) or OFF.

export const AI_QUIET_HOURS = 3;
const SITE = (process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "https://ai-business-os.vercel.app").replace(/\/+$/, "");

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/* ------------------------------------------------------------------ push */

export async function getVapid(): Promise<{ publicKey: string; privateKey: string }> {
  const row = await prisma.pushConfig.findUnique({ where: { id: "default" } });
  if (row) return { publicKey: row.publicKey, privateKey: row.privateKey };
  const keys = webpush.generateVAPIDKeys();
  try {
    await prisma.pushConfig.create({ data: { id: "default", publicKey: keys.publicKey, privateKey: keys.privateKey } });
    return keys;
  } catch {
    const again = await prisma.pushConfig.findUnique({ where: { id: "default" } });
    return again ? { publicKey: again.publicKey, privateKey: again.privateKey } : keys;
  }
}

export async function sendPushToOrg(
  organizationId: string,
  payload: { title: string; body: string; url: string; tag?: string }
): Promise<number> {
  const subs = await prisma.pushSubscription.findMany({ where: { organizationId } });
  if (!subs.length) return 0;
  const { publicKey, privateKey } = await getVapid();
  webpush.setVapidDetails("mailto:support@banglardoi.com", publicKey, privateKey);
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { TTL: 3600, urgency: "high" }
        );
        sent++;
      } catch (err: unknown) {
        const code = (err as { statusCode?: number })?.statusCode;
        // 404/410 = the phone/browser dropped this subscription — forget it.
        if (code === 404 || code === 410) await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => undefined);
        else console.error("Push send failed", code, err);
      }
    })
  );
  return sent;
}

/* ------------------------------------------------------- customer → owner */

/**
 * Called by the WhatsApp webhook after it finished handling one inbound
 * customer message (whatever path it took), with the time it started.
 */
export async function notifyOwnerAfterCustomerMessage(params: {
  organizationId: string;
  from: string;
  since: Date;
}): Promise<void> {
  const profile = await prisma.agentProfile.findUnique({ where: { organizationId: params.organizationId } });
  const mode = profile?.ownerNotifyMode || "IMPORTANT";
  if (mode === "OFF") return;

  const ownerPhone = profile?.skillOwnerAssistant && profile.ownerAssistantPhone ? normalizeOwnerPhone(profile.ownerAssistantPhone) : "";
  if (ownerPhone && normalizeOwnerPhone(params.from) === ownerPhone) return; // the owner's own message

  const client = await prisma.client.findFirst({ where: { organizationId: params.organizationId, phone: params.from } });
  if (!client) return;
  const conversation = await prisma.conversation.findFirst({
    where: { organizationId: params.organizationId, clientId: client.id, channel: "WHATSAPP" },
    orderBy: { createdAt: "desc" },
  });
  if (!conversation) return;

  const since = new Date(params.since.getTime() - 2000);
  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
  });
  const fromCustomer = messages.filter((m) => m.sender === "CLIENT");
  if (!fromCustomer.length) return;
  const aiReplies = messages.filter((m) => m.sender === "AI");

  const newCustomer = client.createdAt >= since;
  const order = await prisma.clientOrder
    .findFirst({ where: { organizationId: params.organizationId, clientId: client.id, createdAt: { gte: since } } })
    .catch(() => null);
  const reasons: string[] = [];
  if (conversation.aiPaused) reasons.push(conversation.handoffReason ? "🙋 AI আপনাকে ডাকছে" : "⏸️ AI বন্ধ — আপনার উত্তর দরকার");
  else if (!aiReplies.length) reasons.push("⏸️ AI উত্তর দেয়নি");
  if (aiReplies.some((m) => m.noKnowledgeMatch)) reasons.push("❓ AI ঠিক জানত না");
  if (order) reasons.push("🛒 নতুন অর্ডার");
  if (fromCustomer.some((m) => m.imageUrl)) reasons.push("📷 ছবি পাঠিয়েছে");
  if (newCustomer) reasons.push("🆕 নতুন ক্রেতা");
  if (mode === "IMPORTANT" && !reasons.length) return;

  const name = client.name && client.name !== client.phone ? client.name : `+${client.phone}`;
  const said = fromCustomer.map((m) => clip(m.content || (m.imageUrl ? "📷 Photo" : ""), 300)).join("\n");
  const ai = aiReplies.map((m) => clip(m.content, 300)).join("\n");

  const lines = [
    reasons.length ? `*${reasons.join(" · ")}*` : "",
    `💬 *${name}* (${client.phone.slice(-10)}):`,
    said,
    ai ? `\n🤖 AI: ${ai}` : "",
    `\n↩️ _এই মেসেজে Reply করে লিখুন বা বলুন — সরাসরি ${name}-এর কাছে যাবে।_`,
  ].filter(Boolean);
  const text = clip(lines.join("\n"), 3800);

  if (ownerPhone) {
    let wamid: string | undefined;
    try {
      wamid = await sendWhatsAppMessage(ownerPhone, text);
    } catch (err) {
      // Owner hasn't messaged the business number in 24 h → only an approved template may go.
      const tpl = profile?.ownerNotifyTemplateId
        ? await prisma.messageTemplate.findFirst({ where: { id: profile.ownerNotifyTemplateId, organizationId: params.organizationId, status: "APPROVED" } })
        : null;
      if (tpl) {
        try {
          wamid = await sendWhatsAppTemplateMessage(ownerPhone, tpl.metaTemplateName, tpl.language, [clip(name, 60), clip(said.replace(/\s+/g, " "), 400)]);
        } catch (err2) {
          console.error("Owner alert template failed:", err2);
        }
      } else {
        console.error("Owner alert failed (24h window closed? set an alert template):", err);
      }
    }
    if (wamid) {
      await prisma.ownerNotice.create({ data: { organizationId: params.organizationId, wamid, conversationId: conversation.id } }).catch(() => undefined);
    }
  }

  await sendPushToOrg(params.organizationId, {
    title: `${reasons[0] ? reasons[0] + " · " : "💬 "}${name}`,
    body: clip(said.replace(/\s+/g, " "), 160) + (ai ? `\n🤖 ${clip(ai.replace(/\s+/g, " "), 100)}` : ""),
    url: `/dashboard/conversations/${conversation.id}`,
    tag: conversation.id,
  }).catch((err) => console.error("Push failed:", err));
}

/* ------------------------------------------------------- owner → customer */

/**
 * The owner swipe-replied to an alert. Returns false when the quoted
 * message is not an alert (then it's a normal Owner Assistant message).
 */
export async function handleOwnerAlertReply(params: {
  organizationId: string;
  ownerPhone: string;
  contextId: string;
  text: string;
}): Promise<boolean> {
  const notice = await prisma.ownerNotice.findUnique({ where: { wamid: params.contextId } });
  if (!notice || notice.organizationId !== params.organizationId) return false;
  const conversation = await prisma.conversation.findFirst({
    where: { id: notice.conversationId, organizationId: params.organizationId },
    include: { client: true },
  });
  if (!conversation) return false;
  const name = conversation.client.name && conversation.client.name !== conversation.client.phone ? conversation.client.name : conversation.client.phone;
  const text = params.text.trim();
  const remember = async (wamid: string | undefined) => {
    if (wamid) await prisma.ownerNotice.create({ data: { organizationId: params.organizationId, wamid, conversationId: conversation.id } }).catch(() => undefined);
  };

  // "AI on" / "AI chalu" → hand the chat back to the AI now.
  if (/^\s*(ai|এআই)\s*(on|chalu|চালু|start|শুরু)\s*$/i.test(text)) {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { aiPaused: false, aiResumeAt: null, aiPausedAt: null, handoffReason: null } });
    await remember(await sendWhatsAppMessage(params.ownerPhone, `🤖 ${name}-এর chat-এ AI আবার চালু হলো।`).catch(() => undefined));
    return true;
  }
  if (/^\s*(ai|এআই)\s*(off|bondho|বন্ধ|stop)\s*$/i.test(text)) {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { aiPaused: true, aiResumeAt: null, aiPausedAt: conversation.aiPausedAt ?? new Date() } });
    await remember(await sendWhatsAppMessage(params.ownerPhone, `⏸️ ${name}-এর chat-এ AI বন্ধ রইল — যতক্ষণ না "AI on" লেখেন।`).catch(() => undefined));
    return true;
  }

  let error: string | null = null;
  try {
    await sendWhatsAppMessage(conversation.client.phone, text);
  } catch (err) {
    error = err instanceof Error ? err.message : "send failed";
  }
  await prisma.message.create({
    data: { conversationId: conversation.id, sender: "STAFF", content: error ? `${text}\n\n[NOT DELIVERED: ${error}]` : text },
  });
  if (!error) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        aiPaused: true,
        aiPausedAt: conversation.aiPausedAt ?? new Date(),
        aiResumeAt: new Date(Date.now() + AI_QUIET_HOURS * 3600 * 1000),
        handoffReason: null,
        lastReadAt: new Date(),
      },
    });
  }
  const ack = error
    ? `⚠️ ${name}-কে পাঠানো যায়নি (${clip(error, 120)}). ২৪ ঘণ্টার বেশি পুরোনো chat হলে শুধু template পাঠানো যায়।`
    : `✓ ${name}-কে পাঠানো হলো।\n🤖 AI এই chat-এ ${AI_QUIET_HOURS} ঘণ্টা চুপ থাকবে। এখনই চালু করতে এই মেসেজে Reply করে লিখুন: *AI on*`;
  await remember(await sendWhatsAppMessage(params.ownerPhone, ack).catch(() => undefined));
  return true;
}
