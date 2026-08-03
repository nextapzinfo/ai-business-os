import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { formatDateTime } from "@/lib/formatDate";
import Link from "next/link";
import { applyCorrection, dismissFlag, reviewInsight, addInsightKnowledge } from "./actions";
import TeachAIChat from "@/components/TeachAIChat";

export const dynamic = "force-dynamic";

// "AI Training Dashboard" — deliberately NOT model fine-tuning (unnecessary and
// expensive for a business this size). It's a fast review queue: flagged/gap
// replies + nightly self-review suggestions, both funneling into the same
// "Add to Knowledge Base" action so corrections actually change future answers
// through the same RAG pipeline the AI already searches.
export default async function TrainingPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const [flaggedMessages, insights] = await Promise.all([
    prisma.message.findMany({
      where: {
        conversation: { organizationId: user.organizationId },
        correctionStatus: "PENDING",
        OR: [{ flaggedWrong: true }, { noKnowledgeMatch: true }],
      },
      include: { conversation: { include: { client: true } } },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    prisma.conversationInsight.findMany({
      where: { organizationId: user.organizationId, status: "PENDING" },
      include: { conversation: { include: { client: true } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Training</h1>
        <p className="mt-1 max-w-2xl text-sm text-gray-500">
          Review AI replies that were wrong or unanswered, write the correct answer, and push it straight
          into the Knowledge Base — this is how the AI actually improves, not automatic "fine-tuning".
        </p>
      </div>

      <TeachAIChat />

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Needs a Correction ({flaggedMessages.length})</h3>
        <p className="mt-1 text-xs text-gray-500">
          Flagged by staff (👎 on a reply in Conversations) or auto-detected (zero Knowledge Base matches).
        </p>
        <div className="mt-3 flex flex-col divide-y divide-gray-100">
          {flaggedMessages.length === 0 && (
            <p className="py-3 text-xs text-gray-400">Nothing waiting for review.</p>
          )}
          {flaggedMessages.map((m) => (
            <div key={m.id} className="py-3">
              <div className="flex items-center justify-between gap-2">
                <Link href={`/dashboard/conversations/${m.conversationId}`} className="min-w-0 hover:underline">
                  <p className="truncate text-xs font-medium text-gray-500">{m.conversation.client.name}</p>
                </Link>
                <span className="flex-shrink-0 text-[11px] text-gray-400">{formatDateTime(m.createdAt)}</span>
              </div>
              <p className="mt-1 text-sm font-medium text-gray-800">
                Q: {m.answeredQuestion || "(question not captured)"}
              </p>
              <p className="mt-0.5 rounded-lg bg-red-50 px-2 py-1 text-xs text-red-700">AI said: {m.content}</p>
              <form action={applyCorrection} className="mt-2 flex flex-col gap-2">
                <input type="hidden" name="messageId" value={m.id} />
                <textarea
                  name="correctionText"
                  placeholder="What should the AI have said?"
                  required
                  rows={2}
                  className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-light"
                  >
                    Add to Knowledge Base
                  </button>
                  <button
                    type="submit"
                    formAction={dismissFlag}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-50"
                  >
                    Dismiss
                  </button>
                </div>
              </form>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">AI Self-Review ({insights.length})</h3>
        <p className="mt-1 text-xs text-gray-500">
          Nightly self-critique of closed conversations (only if enabled in Agent Studio → Skills). Just
          suggestions — nothing here is applied automatically.
        </p>
        <div className="mt-3 flex flex-col divide-y divide-gray-100">
          {insights.length === 0 && <p className="py-3 text-xs text-gray-400">No suggestions waiting.</p>}
          {insights.map((ins) => (
            <div key={ins.id} className="py-3">
              <div className="flex items-center justify-between gap-2">
                <Link href={`/dashboard/conversations/${ins.conversationId}`} className="min-w-0 hover:underline">
                  <p className="truncate text-xs font-medium text-gray-500">{ins.conversation.client.name}</p>
                </Link>
                <span className="flex-shrink-0 text-[11px] text-gray-400">{formatDateTime(ins.createdAt)}</span>
              </div>
              {ins.mistakes && (
                <p className="mt-1.5 text-xs">
                  <span className="font-medium text-gray-700">Mistakes: </span>
                  {ins.mistakes}
                </p>
              )}
              {ins.unanswered && (
                <p className="mt-1 text-xs">
                  <span className="font-medium text-gray-700">Unanswered: </span>
                  {ins.unanswered}
                </p>
              )}
              {ins.suggestedKnowledge && (
                <p className="mt-1 text-xs">
                  <span className="font-medium text-gray-700">Add to Knowledge: </span>
                  {ins.suggestedKnowledge}
                </p>
              )}
              {ins.suggestedRules && (
                <p className="mt-1 text-xs">
                  <span className="font-medium text-gray-700">Suggested rule: </span>
                  {ins.suggestedRules}
                </p>
              )}
              {!ins.mistakes && !ins.unanswered && !ins.suggestedKnowledge && !ins.suggestedRules && (
                <p className="mt-1 text-xs text-gray-400">No issues found — this one went fine.</p>
              )}
              <div className="mt-2 flex gap-2">
                {ins.suggestedKnowledge && (
                  <form action={addInsightKnowledge}>
                    <input type="hidden" name="insightId" value={ins.id} />
                    <button
                      type="submit"
                      className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-light"
                    >
                      Add Suggestion to Knowledge Base
                    </button>
                  </form>
                )}
                <form action={reviewInsight}>
                  <input type="hidden" name="insightId" value={ins.id} />
                  <button
                    type="submit"
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-50"
                  >
                    Mark Reviewed
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
