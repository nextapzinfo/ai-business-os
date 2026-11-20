import { prisma } from "@/lib/prisma";
import { istToday, syncBizDay } from "@/lib/biz-analyst";

// WhatsApp closing entry (owner 2026-11-21, owner-only).
// The owner sends his closing list on WhatsApp, e.g.
//   Patuli.......19/11
//   Doi 2.5kg...3 1kg....9 500g.....25+40 Choto...19
//   B.patisapta....22 B.rosogolla....71 ...
//   Ghee 500g...2 250g...9 100g....11
// 1. parseClosingText() reads it line by line (no AI guessing of numbers).
// 2. Names are matched to the real products stocked at that location in
//    Banglar Doi OS (remembered aliases first, then a fuzzy match).
// 3. Banglar Doi OS computes the preview (sale, cash/online, DAY SHORT) —
//    the same maths as the Closing page — and NOTHING is saved yet.
// 4. Only after the owner replies "হ্যাঁ" does confirmClosing() save it,
//    through the same code as the Closing page's Save buttons.

const BMS_URL = (process.env.BMS_API_URL || "https://app.banglardoi.com").replace(/\/+$/, "");
const PENDING_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function secret(): string {
  const s = process.env.BMS_INTEGRATION_SECRET || process.env.BANGLARDOI_INTEGRATION_SECRET;
  if (!s) throw new Error("BMS_INTEGRATION_SECRET is not set");
  return s;
}

async function bms<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BMS_URL}/wp-json/bdos/v1/analytics/${path}${path.includes("?") ? "&" : "?"}_=${Date.now()}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${secret()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Banglar Doi OS answered ${res.status}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------- types
export type BmsProduct = {
  product_id: number;
  name: string;
  sku: string;
  vendor: string;
  unit: string;
  available: number;
  existing_closing: number | null;
  price: number;
  pos_qty: number;
  pos_value: number;
};
type BmsLoc = { id: number; name: string; type: string; start_date: string | null; end_date: string | null };
type BmsContext = { location: { id: number; name: string; type: string }; date: string; products: BmsProduct[]; money: any; error?: string };
type Expense = { purpose: string; amount: number; type?: "expense" | "fund_transfer" };
type Money = { cash?: number; online?: number; previous_cash?: number; expenses?: Expense[] };
type BmsPreview = {
  error?: string;
  location: { id: number; name: string; type: string };
  date: string;
  lines: { product_id: number; product: string; available: number; old_closing: number | null; closing: number | null; changed: boolean; sale_qty: number; rate: number; sale_value: number }[];
  problems: { product_id: number; product?: string; problem: string }[];
  not_entered: { product: string; available: number }[];
  pos_sale: number;
  product_sale: number;
  money: null | { previous_cash: number; cash: number; online: number; expenses: { amount: number; purpose: string; type: string }[]; expense_total: number; cash_sale: number; counter_sale: number; old: any };
  short: number | null;
  verdict: "SHORT" | "EXCESS" | "MATCHED" | null;
  saved: boolean;
  saved_closings?: number;
  saved_money?: boolean;
};

export type ParsedItem = { text: string; alt?: string; qty: number; raw: string };
type Unsure = { text: string; alt?: string; qty: number; candidates: string[] };
type Pending = {
  location_id: number;
  location_name: string;
  date: string;
  closings: { product_id: number; product: string; qty: number; from: string }[];
  unsure: Unsure[];
  money: Money;
};

// ---------------------------------------------------------------- text helpers
const UNIT: Record<string, string> = { g: "gm", gm: "gm", gms: "gm", gram: "gm", grams: "gm", kg: "kg", kgs: "kg", l: "lt", lt: "lt", ltr: "lt", litre: "lt", liter: "lt", ml: "ml", pc: "pcs", pcs: "pcs", p: "pcs" };
const WORD: Record<string, string> = { pow: "powder", powd: "powder", liq: "liquid" };

export function normalizeName(s: string): string {
  let t = s.toLowerCase().replace(/[’'`"]/g, "");
  t = t.replace(/(\d)\s*(kg|kgs|gms|gm|g|ltr|lt|l|ml|pcs|pc)\b/g, "$1 $2");
  t = t.replace(/[^a-z0-9.\u0980-\u09ff]+/g, " ").replace(/(?<!\d)\.|\.(?!\d)/g, " ");
  return t
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => (i === 0 && w === "b" ? "baked" : UNIT[w] || WORD[w] || w))
    .join(" ")
    .trim();
}

const isNum = (w: string) => /^\d+(\.\d+)?$/.test(w);
const isUnit = (w: string) => Object.values(UNIT).includes(w);

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}
function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  const pool = [...B];
  let hit = 0;
  for (const g of A) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      hit++;
      pool.splice(i, 1);
    }
  }
  return (2 * hit) / (A.length + B.length);
}
function wordSim(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length >= 3 && b.startsWith(a)) return 0.9;
  if (b.length >= 3 && a.startsWith(b)) return 0.85;
  if (a.length <= 2 && b.startsWith(a)) return 0.7; // "chana b" → Chana Bora
  // Bengali spellings drift (jilepi / jelebi, rosogolla / rasgulla)
  const sq = (x: string) => x.replace(/[aeiou]+/g, "").replace(/(.)\1+/g, "$1");
  const consonants = sq(a) === sq(b) && sq(a).length >= 2 ? 0.88 : 0;
  return Math.max(consonants, dice(a, b));
}

/** 0..1 similarity between what the owner wrote and a product name. */
export function nameScore(query: string, product: string): number {
  const q = normalizeName(query).split(" ").filter(Boolean);
  const p = normalizeName(product).split(" ").filter(Boolean);
  if (!q.length || !p.length) return 0;
  const qNums = q.filter(isNum).map(Number);
  const pNums = p.filter(isNum).map(Number);
  const qWords = q.filter((w) => !isNum(w) && !isUnit(w));
  const pWords = p.filter((w) => !isNum(w) && !isUnit(w));
  let numFactor = 1;
  if (qNums.length) {
    if (!pNums.length) numFactor = 0.6;
    else if (qNums.every((n) => pNums.includes(n))) numFactor = 1.08;
    else numFactor = 0.35;
  } else if (pNums.length) numFactor = 0.97;
  if (!qWords.length) return 0; // only a size — needs its section name
  const cover = (from: string[], to: string[]) => from.reduce((s, w) => s + Math.max(0, ...to.map((x) => wordSim(w, x))), 0) / from.length;
  const qCov = cover(qWords, pWords);
  const pCov = pWords.length ? cover(pWords, qWords) : 0;
  const joined = dice(qWords.join(""), pWords.join(""));
  const score = Math.max(0.72 * qCov + 0.28 * pCov, joined * 0.95);
  return Math.min(1, score * numFactor);
}

/** "25+40" → 65, "12.5" → 12.5 */
export function evalQty(raw: string): number | null {
  const parts = raw.replace(/\s+/g, "").split("+").filter(Boolean);
  if (!parts.length || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((s, p) => s + Number(p), 0);
}

const MONEY_WORDS: [RegExp, keyof Money][] = [
  [/^(cash|nogod|nagad|hand cash|cash in hand)$/i, "cash"],
  [/^(online|upi|gpay|phonepe|paytm|card)$/i, "online"],
  [/^(change|prev cash|previous cash|float|change given|khuchro)$/i, "previous_cash"],
];

/** Read the owner's closing message. Header line = location + date. */
export function parseClosingText(text: string, today = istToday()): { location?: string; date?: string; items: ParsedItem[]; money: Money } {
  const lines = text.split(/\r?\n|\s+\/\s+/).map((l) => l.trim()).filter(Boolean);
  const items: ParsedItem[] = [];
  const money: Money = {};
  let location: string | undefined;
  let date: string | undefined;
  let lastHead = "";
  const pair = /([^\s.][^\n]*?)\s*(?:\.{2,}|:|=|-{1,}|…+)\s*(\d+(?:\.\d+)?(?:\s*\+\s*\d+(?:\.\d+)?)*)(?=\s|$)/g;

  lines.forEach((line, idx) => {
    const dm = line.match(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\s*$/);
    if (dm && !date && !items.length && !/(\.{2,}|:|=)\s*\d+(\.\d+)?\s*$/.test(line)) {
      const name = line.slice(0, dm.index).replace(/[.\s:\-–]+$/, "").trim();
      const year = dm[3] ? (dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3])) : Number(today.slice(0, 4));
      let d = `${year}-${String(Number(dm[2])).padStart(2, "0")}-${String(Number(dm[1])).padStart(2, "0")}`;
      if (!dm[3] && d > today) d = `${year - 1}${d.slice(4)}`;
      if (name) location = name;
      date = d;
      return;
    }
    const found: { name: string; qty: string }[] = [];
    let m: RegExpExecArray | null;
    pair.lastIndex = 0;
    while ((m = pair.exec(line))) found.push({ name: m[1].trim(), qty: m[2] });
    if (!found.length) {
      if (idx === 0 && !location) location = line.replace(/[.\s:\-–]+$/, "");
      return;
    }
    const firstWords = normalizeName(found[0].name).split(" ");
    const head = firstWords.length >= 2 ? firstWords[0] : "";
    const carried = !head && firstWords.length === 1 ? lastHead : "";
    lastHead = head;
    found.forEach((f, i) => {
      const qty = evalQty(f.qty);
      if (qty === null) return;
      const mw = MONEY_WORDS.find(([re]) => re.test(normalizeName(f.name)));
      if (mw) {
        (money as any)[mw[1]] = qty;
        return;
      }
      const alt = i > 0 && head ? `${head} ${f.name}` : i === 0 && carried ? `${carried} ${f.name}` : undefined;
      items.push({ text: f.name, alt, qty, raw: `${f.name}…${f.qty}` });
    });
  });
  return { location, date, items, money };
}

// ---------------------------------------------------------------- aliases
async function aliasMap(organizationId: string, kind: string): Promise<Map<string, { id: number; name: string }>> {
  const rows = await prisma.bizAlias.findMany({ where: { organizationId, kind } });
  return new Map(rows.map((r) => [r.alias, { id: r.targetId, name: r.targetName }]));
}

export async function saveAlias(organizationId: string, kind: "product" | "location", alias: string, targetId: number, targetName: string) {
  const a = normalizeName(alias);
  if (!a) return;
  await prisma.bizAlias.upsert({
    where: { organizationId_kind_alias: { organizationId, kind, alias: a } },
    create: { organizationId, kind, alias: a, targetId, targetName },
    update: { targetId, targetName },
  });
}

type Match = { product?: BmsProduct; candidates: BmsProduct[]; via: "alias" | "fuzzy" | "none" };

export function matchProduct(item: { text: string; alt?: string }, products: BmsProduct[], aliases: Map<string, { id: number; name: string }>): Match {
  for (const t of [item.alt, item.text]) {
    if (!t) continue;
    const hit = aliases.get(normalizeName(t));
    const prod = hit && products.find((p) => p.product_id === hit.id);
    if (prod) return { product: prod, candidates: [], via: "alias" };
  }
  // The name as written first; the section name ("Doi" + "1kg") only when
  // that alone is not clear.
  let pool: { p: BmsProduct; s: number }[] = [];
  for (const t of [item.text, item.alt]) {
    if (!t) continue;
    const scored = products.map((p) => ({ p, s: nameScore(t, p.name) })).sort((a, b) => b.s - a.s);
    const [best, second] = scored;
    if (best && best.s >= 0.74 && (!second || best.s - second.s >= 0.07)) return { product: best.p, candidates: [], via: "fuzzy" };
    pool = pool.concat(scored.slice(0, 4));
  }
  const seen = new Set<number>();
  const candidates = pool
    .sort((a, b) => b.s - a.s)
    .filter((x) => x.s >= 0.35 && !seen.has(x.p.product_id) && seen.add(x.p.product_id))
    .slice(0, 3)
    .map((x) => x.p);
  return { candidates, via: "none" };
}

// ---------------------------------------------------------------- locations
async function findLocation(organizationId: string, text: string | undefined, date: string): Promise<{ loc?: BmsLoc; options: BmsLoc[] }> {
  const res = await bms<{ locations: BmsLoc[] }>(`closing-context?date=${date}`);
  const open = (res.locations || []).filter((l) => l.type !== "warehouse");
  if (!text) return { loc: open.length === 1 ? open[0] : undefined, options: open };
  const aliases = await aliasMap(organizationId, "location");
  const hit = aliases.get(normalizeName(text));
  const viaAlias = hit && open.find((l) => l.id === hit.id);
  if (viaAlias) return { loc: viaAlias, options: open };
  const scored = open
    .map((l) => ({ l, s: normalizeName(l.name).includes(normalizeName(text)) ? 0.95 : nameScore(text, l.name) }))
    .sort((a, b) => b.s - a.s);
  if (scored[0] && scored[0].s >= 0.7 && (!scored[1] || scored[0].s - scored[1].s >= 0.07)) return { loc: scored[0].l, options: open };
  return { options: scored.filter((x) => x.s >= 0.3).map((x) => x.l).concat(scored.filter((x) => x.s < 0.3).map((x) => x.l)) };
}

// ---------------------------------------------------------------- preview text
const r = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const q = (n: number | null) => (n === null ? "—" : String(Math.round(n * 1000) / 1000));
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

function formatPreview(p: BmsPreview, pending: Pending, saved = false): string {
  const out: string[] = [];
  out.push(saved ? `✅ *Closing saved* — ${p.location.name} · ${dmy(p.date)}` : `📋 *Closing Preview* — ${p.location.name} · ${dmy(p.date)}`);
  const changed = p.lines.filter((l) => l.changed);
  if (!saved) {
    out.push("");
    out.push(`*Closing (${changed.length})* — নাম · closing (stock → sale)`);
    for (const l of changed) {
      const old = l.old_closing !== null && l.old_closing !== l.closing ? ` _(আগে ${q(l.old_closing)})_` : "";
      out.push(`• ${l.product} — *${q(l.closing)}*${old} (${q(l.available)}→${q(l.sale_qty)})`);
    }
  }
  if (p.problems.length) {
    out.push("");
    out.push("⛔ *সেভ হবে না:*");
    for (const pr of p.problems) out.push(`• ${pr.product || "#" + pr.product_id}: ${pr.problem}`);
  }
  if (!saved && pending.unsure.length) {
    out.push("");
    out.push("❓ *বুঝতে পারিনি — কোনটা?*");
    for (const u of pending.unsure) out.push(`• "${u.text}" (${q(u.qty)}) → ${u.candidates.length ? u.candidates.join(" / ") + " ?" : "এই location-এ এমন product পাইনি"}`);
  }
  if (p.not_entered.length) {
    out.push("");
    out.push(`⚠️ *Closing দেওয়া হয়নি (${p.not_entered.length}):* ${p.not_entered.slice(0, 12).map((n) => `${n.product} (${q(n.available)})`).join(", ")}${p.not_entered.length > 12 ? " …" : ""}`);
  }
  out.push("");
  out.push(`🧾 Actual Product Sale: *${r(p.product_sale)}*${p.pos_sale > 0 ? ` (POS ${r(p.pos_sale)} সহ)` : ""}`);
  if (p.money) {
    const m = p.money;
    const exp = m.expenses.length ? ` (${m.expenses.map((e) => `${e.purpose || "খরচ"} ${r(e.amount)}`).join(", ")})` : "";
    out.push(`💵 Cash ${r(m.cash)} − ${p.location.type === "event" ? "Change" : "Prev"} ${r(m.previous_cash)} + খরচ ${r(m.expense_total)}${exp} = ${r(m.cash_sale)}`);
    out.push(`📲 Online ${r(m.online)} → Counter Sale *${r(m.counter_sale)}*`);
    const s = p.short ?? 0;
    out.push(p.verdict === "SHORT" ? `🔴 *DAY SHORT: − ${r(s)}*` : p.verdict === "EXCESS" ? `🟢 *EXCESS: + ${r(-s)}*` : "✅ *MATCHED*");
  } else {
    out.push("💵 Cash / Online এখনো দেওয়া হয়নি (চাইলে লিখুন: Cash…4480 Online…5220 Change…2880, খরচ Tea…50)");
  }
  if (!saved) {
    out.push("");
    out.push(pending.unsure.length ? "❓-গুলো বলে দিন, অথবা এখনই *হ্যাঁ* লিখলে বাকিগুলো সেভ হবে। বাতিল করতে *না*।" : "ঠিক থাকলে *হ্যাঁ* লিখুন — সেভ হবে। কিছু বদলাতে চাইলে লিখুন (যেমন: Rosogolla 190)। বাতিল করতে *না*।");
  }
  return out.join("\n");
}

async function runPreview(organizationId: string, pending: Pending): Promise<string> {
  const preview = await bms<BmsPreview>("closing-preview", {
    location_id: pending.location_id,
    date: pending.date,
    closings: pending.closings.map((c) => ({ product_id: c.product_id, qty: c.qty })),
    money: pending.money,
  });
  if (preview.error) return `Banglar Doi OS: ${preview.error}`;
  await prisma.bizPendingClosing.upsert({
    where: { organizationId },
    create: { organizationId, payload: pending as any },
    update: { payload: pending as any },
  });
  return formatPreview(preview, pending);
}

// ---------------------------------------------------------------- public tool actions
function mergeMoney(base: Money, extra: Money): Money {
  const out: Money = { ...base };
  for (const k of ["cash", "online", "previous_cash"] as const) if (typeof extra[k] === "number" && !Number.isNaN(extra[k])) out[k] = extra[k];
  if (Array.isArray(extra.expenses)) out.expenses = extra.expenses.filter((e) => e && Number(e.amount) > 0).map((e) => ({ purpose: String(e.purpose || ""), amount: Number(e.amount), type: e.type === "fund_transfer" ? "fund_transfer" : "expense" }));
  return out;
}

export async function prepareClosing(
  organizationId: string,
  args: { message_text?: string; location?: string; date?: string; lines?: { name: string; qty: number | string }[]; money?: Money }
): Promise<string> {
  const parsed = parseClosingText(args.message_text || "");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(args.date || "") ? args.date! : parsed.date || istToday();
  const locText = args.location || parsed.location;
  const { loc, options } = await findLocation(organizationId, locText, date);
  if (!loc) {
    return `LOCATION_UNCLEAR: "${locText || "(none)"}" on ${dmy(date)}. Open locations that day: ${options.map((o) => o.name).join(" | ") || "none"}. Ask the owner which one (show the list), then call prepare_closing again with location set to the exact name. Nothing saved.`;
  }
  if (locText && normalizeName(locText) !== normalizeName(loc.name)) await saveAlias(organizationId, "location", locText, loc.id, loc.name);

  const items: ParsedItem[] = [...parsed.items];
  for (const l of args.lines || []) {
    const qty = typeof l.qty === "number" ? l.qty : evalQty(String(l.qty));
    if (l.name && qty !== null && qty !== undefined) items.push({ text: String(l.name), qty, raw: `${l.name}…${l.qty}` });
  }
  if (!items.length) return "NO_ITEMS: could not read any 'name…qty' lines. Ask the owner to send the closing list as lines like 'Rosogolla…200'. Nothing saved.";

  const ctx = await bms<BmsContext>(`closing-context?date=${date}&location_id=${loc.id}`);
  if (ctx.error) return `Banglar Doi OS: ${ctx.error}`;
  const aliases = await aliasMap(organizationId, "product");
  const closings = new Map<number, Pending["closings"][number]>();
  const unsure: Unsure[] = [];
  for (const it of items) {
    const m = matchProduct(it, ctx.products, aliases);
    if (m.product) {
      const prev = closings.get(m.product.product_id);
      closings.set(m.product.product_id, { product_id: m.product.product_id, product: m.product.name, qty: (prev ? prev.qty : 0) + it.qty, from: it.alt || it.text });
    } else unsure.push({ text: it.text, alt: it.alt, qty: it.qty, candidates: m.candidates.map((c) => c.name) });
  }
  const pending: Pending = {
    location_id: loc.id,
    location_name: loc.name,
    date,
    closings: [...closings.values()],
    unsure,
    money: mergeMoney(parsed.money, args.money || {}),
  };
  return "PREVIEW (send this to the owner as it is, nothing saved yet):\n\n" + (await runPreview(organizationId, pending));
}

async function loadPending(organizationId: string): Promise<Pending | null> {
  const row = await prisma.bizPendingClosing.findUnique({ where: { organizationId } });
  if (!row || Date.now() - row.updatedAt.getTime() > PENDING_MAX_AGE_MS) return null;
  return row.payload as unknown as Pending;
}

/** Change lines / money on the waiting preview ("Rosogolla 190", "Kaloo = Kalo Jam"). */
export async function updatePendingClosing(
  organizationId: string,
  args: { lines?: { name: string; qty?: number | string; product_name?: string }[]; money?: Money; remove?: string[] }
): Promise<string> {
  const pending = await loadPending(organizationId);
  if (!pending) return "NO_PENDING: there is no closing waiting for confirmation. Ask the owner to send the closing list again.";
  const ctx = await bms<BmsContext>(`closing-context?date=${pending.date}&location_id=${pending.location_id}`);
  const aliases = await aliasMap(organizationId, "product");
  const notes: string[] = [];
  for (const l of args.lines || []) {
    const wanted = l.product_name || l.name;
    const m = l.product_name
      ? { product: ctx.products.find((p) => normalizeName(p.name) === normalizeName(l.product_name!)) || matchProduct({ text: l.product_name }, ctx.products, aliases).product, candidates: [] as BmsProduct[] }
      : matchProduct({ text: l.name }, ctx.products, aliases);
    if (!m.product) {
      notes.push(`"${wanted}" — product not found at this location${"candidates" in m && m.candidates.length ? ` (maybe ${m.candidates.map((c) => c.name).join(" / ")})` : ""}`);
      continue;
    }
    const said = normalizeName(l.name);
    const open = pending.unsure.findIndex(
      (u) => normalizeName(u.text) === said || (u.alt && normalizeName(u.alt) === said) || (!!l.product_name && u.candidates.includes(m.product!.name) && normalizeName(u.alt || u.text).includes(said))
    );
    let qty = l.qty === undefined || l.qty === "" ? null : typeof l.qty === "number" ? l.qty : evalQty(String(l.qty));
    if (open >= 0) {
      if (qty === null) qty = pending.unsure[open].qty;
      if (l.product_name) {
        const u = pending.unsure[open];
        await saveAlias(organizationId, "product", u.text, m.product.product_id, m.product.name);
        if (u.alt) await saveAlias(organizationId, "product", u.alt, m.product.product_id, m.product.name);
      }
      pending.unsure.splice(open, 1);
    } else if (l.product_name && normalizeName(l.name) !== normalizeName(l.product_name)) {
      await saveAlias(organizationId, "product", l.name, m.product.product_id, m.product.name);
    }
    if (qty === null) {
      notes.push(`"${wanted}" — qty missing`);
      continue;
    }
    const i = pending.closings.findIndex((c) => c.product_id === m.product!.product_id);
    const row = { product_id: m.product.product_id, product: m.product.name, qty, from: l.name };
    if (i >= 0) pending.closings[i] = row;
    else pending.closings.push(row);
  }
  for (const name of args.remove || []) {
    const n = normalizeName(name);
    pending.closings = pending.closings.filter((c) => normalizeName(c.product) !== n && normalizeName(c.from) !== n);
    pending.unsure = pending.unsure.filter((u) => normalizeName(u.text) !== n && normalizeName(u.alt || "") !== n);
  }
  pending.money = mergeMoney(pending.money, args.money || {});
  const text = await runPreview(organizationId, pending);
  return (notes.length ? `NOTES: ${notes.join("; ")}\n\n` : "") + "UPDATED PREVIEW (send to the owner, nothing saved yet):\n\n" + text;
}

/** Owner said "হ্যাঁ" — save the waiting closing to Banglar Doi OS. */
export async function confirmClosing(organizationId: string): Promise<string> {
  const pending = await loadPending(organizationId);
  if (!pending) return "NO_PENDING: nothing is waiting to be saved (or the preview is older than 6 hours). Ask the owner to send the closing list again.";
  const saved = await bms<BmsPreview>("closing-save", {
    location_id: pending.location_id,
    date: pending.date,
    closings: pending.closings.map((c) => ({ product_id: c.product_id, qty: c.qty })),
    money: pending.money,
  });
  if (saved.error || !saved.saved) return `NOT SAVED: ${saved.error || "Banglar Doi OS did not confirm"}`;
  await prisma.bizPendingClosing.delete({ where: { organizationId } }).catch(() => undefined);
  try {
    await syncBizDay(organizationId, pending.date);
  } catch (err) {
    console.error("Closing saved but analyst sync failed", err);
  }
  const head = `SAVED in Banglar Doi OS: ${saved.saved_closings ?? 0} closing qty${saved.saved_money ? " + cash/online/expenses" : ""}. Tell the owner briefly, with this summary:\n\n`;
  return head + formatPreview(saved, { ...pending, unsure: [] }, true) + (pending.unsure.length ? `\n\n(সেভ হয়নি: ${pending.unsure.map((u) => u.text).join(", ")})` : "");
}

export async function cancelClosing(organizationId: string): Promise<string> {
  await prisma.bizPendingClosing.delete({ where: { organizationId } }).catch(() => undefined);
  return "Cancelled — nothing was saved.";
}

/** Owner teaches a name: "Kaloo mane Kalo Jam". */
export async function rememberProductAlias(organizationId: string, alias: string, productName: string): Promise<string> {
  const pending = await loadPending(organizationId);
  if (pending) return updatePendingClosing(organizationId, { lines: [{ name: alias, product_name: productName }] });
  return `No closing is waiting. Ask the owner to send the closing; the name "${alias}" can be taught while a preview is open.`;
}
