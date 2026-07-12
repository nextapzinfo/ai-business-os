const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

type SourceChunk = { title: string; content: string };

export type AgentProfileInput = {
  businessName?: string | null;
  businessDescription?: string | null;
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
    "Reply in whichever language or style the customer used — Bengali, English, or a natural Bengali-English mix (Banglish) — matching their tone. Only use Bengali words and phrases you are certain are grammatically correct and actually mean what you intend; if you're not sure how to say something naturally in Bengali, say that part in English instead of guessing or inventing a word.",
};

function todayInIndia(): string {
  // en-CA locale formats as YYYY-MM-DD, which doubles as a clean ISO date string.
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function buildSystemPrompt(profile: AgentProfileInput | undefined, contextBlock: string, hasTools: boolean): string {
  const businessName = profile?.businessName?.trim() || "the business";
  const description = profile?.businessDescription?.trim();
  const tone = TONE_TEXT[profile?.tone ?? "friendly"] ?? TONE_TEXT.friendly;
  const language = LANGUAGE_TEXT[profile?.languageStyle ?? "mixed"] ?? LANGUAGE_TEXT.mixed;

  const toolsNote = hasTools
    ? `\n\nYou have tools available for certain actions (e.g. saving a customer's address, or setting a follow-up reminder). Use a tool naturally when the conversation calls for it — don't ask for permission first, just do it, then confirm what you did in your reply.`
    : "";

  return `You are the WhatsApp assistant for ${businessName}${description ? `, ${description}` : ""}. You answer questions from customers and staff.

Tone: be ${tone}. ${language}

Language quality matters a lot here — a wrong or made-up word looks unprofessional to a real customer. Keep sentences short and simple rather than reaching for a fancier word or phrase you're unsure of.

Today's date is ${todayInIndia()} (India, Asia/Kolkata timezone). Use this to resolve any relative dates the customer mentions (tomorrow, next Monday, in 3 days, etc.) into an exact date.

Answer factual questions ONLY using the reference material below. If the answer is not contained in the material, say clearly that you don't know and suggest they ask the business directly — never invent facts, prices, or details that aren't in the material. Always mention which source(s) (by title) you used to answer factual questions.${toolsNote}

Reference material:
${contextBlock}`;
}

// Vision.md principle: the AI must say "I don't know" rather than invent facts —
// the system prompt above enforces that explicitly.
export async function askAI(
  question: string,
  sources: SourceChunk[],
  profile?: AgentProfileInput
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const contextBlock = sources
    .map((s, i) => `[Source ${i + 1}: ${s.title}]\n${s.content}`)
    .join("\n\n---\n\n");

  const systemPrompt = buildSystemPrompt(profile, contextBlock, false);

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
        { role: "user", content: question },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI chat completion failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  return data.choices[0].message.content as string;
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

export type ToolExecutor = (name: string, args: Record<string, any>) => Promise<string>;

type ChatMessage = Record<string, any>;

async function callChat(apiKey: string, messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatMessage> {
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
  return data.choices[0].message;
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
  executeTool: ToolExecutor
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  if (tools.length === 0) {
    return askAI(question, sources, profile);
  }

  const contextBlock = sources
    .map((s, i) => `[Source ${i + 1}: ${s.title}]\n${s.content}`)
    .join("\n\n---\n\n");

  const systemPrompt = buildSystemPrompt(profile, contextBlock, true);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: question },
  ];

  const firstMessage = await callChat(apiKey, messages, tools);

  const toolCalls = firstMessage.tool_calls as
    | { id: string; function: { name: string; arguments: string } }[]
    | undefined;

  if (!toolCalls || toolCalls.length === 0) {
    return (firstMessage.content as string) ?? "";
  }

  messages.push(firstMessage);

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

  const secondMessage = await callChat(apiKey, messages, []);
  return (secondMessage.content as string) ?? "";
}
