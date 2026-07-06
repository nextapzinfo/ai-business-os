const OPENAI_API_URL = "https://api.openai.com/v1/embeddings";

// `inputType` is kept in the signature (unused by OpenAI) so callers don't need
// to change if we ever swap providers again — OpenAI's model doesn't distinguish
// document vs. query embeddings the way some other providers do.
export async function embedText(
  text: string,
  _inputType: "document" | "query"
): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
      dimensions: 1024, // matches the DocumentChunk.embedding vector(1024) column
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI embedding failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  return data.data[0].embedding as number[];
}

// pgvector accepts this text form (e.g. "[0.12,0.34,...]") when cast with ::vector in raw SQL.
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
