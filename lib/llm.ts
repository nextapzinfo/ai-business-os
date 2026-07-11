const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

type SourceChunk = { title: string; content: string };

export type AgentProfileInput = {
  businessName?: string | null;
  businessDescription?: string | null;
  tone?: string | null; // friendly, formal, casual
  languageStyle?: string | null; // bn, en, mixed
};

const TONE_TEXT: Record<string, string> = {
  friendly: "warm, friendly, and approachable",
  formal: "polite, professional, and formal",
  casual: "casual and conversational, like chatting with a friend",
};

const LANGUAGE_TEXT: Record<string, string> = {
  bn: "Always reply in Bengali (Bangla).",
  en: "Always reply in English.",
  mixed:
    "Reply in whichever language or style the customer used — Bengali, English, or a natural Bengali-English mix (Banglish) — matching their tone.",
};

function buildSystemPrompt(profile: AgentProfileInput | undefined, contextBlock: string): string {
  const businessName = profile?.businessName?.trim() || "the business";
  const description = profile?.businessDescription?.trim();
  const tone = TONE_TEXT[profile?.tone ?? "friendly"] ?? TONE_TEXT.friendly;
  const language = LANGUAGE_TEXT[profile?.languageStyle ?? "mixed"] ?? LANGUAGE_TEXT.mixed;

  return `You are the WhatsApp assistant for ${businessName}${description ? `, ${description}` : ""}. You answer questions from customers and staff.

Tone: be ${tone}. ${language}

Answer ONLY using the reference material below. If the answer is not contained in the material, say clearly that you don't know and suggest they ask the business directly — never invent facts, prices, or details that aren't in the material.

Always mention which source(s) (by title) you used to answer.

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

  const systemPrompt = buildSystemPrompt(profile, contextBlock);

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
