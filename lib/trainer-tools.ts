import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { processKnowledgeContent } from "@/app/dashboard/agent/actions";
import { runSandboxReply } from "@/lib/sandbox-reply";
import type { ToolDefinition } from "@/lib/llm";

// WhatsApp Trainer (2026-11-27). Owner (8017011018) → AI number: see and
// change everything that shapes how the customer AI talks — rules, persona,
// greeting, tone, language, word lists, knowledge notes — safely:
//   1. propose_ai_change  → saved as PENDING, owner sees "before → after"
//   2. owner says "হ্যাঁ" → confirm_ai_change applies it (old value kept)
//   3. "undo"             → undo_last_ai_change restores the old value
// test_customer_reply shows what the AI would answer a customer right now,
// without sending anything to anyone.

const PENDING_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const TONES = ["friendly", "formal", "casual", "traditional", "premium", "luxury", "professional", "humorous"];
const LANGS = ["bn", "en", "mixed"];

type Words = { wordsToUse: string[]; wordsToAvoid: string[]; terminology: { from: string; to: string }[] };

function parseRules(text: string | null | undefined): string[] {
  return (text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}
const joinRules = (rules: string[]) => rules.map((r) => `- ${r}`).join("\n");

function parseWords(raw: string | null | undefined): Words {
  try {
    const p = JSON.parse(raw || "{}");
    return {
      wordsToUse: Array.isArray(p.wordsToUse) ? p.wordsToUse.filter((x: unknown) => typeof x === "string" && x.trim()) : [],
      wordsToAvoid: Array.isArray(p.wordsToAvoid) ? p.wordsToAvoid.filter((x: unknown) => typeof x === "string" && x.trim()) : [],
      terminology: Array.isArray(p.terminology) ? p.terminology.filter((t: { from?: string; to?: string }) => t?.from?.trim() && t?.to?.trim()) : [],
    };
  } catch {
    return { wordsToUse: [], wordsToAvoid: [], terminology: [] };
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);

/* ------------------------------------------------------------- tool defs */

export const TRAINER_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_ai_setup",
      description:
        "Show how the customer AI is set up right now: numbered standing rules, persona (core identity), greeting, tone, language, word lists, and knowledge notes / trained Q&A (titles). ALWAYS call this before proposing a change to rules/persona/words (to quote the right rule number and to spot a conflict with an existing rule), and whenever the owner asks what rules/notes exist.",
      parameters: {
        type: "object",
        properties: {
          section: { type: "string", enum: ["all", "rules", "persona", "words", "notes"], description: "Default all." },
          search: { type: "string", description: "Optional: only notes whose title contains this." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_ai_change",
      description:
        "Prepare ONE change to the customer AI. Nothing changes yet — the result is a 'before → after' preview to send to the owner, who must reply হ্যাঁ/yes; then call confirm_ai_change. Use for: adding/editing/deleting a standing rule, replacing or adding to the persona, greeting, tone, language, the words to use/avoid/replace, and deleting a knowledge note or Q&A. If a new rule contradicts an existing one, say so to the owner and ask which to keep before proposing.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["add_rule", "edit_rule", "delete_rule", "set_persona", "set_greeting", "set_tone", "set_language", "words", "delete_note"],
          },
          rule_number: { type: "integer", description: "edit_rule / delete_rule: the number from get_ai_setup." },
          text: {
            type: "string",
            description: "add_rule / edit_rule: the rule as one clear standalone instruction. set_persona: the persona paragraph. set_greeting: the greeting message.",
          },
          persona_mode: { type: "string", enum: ["replace", "append"], description: "set_persona: replace the whole persona or add to it (default append)." },
          tone: { type: "string", enum: TONES },
          language: { type: "string", enum: LANGS, description: "bn = Bengali, en = English, mixed = Bengali/English/Banglish as the customer writes." },
          use_add: { type: "array", items: { type: "string" } },
          use_remove: { type: "array", items: { type: "string" } },
          avoid_add: { type: "array", items: { type: "string" } },
          avoid_remove: { type: "array", items: { type: "string" } },
          replace_add: {
            type: "array",
            description: "Always say 'to' instead of 'from'.",
            items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
          },
          replace_remove: { type: "array", items: { type: "string" }, description: "'from' words to stop replacing." },
          note: { type: "string", description: "delete_note: the note's exact title (or id) from get_ai_setup." },
        },
        required: ["kind"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_ai_change",
      description: "Apply the change waiting for confirmation. ONLY right after the owner clearly says হ্যাঁ / ha / yes / ok to a 'before → after' preview.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_ai_change",
      description: "Throw away the change waiting for confirmation (owner says না / no / cancel).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "undo_last_ai_change",
      description: "Undo the most recent applied trainer change (owner says undo / আগেরটা ফিরিয়ে দাও). Restores exactly what was there before.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_ai_changes",
      description: "The last few trainer changes (what, when, applied/undone) — when the owner asks what was changed recently.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "test_customer_reply",
      description:
        "Show what the customer AI would answer a customer RIGHT NOW (with all current rules, notes and catalog) — nothing is sent to anyone. Use when the owner writes 'test: …' or asks 'customer jodi … bole ki bolbe?', and offer it after a change is applied.",
      parameters: {
        type: "object",
        properties: { customer_message: { type: "string", description: "What the customer says, exactly as the owner gave it." } },
        required: ["customer_message"],
      },
    },
  },
];

const TRAINER_NAMES = new Set(TRAINER_TOOLS.map((t) => t.function.name));
export const isTrainerTool = (name: string) => TRAINER_NAMES.has(name);

export function trainerPromptAddon(): string {
  return `

TRAINER (2026-11-27). The owner trains the customer AI from here. Think like a careful human trainer:
- Before changing rules/persona/words, call get_ai_setup, understand what is already there, and if the new instruction overlaps or contradicts an existing rule, tell the owner (quote the rule number) and suggest one clean wording — edit the old rule instead of adding a duplicate.
- Every change to rules / persona / greeting / tone / language / words / deleting a note goes through propose_ai_change → show the owner the preview it returns (before → after) and ask "হ্যাঁ?" → only after a clear yes call confirm_ai_change. Never say something changed unless confirm_ai_change returned APPLIED.
- Prefer update_style_rule ONLY when the owner explicitly says "just add it now"; otherwise use propose_ai_change kind add_rule.
- "undo" → undo_last_ai_change. "ki change korechi" → list_ai_changes.
- "test: …" or "customer jodi … bole?" → test_customer_reply and show the reply exactly; after applying a change, offer one quick test.
- Rewrite the owner's words into a clear, general rule the AI can follow, in the same language mix the owner uses, and keep rules short.`;
}

/* -------------------------------------------------------------- executor */

export async function executeTrainerTool(organizationId: string, name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case "get_ai_setup":
        return await getSetup(organizationId, String(args.section || "all"), String(args.search || ""));
      case "propose_ai_change":
        return await propose(organizationId, args);
      case "confirm_ai_change":
        return await confirm(organizationId);
      case "cancel_ai_change":
        await prisma.trainerChange.updateMany({ where: { organizationId, status: "PENDING" }, data: { status: "CANCELLED" } });
        return "Cancelled — nothing was changed.";
      case "undo_last_ai_change":
        return await undo(organizationId);
      case "list_ai_changes": {
        const rows = await prisma.trainerChange.findMany({ where: { organizationId, status: { in: ["APPLIED", "UNDONE"] } }, orderBy: { createdAt: "desc" }, take: 8 });
        if (!rows.length) return "No trainer changes yet.";
        return rows
          .map((r) => `${(r.appliedAt ?? r.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · ${r.status === "UNDONE" ? "↩️ undone · " : ""}${r.summary}`)
          .join("\n");
      }
      case "test_customer_reply": {
        const q = String(args.customer_message || "").trim();
        if (!q) return "No customer message given.";
        const profile = await prisma.agentProfile.findUnique({ where: { organizationId } });
        const org = await prisma.organization.findUnique({ where: { id: organizationId } });
        const { answer } = await runSandboxReply(
          organizationId,
          q,
          {
            businessName: profile?.businessName || org?.name,
            businessDescription: profile?.businessDescription,
            coreIdentity: profile?.coreIdentity,
            customInstructions: profile?.customInstructions,
            brandLanguage: profile?.brandLanguage,
            tone: profile?.tone,
            languageStyle: profile?.languageStyle,
            skillSaveAddress: profile?.skillSaveAddress,
            skillReminders: profile?.skillReminders,
            skillTrackInterest: profile?.skillTrackInterest,
            skillTakeOrders: profile?.skillTakeOrders,
          },
          [],
          "owner_assistant"
        );
        return `TEST ONLY (nothing sent). Show the owner exactly this as the AI's reply to "${q}":\n\n${answer}`;
      }
    }
  } catch (err) {
    console.error("Trainer tool failed", name, err);
    return "That didn't work right now — nothing was changed. Ask the owner to try again.";
  }
  return "Unknown tool";
}

async function getSetup(organizationId: string, section: string, search: string): Promise<string> {
  const p = await prisma.agentProfile.findUnique({ where: { organizationId } });
  const out: string[] = [];
  const all = section === "all";
  if (all || section === "rules") {
    const rules = parseRules(p?.customInstructions);
    out.push(`STANDING RULES (${rules.length}):\n${rules.length ? rules.map((r, i) => `${i + 1}. ${clip(r, 400)}`).join("\n") : "(none)"}`);
  }
  if (all || section === "persona") {
    out.push(`PERSONA: ${p?.coreIdentity?.trim() ? clip(p.coreIdentity.trim(), 1200) : "(not set — default assistant)"}`);
    out.push(`GREETING: ${p?.greetingMessage?.trim() || "(none)"}`);
    out.push(`TONE: ${p?.tone || "friendly"} · LANGUAGE: ${p?.languageStyle || "mixed"}`);
  }
  if (all || section === "words") {
    const w = parseWords(p?.brandLanguage);
    out.push(
      `WORDS — use: ${w.wordsToUse.join(", ") || "-"}\nWORDS — avoid: ${w.wordsToAvoid.join(", ") || "-"}\nREPLACE: ${w.terminology.map((t) => `${t.from} → ${t.to}`).join(", ") || "-"}`
    );
  }
  if (all || section === "notes") {
    const docs = await prisma.document.findMany({
      where: { organizationId, product: null, event: null, ...(search ? { title: { contains: search, mode: "insensitive" } } : {}) },
      orderBy: { createdAt: "desc" },
      take: all ? 15 : 40,
      select: { title: true, createdAt: true },
    });
    out.push(`KNOWLEDGE NOTES / Q&A (${docs.length}${all && docs.length === 15 ? ", latest 15" : ""}):\n${docs.map((d) => `• ${d.title}`).join("\n") || "(none)"}`);
  }
  return out.join("\n\n");
}

async function propose(organizationId: string, a: Record<string, unknown>): Promise<string> {
  const p = await prisma.agentProfile.findUnique({ where: { organizationId } });
  const kind = String(a.kind || "");
  const rules = parseRules(p?.customInstructions);
  const text = String(a.text || "").trim();
  let summary = "";
  let preview = "";
  let payload: Record<string, unknown> = { kind };

  switch (kind) {
    case "add_rule": {
      if (!text) return "Rule text missing.";
      payload = { kind, text };
      summary = `Rule added: ${clip(text, 120)}`;
      preview = `➕ নতুন rule (#${rules.length + 1}):\n"${text}"`;
      break;
    }
    case "edit_rule":
    case "delete_rule": {
      const n = Number(a.rule_number);
      if (!Number.isInteger(n) || n < 1 || n > rules.length) return `There is no rule #${a.rule_number}. Call get_ai_setup and use a number 1-${rules.length}.`;
      if (kind === "edit_rule") {
        if (!text) return "New rule text missing.";
        payload = { kind, number: n, old: rules[n - 1], text };
        summary = `Rule #${n} edited`;
        preview = `✏️ Rule #${n}\nআগে: "${rules[n - 1]}"\nএখন: "${text}"`;
      } else {
        payload = { kind, number: n, old: rules[n - 1] };
        summary = `Rule #${n} deleted: ${clip(rules[n - 1], 100)}`;
        preview = `🗑️ Rule #${n} মুছে যাবে:\n"${rules[n - 1]}"`;
      }
      break;
    }
    case "set_persona": {
      if (!text) return "Persona text missing.";
      const mode = a.persona_mode === "replace" ? "replace" : "append";
      const before = p?.coreIdentity?.trim() || "";
      const after = mode === "replace" || !before ? text : `${before}\n\n${text}`;
      payload = { kind, value: after };
      summary = `Persona ${mode === "replace" ? "replaced" : "extended"}`;
      preview = `🧑 Persona ${mode === "replace" ? "পুরো বদলাবে" : "তে যোগ হবে"}:\nআগে: ${before ? `"${clip(before, 500)}"` : "(ছিল না)"}\nএখন: "${clip(after, 900)}"`;
      break;
    }
    case "set_greeting": {
      if (!text) return "Greeting text missing.";
      payload = { kind, value: text };
      summary = "Greeting changed";
      preview = `👋 Greeting\nআগে: "${p?.greetingMessage || "(ছিল না)"}"\nএখন: "${text}"`;
      break;
    }
    case "set_tone": {
      const tone = String(a.tone || "");
      if (!TONES.includes(tone)) return `Tone must be one of: ${TONES.join(", ")}.`;
      payload = { kind, value: tone };
      summary = `Tone → ${tone}`;
      preview = `🎵 Tone: ${p?.tone || "friendly"} → ${tone}`;
      break;
    }
    case "set_language": {
      const lang = String(a.language || "");
      if (!LANGS.includes(lang)) return "Language must be bn, en or mixed.";
      payload = { kind, value: lang };
      summary = `Language → ${lang}`;
      preview = `🗣️ Language: ${p?.languageStyle || "mixed"} → ${lang}`;
      break;
    }
    case "words": {
      const w = parseWords(p?.brandLanguage);
      const lc = (s: string) => s.toLowerCase();
      const useRm = strList(a.use_remove).map(lc);
      const avRm = strList(a.avoid_remove).map(lc);
      const repRm = strList(a.replace_remove).map(lc);
      const repAdd = Array.isArray(a.replace_add)
        ? (a.replace_add as { from?: string; to?: string }[]).filter((t) => t?.from?.trim() && t?.to?.trim()).map((t) => ({ from: t.from!.trim(), to: t.to!.trim() }))
        : [];
      const next: Words = {
        wordsToUse: [...new Set([...w.wordsToUse.filter((x) => !useRm.includes(lc(x))), ...strList(a.use_add)])],
        wordsToAvoid: [...new Set([...w.wordsToAvoid.filter((x) => !avRm.includes(lc(x))), ...strList(a.avoid_add)])],
        terminology: [
          ...w.terminology.filter((t) => !repRm.includes(lc(t.from)) && !repAdd.some((r) => lc(r.from) === lc(t.from))),
          ...repAdd,
        ],
      };
      const changes: string[] = [];
      strList(a.use_add).forEach((x) => changes.push(`➕ ব্যবহার করবে: ${x}`));
      useRm.forEach((x) => changes.push(`➖ আর "ব্যবহার করবে" তালিকায় নেই: ${x}`));
      strList(a.avoid_add).forEach((x) => changes.push(`🚫 বলবে না: ${x}`));
      avRm.forEach((x) => changes.push(`✅ আবার বলা যাবে: ${x}`));
      repAdd.forEach((t) => changes.push(`🔁 "${t.from}" না বলে "${t.to}"`));
      repRm.forEach((x) => changes.push(`➖ "${x}" বদলানো বন্ধ`));
      if (!changes.length) return "No word change given.";
      payload = { kind, value: JSON.stringify(next) };
      summary = `Words: ${clip(changes.join("; "), 140)}`;
      preview = `📝 শব্দের তালিকা:\n${changes.join("\n")}`;
      break;
    }
    case "delete_note": {
      const key = String(a.note || "").trim();
      if (!key) return "Which note? Give its exact title from get_ai_setup.";
      const doc =
        (await prisma.document.findFirst({ where: { organizationId, id: key }, include: { product: true, event: true } })) ||
        (await prisma.document.findFirst({ where: { organizationId, title: { equals: key, mode: "insensitive" } }, include: { product: true, event: true } })) ||
        (await prisma.document.findFirst({ where: { organizationId, title: { contains: key, mode: "insensitive" } }, include: { product: true, event: true }, orderBy: { createdAt: "desc" } }));
      if (!doc) return `No note titled like "${key}". Call get_ai_setup section notes with search to find it.`;
      if (doc.product || doc.event) return `"${doc.title}" belongs to a Product/Event — change it on that page, not here.`;
      payload = { kind, documentId: doc.id, title: doc.title };
      summary = `Note deleted: ${doc.title}`;
      preview = `🗑️ এই note মুছে যাবে: "${doc.title}"\n${doc.content ? clip(doc.content, 300) : ""}`;
      break;
    }
    default:
      return "Unknown change kind.";
  }

  await prisma.trainerChange.updateMany({ where: { organizationId, status: "PENDING" }, data: { status: "CANCELLED" } });
  await prisma.trainerChange.create({ data: { organizationId, kind, summary, payload: payload as object } });
  return `PREVIEW — nothing changed yet. Send the owner this and ask "ঠিক আছে? হ্যাঁ লিখলে চালু হবে":\n\n${preview}`;
}

async function confirm(organizationId: string): Promise<string> {
  const ch = await prisma.trainerChange.findFirst({ where: { organizationId, status: "PENDING" }, orderBy: { createdAt: "desc" } });
  if (!ch || Date.now() - ch.createdAt.getTime() > PENDING_MAX_AGE_MS) return "NO_PENDING: nothing is waiting (or it is older than 2 hours). Propose the change again.";
  const pl = ch.payload as Record<string, unknown>;
  const p = await prisma.agentProfile.findUnique({ where: { organizationId } });
  let before: Record<string, unknown> = {};
  const data: Record<string, unknown> = {};

  switch (ch.kind) {
    case "add_rule":
    case "edit_rule":
    case "delete_rule": {
      const rules = parseRules(p?.customInstructions);
      before = { field: "customInstructions", value: p?.customInstructions ?? null };
      if (ch.kind === "add_rule") rules.push(String(pl.text));
      else {
        const n = Number(pl.number);
        // The list may have moved since the preview — find the rule by its text.
        const idx = rules[n - 1] === pl.old ? n - 1 : rules.indexOf(String(pl.old));
        if (idx < 0) return "The rules changed since the preview — call get_ai_setup and propose again.";
        if (ch.kind === "edit_rule") rules[idx] = String(pl.text);
        else rules.splice(idx, 1);
      }
      data.customInstructions = rules.length ? joinRules(rules) : null;
      break;
    }
    case "set_persona":
      before = { field: "coreIdentity", value: p?.coreIdentity ?? null };
      data.coreIdentity = String(pl.value);
      break;
    case "set_greeting":
      before = { field: "greetingMessage", value: p?.greetingMessage ?? null };
      data.greetingMessage = String(pl.value);
      break;
    case "set_tone":
      before = { field: "tone", value: p?.tone ?? "friendly" };
      data.tone = String(pl.value);
      break;
    case "set_language":
      before = { field: "languageStyle", value: p?.languageStyle ?? "mixed" };
      data.languageStyle = String(pl.value);
      break;
    case "words":
      before = { field: "brandLanguage", value: p?.brandLanguage ?? null };
      data.brandLanguage = String(pl.value);
      break;
    case "delete_note": {
      const doc = await prisma.document.findFirst({ where: { organizationId, id: String(pl.documentId) } });
      if (!doc) return "That note is already gone.";
      before = { note: { title: doc.title, content: doc.content, fileUrl: doc.fileUrl } };
      await prisma.document.delete({ where: { id: doc.id } });
      break;
    }
  }
  if (Object.keys(data).length) {
    await prisma.agentProfile.upsert({ where: { organizationId }, update: data, create: { organizationId, ...data } });
  }
  await prisma.trainerChange.update({ where: { id: ch.id }, data: { status: "APPLIED", appliedAt: new Date(), before: before as object } });
  await logAudit({ organizationId, action: "TRAINER_CHANGE_APPLIED", metadata: { kind: ch.kind, summary: ch.summary, source: "whatsapp_owner_assistant" } });
  return `APPLIED: ${ch.summary}. It is live for customers now. Tell the owner in one line, mention they can say "undo", and offer a quick test.`;
}

async function undo(organizationId: string): Promise<string> {
  const ch = await prisma.trainerChange.findFirst({ where: { organizationId, status: "APPLIED" }, orderBy: [{ appliedAt: "desc" }, { createdAt: "desc" }] });
  if (!ch) return "Nothing to undo.";
  const b = (ch.before || {}) as { field?: string; value?: unknown; note?: { title: string; content: string | null; fileUrl: string } };
  if (b.field) {
    await prisma.agentProfile.update({ where: { organizationId }, data: { [b.field]: b.value ?? null } });
  } else if (b.note) {
    const doc = await prisma.document.create({ data: { organizationId, title: b.note.title, fileUrl: b.note.fileUrl || "teach-ai-chat", status: "PENDING" } });
    if (b.note.content) await processKnowledgeContent(organizationId, doc.id, b.note.content);
  } else {
    return "This change cannot be undone automatically.";
  }
  await prisma.trainerChange.update({ where: { id: ch.id }, data: { status: "UNDONE" } });
  await logAudit({ organizationId, action: "TRAINER_CHANGE_UNDONE", metadata: { kind: ch.kind, summary: ch.summary } });
  return `UNDONE: ${ch.summary} — back to how it was. Tell the owner in one line.`;
}
