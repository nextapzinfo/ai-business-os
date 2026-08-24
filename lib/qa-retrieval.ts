import { prisma } from "@/lib/prisma";

// Real incident (2026-08-24) — root cause of "after training session,
// customer ask Ai but Training part just ignore by Ai": the owner trained a
// Q&A pair via Teach AI ("আপনাদের কী কী আছে?" → mentions Janmashtami Special
// items) and confirmed it worked when tested with that exact phrasing — but
// a real customer's natural paraphrase ("May I know about ur misti") got a
// generic, untrained-sounding reply instead. Confirmed directly in the Test
// Sandbox: identical retrieval query, same saved Q&A — the exact trained
// question surfaced it correctly, the paraphrase didn't.
//
// Root cause: both the live webhook and the Test Sandbox do a single plain
// top-5 nearest-neighbor search across EVERY DocumentChunk the org has (see
// the main query in each route). A Trained Q&A is just one chunk among
// however many Product/Knowledge documents exist — as that corpus grows,
// ordinary product-description chunks (which legitimately contain
// sweets/misti-type language too) can easily out-rank a Q&A chunk in raw
// cosine similarity for a short, generically-worded, possibly
// different-language customer message, even when the Q&A is conceptually
// the best answer. LIMIT 5 with no floor means a Q&A chunk that's the 6th
// (or 20th) closest match never reaches the model at all — the "several
// realistic phrasings, nearest-neighbor over the whole block's meaning"
// design promise only actually holds while the corpus is small.
//
// Fix: a SEPARATE nearest-neighbor search scoped to ONLY Trained Q&A
// documents (Document.fileUrl === "teach-ai-qa", the exact marker
// add_qa_pair's handler in app/api/agent/teach/route.ts sets). This
// guarantees the single best-matching Q&A gets a chance to reach the model
// whenever it's even a plausible match — not only when it happens to beat
// every other document in the org outright. QA_DISTANCE_THRESHOLD is
// deliberately looser than the 0.35 threshold used elsewhere for
// auto-sending a product photo: that's "confident enough to act on
// automatically", this is "plausible enough to show the model, which then
// judges relevance itself" (the model already only answers from what's in
// the reference material — a merely-plausible-but-wrong QA chunk in that
// mix costs nothing, it just won't get used).
const QA_DISTANCE_THRESHOLD = 0.55;

export type BoostedQAChunk = {
  content: string;
  documentTitle: string;
  documentId: string;
  distance: number;
};

export async function fetchBoostedQAChunk(
  organizationId: string,
  vectorLiteral: string
): Promise<BoostedQAChunk | null> {
  const rows = (await prisma.$queryRaw`
    SELECT dc.content as content, d.title as "documentTitle", d.id as "documentId",
           (dc.embedding <=> ${vectorLiteral}::vector) as distance
    FROM "DocumentChunk" dc
    JOIN "Document" d ON d.id = dc."documentId"
    WHERE dc."organizationId" = ${organizationId} AND d."fileUrl" = 'teach-ai-qa'
    ORDER BY dc.embedding <=> ${vectorLiteral}::vector ASC
    LIMIT 1
  `) as BoostedQAChunk[];

  const best = rows[0];
  if (!best || best.distance > QA_DISTANCE_THRESHOLD) return null;
  return best;
}
