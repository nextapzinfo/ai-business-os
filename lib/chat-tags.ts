import { prisma } from "@/lib/prisma";
import { callJsonCompletion } from "@/lib/llm";
import { logAiUsage } from "@/lib/billing";
import { computeClientMetrics, unifyOrders } from "@/lib/client-metrics";

// ── Chat tags (CRM Step 2b, owner's request 2026-11-12) ──────────────────
// Owner, verbatim: "eta akhon akbar i koro - r er por theke jokhon kono chat
// hobe, tokhon seta instantly tagging hoe jabe, ar baki tag gulo add kore
// dao". So:
//   1. ONE-TIME: "Read all old chats" button on the Clients page reads every
//      customer's whole WhatsApp history once (backfillChatTags below, driven
//      in small batches by /api/crm/chat-tags/backfill so it never times out).
//   2. INSTANTLY after that: every incoming customer message re-reads just the
//      latest part of that chat and updates the tags (refreshClientChatTags,
//      called from the WhatsApp webhook via waitUntil so the customer's reply
//      is never slowed down).
//
// The AI only extracts plain FACTS ("signals") from the chat — which products
// they asked about, whether they asked a price, bulk/corporate, occasion,
// complaint, delivery area. The visible tag list is then BUILT from those
// facts in code (buildChatTags) together with real order data — e.g. "Price
// asked – not bought" disappears on its own as soon as an order arrives.
// Stored in Client.chatSignals (facts) and Client.chatTags (what staff see),
// separate from staff-typed Client.tags and order-based Client.autoTags.

export const OCCASIONS = ["Wedding", "Birthday", "Puja", "Annaprashan", "Anniversary", "Party", "Gift", "Other"] as const;

export type ChatSignals = {
  interested: string[]; // exact catalog product names, most recent first
  priceAskedAt: string | null; // ISO time of the last message where they asked a price without ordering
  bulk: boolean;
  occasions: string[];
  complaint: "open" | "resolved" | null;
  area: string | null;
};

export const EMPTY_SIGNALS: ChatSignals = { interested: [], priceAskedAt: null, bulk: false, occasions: [], complaint: null, area: null };

export { PRICE_ASKED_TAG, BULK_TAG, COMPLAINT_TAG, chatTagStyle, CHAT_TAG_HELP, chatTagHelp } from "@/lib/chat-tag-styles";
import { PRICE_ASKED_TAG, BULK_TAG, COMPLAINT_TAG } from "@/lib/chat-tag-styles";

export function parseSignals(raw: unknown): ChatSignals {
  if (!raw || typeof raw !== "object") return { ...EMPTY_SIGNALS };
  const r = raw as Record<string, unknown>;
  const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);
  return {
    interested: strArr(r.interested),
    priceAskedAt: typeof r.priceAskedAt === "string" ? r.priceAskedAt : null,
    bulk: r.bulk === true,
    occasions: strArr(r.occasions),
    complaint: r.complaint === "open" || r.complaint === "resolved" ? r.complaint : null,
    area: typeof r.area === "string" && r.area.trim() ? r.area.trim() : null,
  };
}

const DAY = 24 * 60 * 60 * 1000;

// Facts + real orders → the visible tag list. Pure, no AI, cheap — also run
// by the auto-tag refresh after every order and nightly.
export function buildChatTags(s: ChatSignals, lastOrderAt: Date | null, now = new Date()): string[] {
  const tags: string[] = [];
  for (const p of s.interested.slice(0, 4)) tags.push(`Interested: ${p}`);
  if (s.priceAskedAt) {
    const asked = new Date(s.priceAskedAt);
    const orderedSince = lastOrderAt !== null && lastOrderAt.getTime() >= asked.getTime() - 60 * 60 * 1000;
    if (!orderedSince && now.getTime() - asked.getTime() <= 90 * DAY) tags.push(PRICE_ASKED_TAG);
  }
  if (s.bulk) tags.push(BULK_TAG);
  for (const o of s.occasions) tags.push(o === "Other" ? "Occasion" : `Occasion: ${o}`);
  if (s.complaint === "open") tags.push(COMPLAINT_TAG);
  if (s.area) tags.push(`Area: ${s.area}`);
  return [...new Set(tags)];
}

function sameTags(a: string[], b: string[]) {
  return a.length === b.length && a.every((t) => b.includes(t));
}

// ── The AI part ──────────────────────────────────────────────────────────

type ChatLine = { no: number; sender: string; content: string; at: Date };

type AiSignals = {
  interestedProducts: string[];
  priceAskedMessageNo: number | null;
  bulkOrCorporate: boolean;
  occasions: string[];
  complaint: "open" | "resolved" | "none";
  area: string | null;
};

function systemPrompt(productNames: string[], incremental: boolean, existing: ChatSignals | null) {
  return `You read a WhatsApp chat between a customer and a sweets/food shop (Bengali, Banglish or English) and extract CRM facts about the CUSTOMER. Be strict: only report what the customer actually said or clearly meant. Do not guess.

Product catalog (use these EXACT names only; ignore products not in this list):
${productNames.length ? productNames.map((n) => `- ${n}`).join("\n") : "(no catalog — return an empty interestedProducts list)"}

Return ONLY a JSON object:
{
  "interestedProducts": [catalog names the customer asked about, wanted, or showed interest in — most recent first, max 6],
  "priceAskedMessageNo": number or null — the message number of the LAST customer message asking a price/rate/cost ("dam koto", "rate", "price") that was NOT followed by them confirming an order in the chat; null if they never asked, or did order after asking,
  "bulkOrCorporate": true if they asked for a large quantity, bulk, wholesale, office/company/corporate or event catering order,
  "occasions": any of ${JSON.stringify(OCCASIONS)} the customer mentioned buying for (Puja includes any festival like Durga Puja, Diwali, Jamai Sasthi, Poila Baisakh, Eid, Christmas; Party includes events/functions; Other = some other specific occasion),
  "complaint": "open" if the customer complained (bad quality, late/missing delivery, wrong item, rude service, refund) and it does NOT look resolved yet; "resolved" if a complaint was clearly settled or the customer is happy again; "none" if no complaint is discussed,
  "area": the locality/area/city the customer wants delivery to (short, e.g. "Madhyamgram", "Salt Lake"), or null
}${
    incremental
      ? `

You are seeing only the LATEST messages of a longer chat. Report only what these messages show. Already known about this customer from earlier: ${JSON.stringify(existing ?? EMPTY_SIGNALS)}. Use "none" for complaint if these messages don't mention one.`
      : ""
  }`;
}

async function extractSignals(lines: ChatLine[], productNames: string[], incremental: boolean, existing: ChatSignals | null) {
  const transcript = lines
    .map((l) => `#${l.no} ${l.sender === "CLIENT" ? "CUSTOMER" : l.sender === "STAFF" ? "SHOP STAFF" : "SHOP AI"}: ${l.content}`)
    .join("\n");
  const { json, usage } = await callJsonCompletion(systemPrompt(productNames, incremental, existing), `Chat:\n${transcript}`, 500);
  const r = (json ?? {}) as Record<string, unknown>;
  const catalog = new Map(productNames.map((n) => [n.trim().toLowerCase(), n]));
  const interested = (Array.isArray(r.interestedProducts) ? r.interestedProducts : [])
    .map((p) => (typeof p === "string" ? catalog.get(p.trim().toLowerCase()) : undefined))
    .filter((p): p is string => !!p);
  const occ = new Set<string>(OCCASIONS);
  const signals: AiSignals = {
    interestedProducts: [...new Set(interested)].slice(0, 6),
    priceAskedMessageNo: typeof r.priceAskedMessageNo === "number" ? r.priceAskedMessageNo : null,
    bulkOrCorporate: r.bulkOrCorporate === true,
    occasions: (Array.isArray(r.occasions) ? r.occasions : []).filter((o): o is string => typeof o === "string" && occ.has(o)),
    complaint: r.complaint === "open" || r.complaint === "resolved" ? r.complaint : "none",
    area: typeof r.area === "string" && r.area.trim() && r.area.trim().length <= 40 ? r.area.trim() : null,
  };
  return { signals, usage, ok: json !== null };
}

function mergeSignals(old: ChatSignals, ai: AiSignals, lines: ChatLine[], incremental: boolean): ChatSignals {
  const askedLine = ai.priceAskedMessageNo !== null ? lines.find((l) => l.no === ai.priceAskedMessageNo && l.sender === "CLIENT") : undefined;
  const askedAt = askedLine ? askedLine.at.toISOString() : null;
  if (!incremental) {
    return {
      interested: ai.interestedProducts,
      priceAskedAt: askedAt,
      bulk: ai.bulkOrCorporate,
      occasions: ai.occasions,
      complaint: ai.complaint === "none" ? null : ai.complaint,
      area: ai.area,
    };
  }
  return {
    interested: [...new Set([...ai.interestedProducts, ...old.interested])].slice(0, 6),
    priceAskedAt: askedAt ?? old.priceAskedAt,
    bulk: old.bulk || ai.bulkOrCorporate,
    occasions: [...new Set([...old.occasions, ...ai.occasions])],
    complaint: ai.complaint === "none" ? old.complaint : ai.complaint,
    area: ai.area ?? old.area,
  };
}

const MAX_FULL_MESSAGES = 200;
const MAX_FULL_CHARS = 24000;
const RECENT_MESSAGES = 12;

function toLines(msgs: { sender: string; content: string; createdAt: Date }[]): ChatLine[] {
  return msgs
    .filter((m) => m.content && m.content.trim() && m.content.trim() !== "📷 Photo")
    .map((m, i) => ({ no: i + 1, sender: m.sender, content: m.content.replace(/\s+/g, " ").slice(0, 400), at: m.createdAt }));
}

async function productNamesFor(organizationId: string): Promise<string[]> {
  const products = await prisma.product.findMany({ where: { organizationId }, select: { name: true }, orderBy: { createdAt: "asc" }, take: 300 });
  return [...new Set(products.map((p) => p.name.trim()).filter(Boolean))];
}

async function lastCountedOrderAt(clientId: string): Promise<Date | null> {
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      orders: { select: { id: true, items: true, status: true, totalAmount: true, createdAt: true } },
      websiteOrders: { select: { id: true, orderNumber: true, status: true, totalInRupees: true, placedAt: true, itemsJson: true } },
    },
  });
  if (!c) return null;
  return computeClientMetrics(unifyOrders(c.orders, c.websiteOrders)).lastOrderAt;
}

// Reads one customer's chat and saves tags. mode "full" = whole history
// (one-time backfill, or first time ever); "auto" = only the latest
// messages if this customer was already read once, else full.
// Never throws — a tagging problem must never affect replying to a customer.
export async function refreshClientChatTags(
  clientId: string,
  mode: "full" | "auto" = "auto",
  productNames?: string[]
): Promise<"tagged" | "no-chat" | "skipped" | "failed"> {
  try {
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true, organizationId: true, chatTags: true, chatSignals: true, chatTagsAnalyzedAt: true },
    });
    if (!client) return "skipped";

    // Date(0) = an earlier full read failed — read the whole chat again.
    const full = mode === "full" || client.chatTagsAnalyzedAt === null || client.chatTagsAnalyzedAt.getTime() === 0;
    const where = { conversation: { clientId: client.id } };

    let msgs: { sender: string; content: string; createdAt: Date }[];
    if (full) {
      msgs = (
        await prisma.message.findMany({
          where,
          select: { sender: true, content: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: MAX_FULL_MESSAGES,
        })
      ).reverse();
      // Keep the newest messages within the size budget.
      let chars = 0;
      let start = msgs.length;
      while (start > 0 && chars + Math.min(400, msgs[start - 1].content.length) <= MAX_FULL_CHARS) {
        chars += Math.min(400, msgs[start - 1].content.length);
        start--;
      }
      msgs = msgs.slice(start);
    } else {
      const newClientMsg = await prisma.message.findFirst({
        where: { ...where, sender: "CLIENT", createdAt: { gt: client.chatTagsAnalyzedAt! } },
        select: { id: true },
      });
      if (!newClientMsg) return "skipped";
      msgs = (
        await prisma.message.findMany({
          where,
          select: { sender: true, content: true, createdAt: true },
          orderBy: { createdAt: "desc" },
          take: RECENT_MESSAGES,
        })
      ).reverse();
    }

    const lines = toLines(msgs);
    const analyzedAt = msgs.length ? msgs[msgs.length - 1].createdAt : new Date();
    const old = parseSignals(client.chatSignals);

    if (!lines.some((l) => l.sender === "CLIENT")) {
      await prisma.client.update({ where: { id: client.id }, data: { chatTagsAnalyzedAt: analyzedAt } });
      return "no-chat";
    }

    const names = productNames ?? (await productNamesFor(client.organizationId));
    const { signals: ai, usage, ok } = await extractSignals(lines, names, !full, full ? null : old);
    await logAiUsage(client.organizationId, "chat_tags", usage);
    if (!ok) return "failed";

    const next = mergeSignals(old, ai, lines, !full);
    const tags = buildChatTags(next, await lastCountedOrderAt(client.id));
    await prisma.client.update({
      where: { id: client.id },
      data: { chatSignals: next, chatTags: tags, chatTagsAnalyzedAt: analyzedAt },
    });
    return "tagged";
  } catch (err) {
    console.error("refreshClientChatTags failed", clientId, err);
    return "failed";
  }
}

// Rebuild visible tags from already-saved facts (no AI). Used by the order /
// nightly auto-tag refresh so e.g. "Price asked – not bought" clears itself.
export function rebuildChatTags(chatSignals: unknown, currentTags: string[], lastOrderAt: Date | null, now = new Date()): string[] | null {
  if (!chatSignals) return null;
  const next = buildChatTags(parseSignals(chatSignals), lastOrderAt, now);
  return sameTags(currentTags, next) ? null : next;
}

// ── One-time backfill, in small batches ──────────────────────────────────
// Each call reads up to `batchSize` customers who have chatted but were never
// read yet, a few at a time in parallel, and reports how many are left — the
// Clients page button keeps calling until 0 remain.
export async function backfillChatTagsBatch(organizationId: string, batchSize = 12) {
  const pendingWhere = { organizationId, chatTagsAnalyzedAt: null, conversations: { some: { messages: { some: { sender: "CLIENT" } } } } };
  const clients = await prisma.client.findMany({ where: pendingWhere, select: { id: true }, orderBy: { updatedAt: "desc" }, take: batchSize });
  const names = await productNamesFor(organizationId);

  let tagged = 0;
  let failed = 0;
  const PARALLEL = 4;
  for (let i = 0; i < clients.length; i += PARALLEL) {
    const results = await Promise.all(clients.slice(i, i + PARALLEL).map((c) => refreshClientChatTags(c.id, "full", names)));
    for (const r of results) {
      if (r === "failed") failed++;
      else tagged++;
    }
  }
  // A customer that keeps failing must not block the loop forever: mark it
  // read so the button finishes; it will be re-read on their next message.
  if (failed > 0) {
    const stillPending = await prisma.client.findMany({ where: { ...pendingWhere, id: { in: clients.map((c) => c.id) } }, select: { id: true } });
    if (stillPending.length) {
      await prisma.client.updateMany({ where: { id: { in: stillPending.map((c) => c.id) } }, data: { chatTagsAnalyzedAt: new Date(0) } });
    }
  }
  const remaining = await prisma.client.count({ where: pendingWhere });
  return { processed: clients.length, tagged, failed, remaining };
}

export async function chatTagBackfillStatus(organizationId: string) {
  const base = { organizationId, conversations: { some: { messages: { some: { sender: "CLIENT" } } } } };
  const [total, pending] = await Promise.all([
    prisma.client.count({ where: base }),
    prisma.client.count({ where: { ...base, chatTagsAnalyzedAt: null } }),
  ]);
  return { total, pending };
}
