// Simple fixed-size chunking with overlap — good enough for V1 reference text
// (GST rules, Income Tax sections). Can be swapped for smarter semantic chunking later.
export function chunkText(text: string, chunkSize = 1000, overlap = 150): string[] {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (cleaned.length === 0) return [];
  if (cleaned.length <= chunkSize) return [cleaned];

  const chunks: string[] = [];
  let start = 0;

  while (start < cleaned.length) {
    const end = Math.min(start + chunkSize, cleaned.length);
    chunks.push(cleaned.slice(start, end).trim());
    if (end === cleaned.length) break;
    start = end - overlap;
  }

  return chunks.filter((c) => c.length > 0);
}
