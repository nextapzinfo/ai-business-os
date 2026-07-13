import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { resolveDailyRange, istDayKey, lastNMonthKeys, monthRangeBounds } from "@/lib/billingRange";
import { formatInr } from "@/lib/formatCurrency";
import DateRangeFilter from "./DateRangeFilter";
import RateSettingsForm from "./RateSettingsForm";
import PrintButton from "./PrintButton";

export const dynamic = "force-dynamic";

type CostBucket = { openai: number; template: number; conversation: number };

function emptyBucket(): CostBucket {
  return { openai: 0, template: 0, conversation: 0 };
}

// Deliberately no product-wise breakdown (explicitly out of scope) and no
// Total Orders/Total Sales cards — Order has no money field yet, that's a
// separate future addition. This page only answers one question: what is
// the AI Employee actually costing, day by day and month by month, in INR.
export default async function BillingPage({
  searchParams,
}: {
  searchParams: { range?: string; from?: string; to?: string };
}) {
  const user = await getCurrentUser();
  if (!user) return null;

  const org = await prisma.organization.findUnique({ where: { id: user.organizationId } });
  if (!org) return null;

  const daily = resolveDailyRange(searchParams);
  const monthKeys = lastNMonthKeys(6);
  const monthBounds = monthRangeBounds(monthKeys);

  const [dailyAiLogs, dailyWaLogs, monthlyAiLogs, monthlyWaLogs] = await Promise.all([
    prisma.aiUsageLog.findMany({
      where: { organizationId: user.organizationId, createdAt: { gte: daily.from, lt: daily.to } },
      select: { costUsd: true, createdAt: true },
    }),
    prisma.whatsAppCostLog.findMany({
      where: { organizationId: user.organizationId, createdAt: { gte: daily.from, lt: daily.to } },
      select: { costUsd: true, kind: true, createdAt: true },
    }),
    prisma.aiUsageLog.findMany({
      where: { organizationId: user.organizationId, createdAt: { gte: monthBounds.from, lt: monthBounds.to } },
      select: { costUsd: true, createdAt: true },
    }),
    prisma.whatsAppCostLog.findMany({
      where: { organizationId: user.organizationId, createdAt: { gte: monthBounds.from, lt: monthBounds.to } },
      select: { costUsd: true, kind: true, createdAt: true },
    }),
  ]);

  const dayBuckets: Record<string, CostBucket> = {};
  for (const key of daily.dayKeys) dayBuckets[key] = emptyBucket();
  for (const log of dailyAiLogs) {
    const key = istDayKey(log.createdAt);
    if (dayBuckets[key]) dayBuckets[key].openai += log.costUsd;
  }
  for (const log of dailyWaLogs) {
    const key = istDayKey(log.createdAt);
    if (!dayBuckets[key]) continue;
    if (log.kind === "CONVERSATION") dayBuckets[key].conversation += log.costUsd;
    else dayBuckets[key].template += log.costUsd;
  }

  const dailyRows = [...daily.dayKeys].reverse().map((key) => {
    const b = dayBuckets[key];
    return { key, ...b, total: b.openai + b.template + b.conversation };
  });

  const rangeTotals = dailyRows.reduce(
    (acc, r) => ({
      openai: acc.openai + r.openai,
      template: acc.template + r.template,
      conversation: acc.conversation + r.conversation,
      total: acc.total + r.total,
    }),
    { openai: 0, template: 0, conversation: 0, total: 0 }
  );

  const monthBuckets: Record<string, CostBucket> = {};
  for (const key of monthKeys) monthBuckets[key] = emptyBucket();
  for (const log of monthlyAiLogs) {
    const key = istDayKey(log.createdAt).slice(0, 7);
    if (monthBuckets[key]) monthBuckets[key].openai += log.costUsd;
  }
  for (const log of monthlyWaLogs) {
    const key = istDayKey(log.createdAt).slice(0, 7);
    if (!monthBuckets[key]) continue;
    if (log.kind === "CONVERSATION") monthBuckets[key].conversation += log.costUsd;
    else monthBuckets[key].template += log.costUsd;
  }
  const monthlyRows = [...monthKeys].reverse().map((key) => {
    const b = monthBuckets[key];
    return { key, ...b, total: b.openai + b.template + b.conversation };
  });

  const rate = org.usdToInrRate;
  const maxDailyTotal = Math.max(0.0001, ...dailyRows.map((r) => r.total));
  const maxMonthlyTotal = Math.max(0.0001, ...monthlyRows.map((r) => r.total));
  const exportQuery = `range=${searchParams.range || "today"}&from=${searchParams.from || ""}&to=${searchParams.to || ""}`;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div className="flex flex-wrap items-start justify-between gap-2 print:hidden">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Billing</h1>
          <p className="mt-1 text-sm text-gray-500">
            What the AI Employee is actually costing — OpenAI + WhatsApp, in INR.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/billing/export?${exportQuery}`}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            Export CSV
          </a>
          <PrintButton />
        </div>
      </div>

      <div className="print:hidden">
        <DateRangeFilter currentRange={searchParams.range || "today"} from={searchParams.from} to={searchParams.to} />
      </div>

      <p className="hidden text-xs text-gray-500 print:block">
        Range: {daily.label} — printed {new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard
          label="OpenAI API Cost"
          value={formatInr(rangeTotals.openai * rate)}
          note="Exact — real token usage × published rate"
        />
        <KpiCard
          label="WhatsApp Template Cost"
          value={formatInr(rangeTotals.template * rate)}
          note="Estimate — your configured per-message rate"
        />
        <KpiCard
          label="WhatsApp Conversation Cost"
          value={formatInr(rangeTotals.conversation * rate)}
          note="Always ₹0 — Meta ended per-conversation billing (Jul 2025); free replies inside the 24h window are free"
        />
        <KpiCard
          label="Total AI Cost"
          value={formatInr(rangeTotals.total * rate)}
          accent="text-primary"
          note={`For: ${daily.label}`}
        />
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Daily AI Cost Trend ({daily.label})</h3>
        <div className="mt-3 flex items-end gap-1 overflow-x-auto" style={{ height: 100 }}>
          {[...dailyRows].reverse().map((r) => (
            <div
              key={r.key}
              className="flex min-w-[10px] flex-1 flex-col items-center justify-end gap-1"
              title={`${r.key}: ${formatInr(r.total * rate)}`}
            >
              <div
                className="w-full rounded-t bg-primary/70"
                style={{ height: `${Math.max(2, (r.total / maxDailyTotal) * 90)}px` }}
              />
              <span className="text-[9px] text-gray-400">{r.key.slice(5)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-100 p-3">
          <h3 className="text-sm font-semibold text-gray-900">Daily Summary</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-gray-100 text-[11px] text-gray-500">
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">OpenAI Cost</th>
                <th className="px-3 py-2 font-medium">WhatsApp Template</th>
                <th className="px-3 py-2 font-medium">WhatsApp Conversation</th>
                <th className="px-3 py-2 font-medium">Total AI Cost</th>
              </tr>
            </thead>
            <tbody>
              {dailyRows.map((r) => (
                <tr key={r.key} className="border-b border-gray-50 last:border-0">
                  <td className="px-3 py-2 text-gray-700">{r.key}</td>
                  <td className="px-3 py-2 text-gray-600">{formatInr(r.openai * rate)}</td>
                  <td className="px-3 py-2 text-gray-600">{formatInr(r.template * rate)}</td>
                  <td className="px-3 py-2 text-gray-600">{formatInr(r.conversation * rate)}</td>
                  <td className="px-3 py-2 font-medium text-gray-900">{formatInr(r.total * rate)}</td>
                </tr>
              ))}
              <tr className="bg-gray-50">
                <td className="px-3 py-2 font-semibold text-gray-900">Total</td>
                <td className="px-3 py-2 font-semibold text-gray-900">{formatInr(rangeTotals.openai * rate)}</td>
                <td className="px-3 py-2 font-semibold text-gray-900">{formatInr(rangeTotals.template * rate)}</td>
                <td className="px-3 py-2 font-semibold text-gray-900">{formatInr(rangeTotals.conversation * rate)}</td>
                <td className="px-3 py-2 font-semibold text-gray-900">{formatInr(rangeTotals.total * rate)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Monthly AI Cost Trend (last 6 months)</h3>
        <div className="mt-3 flex items-end gap-2" style={{ height: 100 }}>
          {[...monthlyRows].reverse().map((r) => (
            <div
              key={r.key}
              className="flex flex-1 flex-col items-center justify-end gap-1"
              title={`${r.key}: ${formatInr(r.total * rate)}`}
            >
              <div
                className="w-full rounded-t bg-accent/70"
                style={{ height: `${Math.max(2, (r.total / maxMonthlyTotal) * 90)}px` }}
              />
              <span className="text-[9px] text-gray-400">{r.key}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-100 p-3">
          <h3 className="text-sm font-semibold text-gray-900">Monthly Summary</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-gray-100 text-[11px] text-gray-500">
                <th className="px-3 py-2 font-medium">Month</th>
                <th className="px-3 py-2 font-medium">OpenAI Cost</th>
                <th className="px-3 py-2 font-medium">WhatsApp Template</th>
                <th className="px-3 py-2 font-medium">WhatsApp Conversation</th>
                <th className="px-3 py-2 font-medium">Total AI Cost</th>
              </tr>
            </thead>
            <tbody>
              {monthlyRows.map((r) => (
                <tr key={r.key} className="border-b border-gray-50 last:border-0">
                  <td className="px-3 py-2 text-gray-700">{r.key}</td>
                  <td className="px-3 py-2 text-gray-600">{formatInr(r.openai * rate)}</td>
                  <td className="px-3 py-2 text-gray-600">{formatInr(r.template * rate)}</td>
                  <td className="px-3 py-2 text-gray-600">{formatInr(r.conversation * rate)}</td>
                  <td className="px-3 py-2 font-medium text-gray-900">{formatInr(r.total * rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="print:hidden">
        <RateSettingsForm
          usdToInrRate={org.usdToInrRate}
          costPerMarketingMsg={org.costPerMarketingMsg}
          costPerUtilityMsg={org.costPerUtilityMsg}
          costPerAuthMsg={org.costPerAuthMsg}
          costPerConversation={org.costPerConversation}
        />
      </div>
    </div>
  );
}

function KpiCard({ label, value, accent, note }: { label: string; value: string; accent?: string; note?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className={`text-xl font-semibold ${accent ?? "text-gray-900"}`}>{value}</p>
      <p className="mt-0.5 text-xs text-gray-500">{label}</p>
      {note && <p className="mt-1 text-[10px] leading-tight text-gray-400">{note}</p>}
    </div>
  );
}
