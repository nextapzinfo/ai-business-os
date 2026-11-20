import { getCurrentUser } from "@/lib/getCurrentUser";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  addDays,
  istToday,
  rupees,
  salesReport,
  targetProgress,
  setTarget,
  syncBizRange,
  eventPerformance,
  bmsSyncConfigured,
} from "@/lib/biz-analyst";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Business Analyst (2026-11-20) — owner-only. Numbers come from the nightly
// copy of Banglar Doi OS (see lib/biz-analyst.ts); the same analyst answers
// questions on the owner's own WhatsApp number (Owner Assistant).

async function ownerOnly() {
  const user = (await getCurrentUser()) as { organizationId?: string; role?: string } | null;
  if (!user?.organizationId || user.role !== "OWNER") return null;
  return user as { organizationId: string; role: string };
}

async function syncAction(formData: FormData) {
  "use server";
  const user = await ownerOnly();
  if (!user) return;
  const today = istToday();
  let from = String(formData.get("from") || addDays(today, -7));
  let to = String(formData.get("to") || addDays(today, -1));
  if (to > today) to = today;
  if (from > to) from = to;
  if (addDays(from, 30) < to) from = addDays(to, -30);
  const r = await syncBizRange(user.organizationId, from, to, 50_000);
  revalidatePath("/dashboard/business");
  if (!r.complete) redirect(`/dashboard/business?more=${addDays(r.last, 1)}&to=${to}`);
}

async function targetAction(formData: FormData) {
  "use server";
  const user = await ownerOnly();
  if (!user) return;
  const month = String(formData.get("month") || "");
  const amount = Number(formData.get("amount"));
  if (/^\d{4}-\d{2}$/.test(month) && amount > 0) await setTarget(user.organizationId, month, amount);
  revalidatePath("/dashboard/business");
}

async function briefAction(formData: FormData) {
  "use server";
  const user = await ownerOnly();
  if (!user) return;
  const tpl = String(formData.get("template") || "") || null;
  const enabled = formData.get("enabled") === "on";
  await prisma.bizSettings.upsert({
    where: { organizationId: user.organizationId },
    update: { briefTemplateName: tpl, briefEnabled: enabled },
    create: { organizationId: user.organizationId, briefTemplateName: tpl, briefEnabled: enabled },
  });
  revalidatePath("/dashboard/business");
}

function Card({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone === "bad" ? "text-red-600" : tone === "good" ? "text-emerald-700" : "text-gray-900"}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

function Bars({ rows, max }: { rows: { name: string; sales: number }[]; max: number }) {
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.name} className="flex items-center gap-2 text-sm">
          <span className="w-44 shrink-0 truncate text-gray-700" title={r.name}>{r.name}</span>
          <div className="h-3 flex-1 rounded bg-gray-100">
            <div className="h-3 rounded bg-emerald-600" style={{ width: `${max ? Math.max(2, (r.sales / max) * 100) : 0}%` }} />
          </div>
          <span className="w-24 shrink-0 text-right font-medium tabular-nums text-gray-900">{rupees(r.sales)}</span>
        </div>
      ))}
      {!rows.length && <p className="text-sm text-gray-500">No data yet — press Sync.</p>}
    </div>
  );
}

export default async function BusinessAnalystPage({ searchParams }: { searchParams: { more?: string; to?: string } }) {
  const user = await ownerOnly();
  if (!user) {
    return <p className="p-6 text-sm text-gray-600">Only the owner can open Business Analyst.</p>;
  }
  const org = user.organizationId;
  const today = istToday();
  const yesterday = addDays(today, -1);
  const month = today.slice(0, 7);
  const monthStart = `${month}-01`;
  const lastMonthEnd = addDays(monthStart, -1);
  const lastMonthStart = `${lastMonthEnd.slice(0, 7)}-01`;

  const [settings, yday, mtdLoc, mtdProd, last30, lastMonth, tp, events, templates] = await Promise.all([
    prisma.bizSettings.findUnique({ where: { organizationId: org } }),
    salesReport(org, yesterday, yesterday, "location"),
    salesReport(org, monthStart, yesterday < monthStart ? monthStart : yesterday, "location", undefined, 12),
    salesReport(org, monthStart, yesterday < monthStart ? monthStart : yesterday, "product", undefined, 12),
    salesReport(org, addDays(today, -30), yesterday, "day"),
    salesReport(org, lastMonthStart, lastMonthEnd, "channel"),
    targetProgress(org, month),
    eventPerformance(org),
    prisma.messageTemplate.findMany({ where: { organizationId: org, status: "APPROVED" }, select: { metaTemplateName: true } }),
  ]);
  const dayMax = Math.max(1, ...last30.rows.map((r) => r.sales));

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto pb-10">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Business Analyst</h1>
        <p className="mt-1 text-sm text-gray-500">
          Your own sales numbers (shops, events, website) — only you can see this. Ask anything on WhatsApp from your Owner Assistant number, e.g. “kal koto sale holo?”, “ei mashe kon product beshi cholche?”, “Trade Fair e koto Rasogolla nebo 10 diner jonno?”.
        </p>
      </div>

      {!bmsSyncConfigured() && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">BMS_INTEGRATION_SECRET is not set on this Vercel project — sync cannot run.</div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card label={`Yesterday (${yesterday.split("-").reverse().join("/")})`} value={rupees(yday.totalSales)} sub={yday.short > 0.5 ? `Cash short ${rupees(yday.short)}` : undefined} tone={yday.short > 0.5 ? "bad" : undefined} />
        <Card label="This month so far" value={rupees(tp.achieved)} sub={tp.target ? `${tp.percent}% of ${rupees(tp.target)}` : "No target set"} tone={tp.percent !== null && tp.percent >= (tp.daysDone / Math.max(1, tp.daysDone + tp.daysLeft)) * 100 ? "good" : undefined} />
        <Card label="Needed per day" value={tp.neededPerDay ? rupees(tp.neededPerDay) : "—"} sub={`${tp.daysLeft} days left · avg so far ${rupees(tp.averagePerDaySoFar)}/day`} />
        <Card label={`Last month (${lastMonthStart.slice(0, 7)})`} value={rupees(lastMonth.totalSales)} sub={lastMonth.websiteSales ? `Website ${rupees(lastMonth.websiteSales)}` : undefined} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-900">This month by shop / event / website</h2>
          <Bars rows={mtdLoc.rows} max={Math.max(1, ...mtdLoc.rows.map((r) => r.sales))} />
        </section>
        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-900">Top products this month</h2>
          <Bars rows={mtdProd.rows} max={Math.max(1, ...mtdProd.rows.map((r) => r.sales))} />
        </section>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-900">Last 30 days</h2>
        <div className="flex h-40 items-end gap-1">
          {last30.rows.map((r) => (
            <div key={r.name} className="group relative flex-1" title={`${r.name}: ${rupees(r.sales)}`}>
              <div className="w-full rounded-t bg-emerald-600" style={{ height: `${Math.max(2, (r.sales / dayMax) * 150)}px` }} />
            </div>
          ))}
          {!last30.rows.length && <p className="text-sm text-gray-500">No data yet — press Sync.</p>}
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-900">Events — best first</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="text-xs uppercase text-gray-500">
              <tr><th className="py-2">Event</th><th>Days</th><th className="text-right">Sales</th><th className="text-right">Per day</th><th className="text-right">Goods cost</th><th className="text-right">Expenses</th><th className="text-right">Rough profit</th><th className="text-right">Cash short</th></tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {events.slice(0, 20).map((e) => (
                <tr key={e.event}>
                  <td className="py-2 font-medium text-gray-900">{e.event}<span className="block text-xs font-normal text-gray-500">{e.dates}</span></td>
                  <td>{e.sellingDays}</td>
                  <td className="text-right tabular-nums">{rupees(e.sales)}</td>
                  <td className="text-right tabular-nums">{rupees(e.perDay)}</td>
                  <td className="text-right tabular-nums">{rupees(e.goodsCost)}</td>
                  <td className="text-right tabular-nums">{rupees(e.expenses)}</td>
                  <td className={`text-right tabular-nums ${e.roughProfit < 0 ? "text-red-600" : "text-emerald-700"}`}>{rupees(e.roughProfit)}</td>
                  <td className={`text-right tabular-nums ${e.cashShort > 0 ? "text-red-600" : ""}`}>{e.cashShort ? rupees(e.cashShort) : "—"}</td>
                </tr>
              ))}
              {!events.length && <tr><td colSpan={8} className="py-3 text-gray-500">No event data yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-gray-500">Rough profit = sales − goods cost (cost price) − day expenses. Full event P&amp;L with rent is in Banglar Doi OS → Locations → Report.</p>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-900">Monthly target</h2>
          <form action={targetAction} className="mt-3 space-y-2">
            <input type="month" name="month" defaultValue={month} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
            <input type="number" name="amount" min="1" step="1" placeholder="Target in ₹, e.g. 500000" defaultValue={tp.target ?? undefined} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
            <button className="w-full rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white">Save target</button>
          </form>
          <p className="mt-2 text-xs text-gray-500">You can also just tell the analyst on WhatsApp: “December target 6 lakh”.</p>
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-900">Sync from Banglar Doi OS</h2>
          <p className="mt-1 text-xs text-gray-500">Runs by itself every morning at 8:00. Use this for older months (up to 31 days per press).</p>
          <form action={syncAction} className="mt-3 space-y-2">
            <div className="flex gap-2">
              <input type="date" name="from" defaultValue={searchParams.more || addDays(today, -7)} className="w-1/2 rounded-lg border border-gray-200 px-2 py-2 text-sm" />
              <input type="date" name="to" defaultValue={searchParams.to || yesterday} className="w-1/2 rounded-lg border border-gray-200 px-2 py-2 text-sm" />
            </div>
            <button className="w-full rounded-lg bg-emerald-700 px-3 py-2 text-sm font-medium text-white">Sync now</button>
          </form>
          {searchParams.more && <p className="mt-2 text-xs text-amber-700">Part done — press Sync now again to continue from {searchParams.more}.</p>}
          <p className="mt-2 text-xs text-gray-500">{settings?.lastSyncNote ? `${settings.lastSyncNote} · ${settings.lastSyncAt?.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}` : "Never synced yet."}</p>
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-900">Morning WhatsApp brief</h2>
          <p className="mt-1 text-xs text-gray-500">8:00 AM to your Owner Assistant number. If you messaged the AI in the last 24 h it comes as a full message; otherwise WhatsApp needs an approved template: {"{{1}}"} yesterday sale, {"{{2}}"} month so far, {"{{3}}"} % of target.</p>
          <form action={briefAction} className="mt-3 space-y-2">
            <select name="template" defaultValue={settings?.briefTemplateName ?? ""} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
              <option value="">— no template (only when chat is open) —</option>
              {templates.map((t) => <option key={t.metaTemplateName} value={t.metaTemplateName}>{t.metaTemplateName}</option>)}
            </select>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" name="enabled" defaultChecked={settings?.briefEnabled ?? true} /> Send the brief every morning
            </label>
            <button className="w-full rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white">Save</button>
          </form>
        </section>
      </div>
    </div>
  );
}
