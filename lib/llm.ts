const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

type SourceChunk = { title: string; content: string };

// Vision.md principle: the AI must say "I don't know" rather than invent facts —
// the system prompt below enforces that explicitly.
export async function askAI(question: string, sources: SourceChunk[]): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const contextBlock = sources
    .map((s, i) => `[Source ${i + 1}: ${s.title}]\n${s.content}`)
    .join("\n\n---\n\n");

  const systemPrompt = `You are a knowledgeable assistant for a Tax/Law firm, answering questions for the firm's clients or staff.

Answer ONLY using the reference material below. If the answer is not contained in the material, say clearly that you don't know and suggest they ask the firm directly — never invent facts or guess at figures, dates, or rules.

Always mention which source(s) (by title) you used to answer.

Reference material:
${contextBlock}`;

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
