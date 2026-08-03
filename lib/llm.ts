const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

type SourceChunk = { title: string; content: string };

// Prior turns of the SAME conversation, oldest first — without this, every
// incoming message is answered in total isolation (the model never sees what
// was said before). That's what broke replies like a bare "Yes" confirming an
// order, or "50" answering "how many pieces": with no history, the model has
// nothing to resolve those against and falls back to a generic greeting.
export type ChatHistoryMessage = { role: "user" | "assistant"; content: string };

// Real token counts OpenAI returns with every response — this is what powers
// the Billing page's exact (not estimated) OpenAI cost figure.
export type TokenUsage = { promptTokens: number; completionTokens: number };
export type AiCallResult = { answer: string; usage: TokenUsage };

function extractUsage(data: any): TokenUsage {
  return {
    promptTokens: data?.usage?.prompt_tokens ?? 0,
    completionTokens: data?.usage?.completion_tokens ?? 0,
  };
}

export type AgentProfileInput = {
  businessName?: string | null;
  businessDescription?: string | null;
  coreIdentity?: string | null; // free-text persona paragraph — see buildSystemPrompt for how this overrides the default opening line
  customInstructions?: string | null;
  brandLanguage?: string | null; // JSON string: { wordsToUse, wordsToAvoid, terminology: {from,to}[] }
  tone?: string | null; // friendly, formal, casual, traditional, premium, luxury, professional, humorous
  languageStyle?: string | null; // bn, en, mixed
};

// "Brand personality" presets — lets the same underlying AI represent very
// different businesses (a traditional sweet shop vs. a luxury salon vs. a CA
// firm) just by picking a tone here, instead of hand-writing a new prompt
// for each one.
const TONE_TEXT: Record<string, string> = {
  friendly: "warm, friendly, and approachable",
  formal: "polite, respectful, and formal",
  casual: "casual and conversational, like chatting with a friend",
  traditional:
    "rooted in tradition and cultural warmth — respectful of local customs, heritage, and courteous forms of address",
  premium: "polished and premium — confident, refined, and a little exclusive, like a high-end brand",
  luxury:
    "luxurious and indulgent — elegant, exclusive, and aspirational, emphasizing quality, craftsmanship, and prestige",
  professional: "polished, businesslike, and efficient — professional and competent without being cold",
  humorous:
    "light-hearted and witty — friendly humor and playful language, while staying respectful and genuinely helpful",
};

const LANGUAGE_TEXT: Record<string, string> = {
  bn: "Always reply in Bengali (Bangla). Use natural, grammatically correct Bengali — never invent a Bengali word or phrase you're not sure is real.",
  en: "Always reply in English.",
  mixed:
    "Mirror whatever language the customer actually writes in, the same way ChatGPT does — if they write in English, reply in English; if they write in Hindi, reply in Hindi; if they write in Bengali script, reply in Bengali script; and so on for any other language. Don't default to Bengali just because the business is Bengali. The one special case: if the customer writes Banglish (Bengali words spelled out in English/Roman letters, e.g. 'ghee kamon hobe'), reply in proper Bengali script (বাংলা), not in Roman letters — never reply in Banglish yourself. You can naturally keep English brand/product names mixed into a reply in any language. Only use words and phrases in a language you are certain are grammatically correct and actually mean what you intend; if you're not sure how to say something naturally in a given language, say that part in English instead of guessing or inventing a word.",
};

// Turns the owner's structured word-swap/vocabulary settings into a short
// instruction block. Stored as a JSON string so the Agent Studio UI can offer
// a friendly table instead of a free-text box; parsing failures are swallowed
// so a malformed value never breaks the whole reply.
function buildBrandLanguageNote(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as {
      wordsToUse?: string[];
      wordsToAvoid?: string[];
      terminology?: { from: string; to: string }[];
    };

    const lines: string[] = [];

    const wordsToUse = (parsed.wordsToUse ?? []).filter((w) => w?.trim());
    if (wordsToUse.length > 0) {
      lines.push(`Prefer these words/phrases where natural: ${wordsToUse.join(", ")}.`);
    }

    const wordsToAvoid = (parsed.wordsToAvoid ?? []).filter((w) => w?.trim());
    if (wordsToAvoid.length > 0) {
      lines.push(`Never use these generic words/phrases: ${wordsToAvoid.join(", ")}.`);
    }

    const terminology = (parsed.terminology ?? []).filter((t) => t?.from?.trim() && t?.to?.trim());
    if (terminology.length > 0) {
      const rules = terminology.map((t) => `Never say "${t.from}" — always say "${t.to}" instead.`).join(" ");
      lines.push(rules);
    }

    if (lines.length === 0) return "";

    return `\n\nBrand language — this business has its own vocabulary, use it exactly as given below instead of generic terms. This matters a lot for sounding like a real member of the team rather than a generic assistant:\n${lines.join(
      "\n"
    )}`;
  } catch {
    return "";
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Prompt instructions ("never say X, always say Y") are a strong hint to the
// model, not a guarantee — with several swap rules plus tone/language/custom
// instructions all competing for the model's attention, an occasional miss is
// normal, especially on a smaller model like gpt-4o-mini. This runs AFTER the
// model replies, doing a real find-and-replace on the exact terminology pairs
// from Brand Language — so a swap like "পণ্য" → "মিষ্টি" is 100% guaranteed in
// what the customer actually receives, regardless of what the model wrote.
// Case-insensitive, whole-string substring match (no stemming/pluralization —
// "Products" won't match a "Product" rule); applied in the order the owner
// listed the pairs, so a later rule can re-match an earlier rule's output.
export function applyTerminologySwaps(text: string, brandLanguageRaw: string | null | undefined): string {
  if (!text || !brandLanguageRaw) return text;
  try {
    const parsed = JSON.parse(brandLanguageRaw) as { terminology?: { from: string; to: string }[] };
    const pairs = (parsed.terminology ?? []).filter((t) => t?.from?.trim() && t?.to?.trim());
    if (pairs.length === 0) return text;

    let result = text;
    for (const { from, to } of pairs) {
      const fromTrimmed = from.trim();
      const toTrimmed = to.trim();
      if (fromTrimmed.toLowerCase() === toTrimmed.toLowerCase()) continue; // no-op rule

      // A rule like "kheer doi" → "laal kheer doi" must NOT turn an already-
      // correct "Laal Kheer Doi" into "Laal laal kheer doi" — "kheer doi" is a
      // real substring of the correct output too. Find every span where the
      // TARGET text already occurs first, and skip any `from` match that
      // falls inside one of those spans — only replace genuinely bare,
      // not-yet-fixed occurrences.
      const toRegex = new RegExp(escapeRegExp(toTrimmed), "gi");
      const protectedRanges: [number, number][] = [];
      let m: RegExpExecArray | null;
      while ((m = toRegex.exec(result))) {
        protectedRanges.push([m.index, m.index + m[0].length]);
      }

      const fromRegex = new RegExp(escapeRegExp(fromTrimmed), "gi");
      result = result.replace(fromRegex, (match, offset) => {
        const isAlreadyCorrect = protectedRanges.some(([start, end]) => offset >= start && offset < end);
        return isAlreadyCorrect ? match : toTrimmed;
      });
    }
    return result;
  } catch {
    return text; // malformed JSON — leave the reply untouched rather than break it
  }
}

function todayInIndia(): string {
  // en-CA locale formats as YYYY-MM-DD, which doubles as a clean ISO date string.
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function buildSystemPrompt(
  profile: AgentProfileInput | undefined,
  contextBlock: string,
  hasTools: boolean,
  photoNote: string = ""
): string {
  const businessName = profile?.businessName?.trim() || "the business";
  const description = profile?.businessDescription?.trim();
  const coreIdentity = profile?.coreIdentity?.trim();
  const tone = TONE_TEXT[profile?.tone ?? "friendly"] ?? TONE_TEXT.friendly;
  const language = LANGUAGE_TEXT[profile?.languageStyle ?? "mixed"] ?? LANGUAGE_TEXT.mixed;
  const customInstructions = profile?.customInstructions?.trim();
  const brandLanguageNote = buildBrandLanguageNote(profile?.brandLanguage);

  const toolsNote = hasTools
    ? `\n\nYou have tools available for certain actions (e.g. saving a customer's address, or setting a follow-up reminder). Use a tool naturally when the conversation calls for it — don't ask for permission first, just do it, then confirm what you did in your reply.`
    : "";

  const customInstructionsNote = customInstructions
    ? `\n\nAdditional rules from the business owner — always follow these:\n${customInstructions}`
    : "";

  const photoInstructionNote = photoNote ? `\n\n${photoNote}` : "";

  // Core AI Identity (set in Agent Studio → Profile, top of the page) is a
  // free-text persona/voice/judgment paragraph the owner writes themselves.
  // When present it REPLACES this default one-liner as the opening frame —
  // a rich, coherent identity paragraph shapes tone and judgment far more
  // consistently than a pile of separate small rules ever can. A short
  // technical anchor line is still appended so the model always knows it's
  // actually the WhatsApp assistant for this specific business.
  const openingLine = coreIdentity
    ? `${coreIdentity}\n\nYou represent ${businessName} on WhatsApp${
        description ? ` (${description})` : ""
      } and answer questions from customers and staff.`
    : `You are the WhatsApp assistant for ${businessName}${description ? `, ${description}` : ""}. You answer questions from customers and staff.`;

  return `${openingLine}

Tone: be ${tone}. ${language}

Language quality matters a lot here — a wrong or made-up word, or an awkward/ungrammatical sentence, looks unprofessional to a real customer. Keep sentences short and simple rather than reaching for a fancier word or phrase you're unsure of. When writing in Bengali specifically, use natural verb conjugation and word order — never construct a sentence by translating English word-for-word; if a sentence would come out sounding unnatural or grammatically off, simplify it rather than sending it as-is.

Write like a real, attentive member of the team — natural and warm, never stiff or robotic, and don't narrate that you're following instructions. If a customer directly and sincerely asks whether they're chatting with a bot/AI or a human, answer honestly — don't deny it or lie about it.

Formatting rules — this is WhatsApp, not a document. WhatsApp does NOT render Markdown headers or list syntax — if you write "###" or "##" it shows up as literal hash symbols, and a leading "- " shows up as a literal dash. NEVER use "#", "##", "###", or a leading "-" or "*" for list items. For emphasis use single asterisks like *this* (WhatsApp renders that as bold) — never double asterisks. When listing multiple products or items, put each one on its own line and use the bullet character "•" (not a hyphen) if you need a marker, e.g.:
*SORBHAJA* — 5 pcs — ₹250
*Laal Kheer Doi* — 500 gm — ₹300
Keep it looking like a real WhatsApp message a person would type, not a formatted report.

Today's date is ${todayInIndia()} (India, Asia/Kolkata timezone). Use this to resolve any relative dates the customer mentions (tomorrow, next Monday, in 3 days, etc.) into an exact date.

Answer factual questions ONLY using the reference material below. If the answer is not contained in the material, say clearly that you don't know and suggest they ask the business directly — never invent facts, prices, or details that aren't in the material. Always mention which source(s) (by title) you used to answer factual questions.${toolsNote}${customInstructionsNote}${brandLanguageNote}${photoInstructionNote}

Reference material:
${contextBlock}`;
}

// Vision.md principle: the AI must say "I don't know" rather than invent facts —
// the system prompt above enforces that explicitly.
export async function askAI(
  question: string,
  sources: SourceChunk[],
  profile?: AgentProfileInput,
  history: ChatHistoryMessage[] = [],
  photoNote: string = ""
): Promise<AiCallResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const contextBlock = sources
    .map((s, i) => `[Source ${i + 1}: ${s.title}]\n${s.content}`)
    .join("\n\n---\n\n");

  const systemPrompt = buildSystemPrompt(profile, contextBlock, false, photoNote);

  const res = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: question },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI chat completion failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  return { answer: (data.choices[0].message.content as string) ?? "", usage: extractUsage(data) };
}

// ---- Function calling (agentic skills) ----
// Lets the AI take real actions mid-conversation (save an address, set a
// reminder) instead of only answering questions. The caller supplies which
// tools are currently enabled and an `executeTool` callback that actually
// performs the action (writing to the real database on WhatsApp, or just
// simulating the result in the Test Sandbox).

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
};

export const SAVE_ADDRESS_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "save_customer_address",
    description:
      "Save or update the customer's delivery/home address on file. Use this whenever the customer shares their address, even a partial one.",
    parameters: {
      type: "object",
      properties: {
        address: { type: "string", description: "The customer's full address, as they gave it." },
      },
      required: ["address"],
    },
  },
};

export const SET_REMINDER_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "set_reminder",
    description:
      "Create a follow-up reminder for staff about this customer, due on a specific date. Use this when the customer asks to be reminded, followed up with, or contacted again about something.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short description of what to follow up about." },
        dueDate: {
          type: "string",
          description: "The follow-up date in YYYY-MM-DD format, resolved from today's date.",
        },
      },
      required: ["title", "dueDate"],
    },
  },
};

export const RECORD_INTEREST_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "record_product_interest",
    description:
      "Note that this customer is interested in a specific product from the catalog, so staff can follow up later. Use this when the customer asks about, praises, or seems interested in buying a particular product.",
    parameters: {
      type: "object",
      properties: {
        productName: {
          type: "string",
          description: "The product name, as close as possible to how it's listed in the catalog.",
        },
        note: {
          type: "string",
          description: "Optional short context, e.g. 'asked about bulk pricing' or 'wants it for a wedding'.",
        },
      },
      required: ["productName"],
    },
  },
};

export const PLACE_ORDER_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "record_order",
    description:
      "Record a new order for the customer. Only use this AFTER you've read the items/quantities back to the customer and they've confirmed it's correct — don't call this on the first mention of wanting to buy something, and don't call it more than once for the same order.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "string",
          description: "The confirmed items and quantities, as a short readable list, e.g. '2kg Mishti Doi, 1kg Ghee'.",
        },
        deliveryAddress: {
          type: "string",
          description: "Delivery address, only if the customer wants delivery. Leave out if they're picking up in-store.",
        },
        note: {
          type: "string",
          description: "Any other instruction from the customer, e.g. preferred delivery time.",
        },
      },
      required: ["items"],
    },
  },
};

// Always included, regardless of Agent Studio skill toggles — unlike the other
// tools this isn't an opt-in "feature", it's a safety net every business wants:
// when the AI genuinely can't help, it should say so and step aside rather than
// loop or bluff. See webhook route.ts / test route.ts where `tools` is built.
export const REQUEST_HANDOFF_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "request_human_handoff",
    description:
      "Use this when you genuinely cannot help the customer — you don't know the answer even after checking the knowledge base, the customer explicitly asks to speak to a real person/staff/owner, or the customer seems frustrated or upset with automated replies. This pauses your automatic replies so a staff member can take over personally. Don't overuse it — only call this when a human is genuinely needed, not for every question you're unsure about; try your best to help first.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "Brief reason for the handoff so staff know what's needed, e.g. 'Customer wants a refund for a damaged order' or 'Customer explicitly asked to speak to a human'.",
        },
      },
      required: ["reason"],
    },
  },
};

// Always included, same as REQUEST_HANDOFF_TOOL — product photo sharing isn't
// gated by a Skills toggle. This exists because the OLD photo logic only ever
// looked at the CURRENT message's RAG match: a direct "Sorbhaja ache?" matched
// fine, but a context-dependent follow-up like "pic ache?" (no product name
// repeated) scored too weak a match on its own, so no photo was attached —
// even though the model's TEXT reply correctly remembered "Sorbhaja" from
// history. Giving the model an explicit tool lets its own already-working
// context resolution drive the actual send, instead of a second, context-blind
// lookup. See webhook route.ts / test route.ts for how `tools` is built.
export const SEND_PRODUCT_PHOTO_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "send_product_photo",
    description:
      "Send a photo of a specific product to the customer on WhatsApp. Use this whenever the customer asks to see a photo/picture of a product — including when they're asking about a product mentioned earlier in the conversation, not just repeated in their latest message. You DO have this capability; never claim you're unable to share photos or image links — if no photo happens to be saved for that product, the tool result will tell you, and you can say so honestly then.",
    parameters: {
      type: "object",
      properties: {
        productName: {
          type: "string",
          description:
            "The exact product name being asked about, as close as possible to how it's listed in the catalog — resolve this from conversation context if the customer's latest message didn't repeat the product name.",
        },
      },
      required: ["productName"],
    },
  },
};

// ---- Teach AI chat (Agent Studio / Training page) ----
// Lets the business owner update the AI's knowledge conversationally instead
// of filling out forms — "Sorbhaja er dam ekhon 260" should just work, the
// same way chatting with Meta's own built-in Business Agent does. See
// app/api/agent/teach/route.ts for how these are wired to real DB writes.
export const UPDATE_PRODUCT_INFO_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "update_product_info",
    description:
      "Update an EXISTING product's price and/or description when the owner tells you new or corrected information about it. Only use this when you're confident which product they mean — match by name as closely as possible. If it's unclear which product they're referring to, or if this sounds like a brand-new fact rather than a correction to a specific product, do NOT call this — ask a clarifying question in your reply instead, or use add_knowledge_note.",
    parameters: {
      type: "object",
      properties: {
        productName: {
          type: "string",
          description: "The product's name, as close as possible to how the owner referred to it.",
        },
        newPrice: {
          type: "string",
          description: "The corrected price, only if the owner mentioned a price change.",
        },
        newDescription: {
          type: "string",
          description: "The corrected/updated description, only if the owner mentioned a description change.",
        },
      },
      required: ["productName"],
    },
  },
};

export const ADD_KNOWLEDGE_NOTE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "add_knowledge_note",
    description:
      "Save a new fact, policy, or piece of information the owner just told you, when it is NOT a correction to a specific existing product's price/description. This becomes permanent knowledge the AI uses when answering customers — e.g. store hours, delivery policy, a new offer, or an answer to a common question.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "A short label for this fact, e.g. 'Weekend closure' or 'COD policy'.",
        },
        content: {
          type: "string",
          description: "The fact/policy itself, written out in full — this is what the AI will read later.",
        },
      },
      required: ["title", "content"],
    },
  },
};

// Distinct from askAIWithTools's buildSystemPrompt: that one frames the model
// as a customer-facing WhatsApp assistant, which is the wrong persona for this
// internal owner-only chat. This system prompt is intentionally small and
// direct — the owner is teaching, not being sold to.
export async function askTeachAI(
  message: string,
  history: ChatHistoryMessage[],
  tools: ToolDefinition[],
  executeTool: ToolExecutor
): Promise<AiCallResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const systemPrompt = `You are helping a small business owner update their WhatsApp AI assistant's knowledge, by chatting naturally with them in whatever mix of Bengali/English they use — reply in kind. They will tell you things like a price change, a new policy, or a general fact to remember.

When they correct an existing product (price or description), use update_product_info. When they tell you a new fact/policy that isn't about one specific existing product, use add_knowledge_note. If you're not confident what they mean, ask a short clarifying question instead of guessing or calling a tool.

After a tool call succeeds, confirm briefly and plainly what you saved/updated — don't repeat the full content back at length, just enough for the owner to trust it was understood correctly. Keep replies short — this is a quick back-and-forth, not a report.`;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: message },
  ];

  const first = await callChat(apiKey, messages, tools);
  let promptTokens = first.usage.promptTokens;
  let completionTokens = first.usage.completionTokens;

  const toolCalls = first.message.tool_calls as
    | { id: string; function: { name: string; arguments: string } }[]
    | undefined;

  if (!toolCalls || toolCalls.length === 0) {
    return { answer: (first.message.content as string) ?? "", usage: { promptTokens, completionTokens } };
  }

  messages.push(first.message);

  for (const call of toolCalls) {
    let args: Record<string, any> = {};
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      // malformed JSON from the model — leave args empty, executeTool can reject it
    }

    let resultText: string;
    try {
      resultText = await executeTool(call.function.name, args);
    } catch (err) {
      resultText = `Failed: ${(err as Error).message}`;
    }

    messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
  }

  const second = await callChat(apiKey, messages, []);
  promptTokens += second.usage.promptTokens;
  completionTokens += second.usage.completionTokens;

  return { answer: (second.message.content as string) ?? "", usage: { promptTokens, completionTokens } };
}

export type ToolExecutor = (name: string, args: Record<string, any>) => Promise<string>;

type ChatMessage = Record<string, any>;

async function callChat(
  apiKey: string,
  messages: ChatMessage[],
  tools: ToolDefinition[]
): Promise<{ message: ChatMessage; usage: TokenUsage }> {
  const res = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 1024,
      messages,
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI chat completion failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  return { message: data.choices[0].message, usage: extractUsage(data) };
}

// Same idea as askAI, but with tools the model can call. Runs up to two
// completion calls: the first may return tool_calls instead of (or alongside)
// text; each tool call is executed via `executeTool`, and a second call turns
// the tool results into a normal reply the customer actually sees.
export async function askAIWithTools(
  question: string,
  sources: SourceChunk[],
  profile: AgentProfileInput | undefined,
  tools: ToolDefinition[],
  executeTool: ToolExecutor,
  history: ChatHistoryMessage[] = [],
  photoNote: string = ""
): Promise<AiCallResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  if (tools.length === 0) {
    return askAI(question, sources, profile, history, photoNote);
  }

  const contextBlock = sources
    .map((s, i) => `[Source ${i + 1}: ${s.title}]\n${s.content}`)
    .join("\n\n---\n\n");

  const systemPrompt = buildSystemPrompt(profile, contextBlock, true, photoNote);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: question },
  ];

  const first = await callChat(apiKey, messages, tools);
  let promptTokens = first.usage.promptTokens;
  let completionTokens = first.usage.completionTokens;

  const toolCalls = first.message.tool_calls as
    | { id: string; function: { name: string; arguments: string } }[]
    | undefined;

  if (!toolCalls || toolCalls.length === 0) {
    return { answer: (first.message.content as string) ?? "", usage: { promptTokens, completionTokens } };
  }

  messages.push(first.message);

  for (const call of toolCalls) {
    let args: Record<string, any> = {};
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      // malformed JSON from the model — leave args empty, executeTool can reject it
    }

    let resultText: string;
    try {
      resultText = await executeTool(call.function.name, args);
    } catch (err) {
      resultText = `Failed: ${(err as Error).message}`;
    }

    messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
  }

  // Second call has no tools available — it just turns the tool result(s)
  // into the actual reply text. Usage from BOTH calls counts toward real cost.
  const second = await callChat(apiKey, messages, []);
  promptTokens += second.usage.promptTokens;
  completionTokens += second.usage.completionTokens;

  return { answer: (second.message.content as string) ?? "", usage: { promptTokens, completionTokens } };
}

// ---- Self-analysis (nightly batch, see /api/cron/self-analysis) ----
// The AI reviews a transcript of its OWN closed conversation and self-critiques.
// This is intentionally NOT run per-chat (that's an extra OpenAI call every
// single conversation) — it's a once-daily batch job the owner opts into.
// Output is always just a suggestion for the owner to review on the Training
// Dashboard; nothing here writes to the Knowledge Base or Custom Instructions
// on its own.
export type ConversationInsightResult = {
  mistakes: string;
  unanswered: string;
  suggestedKnowledge: string;
  suggestedRules: string;
};

export type ConversationInsightCallResult = { result: ConversationInsightResult | null; usage: TokenUsage };

export async function analyzeConversationForInsights(
  transcript: { sender: string; content: string }[],
  businessName?: string | null
): Promise<ConversationInsightCallResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  if (transcript.length === 0) return { result: null, usage: { promptTokens: 0, completionTokens: 0 } };

  const transcriptText = transcript
    .map((m) => `${m.sender}: ${m.content}`)
    .join("\n");

  const systemPrompt = `You are reviewing your OWN past conversation as the WhatsApp AI assistant for ${
    businessName?.trim() || "this business"
  }, to honestly self-critique your performance. Be specific and concrete — vague generic feedback isn't useful. If you genuinely did fine and there's nothing meaningful to flag, say so plainly in each field rather than inventing a problem.

Respond ONLY with a JSON object with exactly these four string fields (empty string "" if nothing applies to that field):
{
  "mistakes": "Specific mistakes you made in this conversation, if any (wrong info, bad tone, missed context, repeated itself, etc.)",
  "unanswered": "Specific questions from the customer you couldn't answer or answered poorly",
  "suggestedKnowledge": "Specific facts/info that should be added to the Knowledge Base to answer this better next time",
  "suggestedRules": "A specific new Custom Instruction rule that would have helped in this conversation, if any"
}`;

  const res = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 600,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Transcript:\n${transcriptText}` },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI self-analysis call failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const usage = extractUsage(data);
  const raw = data.choices[0].message.content as string;

  try {
    const parsed = JSON.parse(raw);
    return {
      result: {
        mistakes: (parsed.mistakes ?? "").toString().trim(),
        unanswered: (parsed.unanswered ?? "").toString().trim(),
        suggestedKnowledge: (parsed.suggestedKnowledge ?? "").toString().trim(),
        suggestedRules: (parsed.suggestedRules ?? "").toString().trim(),
      },
      usage,
    };
  } catch {
    return { result: null, usage }; // malformed JSON from the model — skip this conversation, cron continues to the next
  }
}
