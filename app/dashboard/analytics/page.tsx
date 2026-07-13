import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { formatDateTime } from "@/lib/formatDate";
import Link from "next/link";

export const dynamic = "force-dynamic";

// Deliberately no chart library — this is a small business's message volume,
// a plain CSS bar chart (divs sized by percentage) is all it needs and adds
// zero new dependencies. Two real, honest signals drive the "gaps" sections:
// Message.noKnowledgeMatch (RAG found nothing) and Conversation.handoffReason
// (the AI itself said it couldn't help) — no fuzzy topic-clustering, just the
// AI's own admissions, which is more trustworthy than guessing at patterns.
export default async function AnalyticsPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const [totalConversations, openConversations, closedConversations, staffHandling, activeHandoffs, recentGaps, recentMessages] =
    await Promise.all([
      prisma.conversation.count({ where: { organizationId: user.organizationId } }),
      prisma.conversation.count({ where: { organizationId: user.organizationId, status: "OPEN" } }),
      prisma.conversation.count({ where: { organizationId: user.organizationId, status: "CLOSED" } }),
      prisma.conversation.count({ where: { organizationId: user.organizationId, status: "OPEN", aiPaused: true } }),
      prisma.conversation.findMany({
        where: { organizationId: user.organizationId, handoffReason: { not: null } },
        include: { client: true, messages: { orderBy: { createdAt: "desc" }, take: 1 } },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.message.findMany({
        where: { conversation: { organizationId: user.organizationId }, noKnowledgeMatch: true },
        include: { conversation: { include: { client: true } } },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.message.findMany({
        where: {
          conversation: { organizationId: user.organizationId },
          createdAt: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) },
        },
        select: { createdAt: true },
      }),
    ]);

  const aiActive = openConversations - staffHandling;

  const dayBuckets: Record<string, number> = {};
  const days: string[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    days.push(key);
    dayBuckets[key] = 0;
  }
  for (const m of recentMessages) {
    const key = m.createdAt.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (key in dayBuckets) dayBuckets[key]++;
  }
  const maxCount = Math.max(1, ...days.map((d) => dayBuckets[d]));

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Analytics</h1>
        <p className="mt-1 text-sm text-gray-500">
          How the AI is actually performing — volume, gaps, and where it's handing off to you.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total Conversations" value={totalConversations} />
        <StatCard label="AI Active" value={aiActive} accent="text-emerald-600" />
        <StatCard label="Staff Handling" value={staffHandling} accent="text-amber-600" />
        <StatCard label="Closed" value={closedConversations} />
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Messages — last 14 days</h3>
        <div className="mt-3 flex items-end gap-1" style={{ height: 100 }}>
          {days.map((d) => (
            <div key={d} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${d}: ${dayBuckets[d]}`}>
              <div
                className="w-full rounded-t bg-primary/70"
                style={{ height: `${Math.max(2, (dayBuckets[d] / maxCount) * 90)}px` }}
              />
              <span className="text-[9px] text-gray-400">{d.slice(5)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Needs You Now ({activeHandoffs.length})</h3>
        <p className="mt-1 text-xs text-gray-500">Conversations the AI itself escalated to a human.</p>
        <div className="mt-3 flex flex-col divide-y divide-gray-100">
          {activeHandoffs.length === 0 && (
            <p className="py-3 text-xs text-gray-400">Nothing needs you right now.</p>
          )}
          {activeHandoffs.map((c) => (
            <Link
              key={c.id}
              href={`/dashboard/conversations/${c.id}`}
              className="flex items-center justify-between gap-2 py-2 hover:bg-gray-50"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-gray-800">{c.client.name}</p>
                <p className="truncate text-xs text-red-600">{c.handoffReason}</p>
              </div>
              <span className="flex-shrink-0 text-[11px] text-gray-400">
                {c.messages[0] ? formatDateTime(c.messages[0].createdAt) : ""}
              </span>
            </Link>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Questions the AI Couldn't Answer ({recentGaps.length})</h3>
        <p className="mt-1 text-xs text-gray-500">
          Zero matches in the Knowledge Base — likely gaps worth filling in. Review and add corrections on the
          Training page.
        </p>
        <div className="mt-3 flex flex-col divide-y divide-gray-100">
          {recentGaps.length === 0 && <p className="py-3 text-xs text-gray-400">No gaps recently — nice.</p>}
          {recentGaps.map((m) => (
            <Link
              key={m.id}
              href={`/dashboard/conversations/${m.conversationId}`}
              className="flex items-center justify-between gap-2 py-2 hover:bg-gray-50"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-gray-800">{m.answeredQuestion || "(question not captured)"}</p>
                <p className="truncate text-xs text-gray-400">{m.conversation.client.name}</p>
              </div>
              <span className="flex-shrink-0 text-[11px] text-gray-400">{formatDateTime(m.createdAt)}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className={`text-2xl font-semibold ${accent ?? "text-gray-900"}`}>{value}</p>
      <p className="mt-0.5 text-xs text-gray-500">{label}</p>
    </div>
  );
}
