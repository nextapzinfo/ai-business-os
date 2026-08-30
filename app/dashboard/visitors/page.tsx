import { getCurrentUser } from "@/lib/getCurrentUser";
import LiveVisitorsPanel from "@/components/LiveVisitorsPanel";
import {
  isGa4Configured,
  fetchTrafficOverview,
  fetchTopPages,
  fetchTrafficSources,
  fetchDeviceBreakdown,
  fetchBrowserBreakdown,
  fetchAgeBreakdown,
  fetchGenderBreakdown,
  fetchEcommerceFunnel,
  todayInIndia,
  daysAgoInIndia,
  type TrafficOverview,
  type TopPageRow,
  type NamedCountRow,
  type EcommerceFunnel,
} from "@/lib/ga4";
import { Download } from "lucide-react";

export const dynamic = "force-dynamic";

// Day/Week/Custom report picker — added 2026-08-30, owner's own request:
// "Session e nos ta dakhabe (kotojon visit korlo) and report download
// option (days/weekly/customezied date from to)". Resolves whatever the
// owner picked down to one explicit {startDate, endDate} pair up front, so
// every stat/chart/list on the page AND the "Download Report" link below
// all reflect the exact same period — never a "7 days" label on screen next
// to a downloaded file that's actually a different range.
function resolvePeriod(searchParams: { period?: string; from?: string; to?: string }): {
  range: { startDate: string; endDate: string };
  label: string;
} {
  const today = todayInIndia();

  if (searchParams.period === "custom" && searchParams.from && searchParams.to) {
    return { range: { startDate: searchParams.from, endDate: searchParams.to }, label: "Custom range" };
  }
  if (searchParams.period === "1") {
    return { range: { startDate: today, endDate: today }, label: "Today" };
  }
  if (searchParams.period === "30") {
    return { range: { startDate: daysAgoInIndia(29), endDate: today }, label: "Last 30 days" };
  }
  // Default: last 7 days (matches this page's original fixed behavior).
  return { range: { startDate: daysAgoInIndia(6), endDate: today }, label: "Last 7 days" };
}

// Website Visitors — added 2026-08-24 per the owner's "Website → GA4 →
// Banglar Doi OS Dashboard" request. The Live Right Now panel polls its own
// small API route every 30s (see LiveVisitorsPanel); everything else here is
// a normal server-rendered snapshot for the last 7 days, refreshed whenever
// the page itself is opened/navigated to — no need for those heavier report
// queries to re-run every 30s the way the live count does.
export default async function VisitorsPage({
  searchParams,
}: {
  searchParams: { period?: string; from?: string; to?: string };
}) {
  const user = await getCurrentUser();
  if (!user) return null;

  if (!isGa4Configured()) {
    return (
      <div className="flex h-full flex-col gap-4 overflow-y-auto">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Website Visitors</h1>
          <p className="mt-1 text-sm text-gray-500">Live visitor and traffic data from banglardoi.com, via GA4.</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center">
          <p className="text-sm font-medium text-amber-800">Not connected yet</p>
          <p className="mt-1 text-xs text-amber-700">
            Add GA4_SERVICE_ACCOUNT_EMAIL, GA4_SERVICE_ACCOUNT_PRIVATE_KEY, and GA4_PROPERTY_ID as Environment
            Variables on this project in Vercel, then redeploy.
          </p>
        </div>
      </div>
    );
  }

  const { range, label: periodLabel } = resolvePeriod(searchParams);
  const activePeriod = searchParams.period === "custom" && searchParams.from && searchParams.to
    ? "custom"
    : searchParams.period === "1" || searchParams.period === "30"
    ? searchParams.period
    : "7";

  // Every report query runs independently and is individually allowed to
  // fail without breaking the rest of the page — a GA4 hiccup on one metric
  // (or, e.g., banglardoi.com's tracking not being live yet so there's
  // simply no data) shouldn't take down the whole dashboard.
  const [overview, topPages, sources, devices, browsers, ages, genders, funnel] = await Promise.all([
    fetchTrafficOverview(range).catch((): TrafficOverview | null => null),
    fetchTopPages(range).catch((): TopPageRow[] => []),
    fetchTrafficSources(range).catch((): NamedCountRow[] => []),
    fetchDeviceBreakdown(range).catch((): NamedCountRow[] => []),
    fetchBrowserBreakdown(range).catch((): NamedCountRow[] => []),
    // Age/Gender only return real (non-"Not available") rows once Google
    // signals data collection is turned on in GA4 Admin (owner turned this on
    // 2026-08-25) — see the comment on fetchAgeBreakdown/fetchGenderBreakdown
    // in lib/ga4.ts for why a large "Not available" bucket is normal here.
    fetchAgeBreakdown(range).catch((): NamedCountRow[] => []),
    fetchGenderBreakdown(range).catch((): NamedCountRow[] => []),
    fetchEcommerceFunnel(range).catch((): EcommerceFunnel | null => null),
  ]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Website Visitors</h1>
          <p className="mt-1 text-sm text-gray-500">Live visitor and traffic data from banglardoi.com, via GA4.</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Plain GET links — no client JS needed, each just re-renders this
              Server Component with a different ?period. */}
          <div className="flex overflow-hidden rounded-lg border border-gray-200 text-xs font-medium">
            {[
              { key: "1", label: "Day" },
              { key: "7", label: "Week" },
              { key: "30", label: "30 Days" },
            ].map((p) => (
              <a
                key={p.key}
                href={`/dashboard/visitors?period=${p.key}`}
                className={`px-3 py-1.5 ${
                  activePeriod === p.key ? "bg-primary text-white" : "bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                {p.label}
              </a>
            ))}
          </div>

          {/* Custom date-range form — submits as a plain GET so the resulting
              URL (?period=custom&from=...&to=...) is shareable/bookmarkable
              and the Download Report link below can read the same params. */}
          <form action="/dashboard/visitors" method="get" className="flex items-center gap-1.5">
            <input type="hidden" name="period" value="custom" />
            <input
              type="date"
              name="from"
              defaultValue={activePeriod === "custom" ? searchParams.from : undefined}
              max={todayInIndia()}
              className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-700"
            />
            <span className="text-xs text-gray-400">to</span>
            <input
              type="date"
              name="to"
              defaultValue={activePeriod === "custom" ? searchParams.to : undefined}
              max={todayInIndia()}
              className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-700"
            />
            <button
              type="submit"
              className="rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
            >
              Go
            </button>
          </form>

          <a
            href={`/api/ga4/report?from=${range.startDate}&to=${range.endDate}`}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-light"
          >
            <Download size={13} /> Download Report
          </a>
        </div>
      </div>

      <LiveVisitorsPanel />

      {overview && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatCard label={`Sessions (${periodLabel})`} value={overview.sessions} />
          <StatCard label={`Visitors (${periodLabel})`} value={overview.totalUsers} />
          <StatCard label={`Page Views (${periodLabel})`} value={overview.screenPageViews} />
          <StatCard label="Engagement Rate" value={`${Math.round(overview.engagementRate * 100)}%`} />
          <StatCard label="Avg. Time on Site" value={formatDuration(overview.averageSessionDuration)} />
        </div>
      )}

      {overview && overview.byDate.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-gray-900">Sessions — {periodLabel}</h3>
          <div className="mt-3 flex items-end gap-1" style={{ height: 100 }}>
            {overview.byDate.map((d) => {
              const max = Math.max(1, ...overview.byDate.map((x) => x.sessions));
              return (
                <div
                  key={d.date}
                  className="flex flex-1 flex-col items-center justify-end gap-1"
                  title={`${d.date}: ${d.sessions} sessions`}
                >
                  <div
                    className="w-full rounded-t bg-primary/70"
                    style={{ height: `${Math.max(2, (d.sessions / max) * 90)}px` }}
                  />
                  <span className="text-[9px] text-gray-400">{d.date.slice(4, 6)}/{d.date.slice(6, 8)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {funnel && (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-gray-900">Ecommerce Funnel — {periodLabel}</h3>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <FunnelStep label="Product Views" value={funnel.itemsViewed} />
            <FunnelStep label="Added to Cart" value={funnel.addToCarts} />
            <FunnelStep label="Checkouts Started" value={funnel.checkouts} />
            <FunnelStep label="Purchases" value={funnel.purchases} accent="text-emerald-600" />
          </div>
          <p className="mt-3 text-sm text-gray-700">
            Revenue tracked via GA4:{" "}
            <span className="font-semibold text-gray-900">₹{funnel.totalRevenue.toLocaleString("en-IN")}</span>
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <ListCard title="Top Pages" rows={topPages.map((p) => ({ label: p.title || p.path, count: p.views }))} />
        <ListCard
          title="Traffic Sources"
          rows={sources.map((s) => ({ label: s.name, count: s.sessions }))}
          countLabel="sessions"
        />
        <ListCard
          title="Devices"
          rows={devices.map((d) => ({ label: d.name, count: d.sessions }))}
          countLabel="sessions"
        />
        <ListCard
          title="Browsers"
          rows={browsers.map((b) => ({ label: b.name, count: b.sessions }))}
          countLabel="sessions"
        />
        <ListCard
          title="Age"
          rows={ages.map((a) => ({ label: a.name, count: a.sessions }))}
          countLabel="visitors"
        />
        <ListCard
          title="Gender"
          rows={genders.map((g) => ({ label: g.name, count: g.sessions }))}
          countLabel="visitors"
        />
      </div>
      {(ages.some((a) => a.name !== "Not available") || genders.some((g) => g.name !== "Not available")) ? null : (
        <p className="text-xs text-gray-400">
          Age/Gender needs a signed-in Google visitor with Ads Personalization on to show — this was just turned on,
          so it may take a day or two to start showing real numbers instead of &quot;Not available&quot;.
        </p>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-2xl font-semibold text-gray-900">{value}</p>
      <p className="mt-0.5 text-xs text-gray-500">{label}</p>
    </div>
  );
}

function FunnelStep({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="rounded-lg bg-gray-50 p-3 text-center">
      <p className={`text-xl font-semibold ${accent ?? "text-gray-900"}`}>{value}</p>
      <p className="mt-0.5 text-[11px] text-gray-500">{label}</p>
    </div>
  );
}

function ListCard({
  title,
  rows,
  countLabel = "views",
}: {
  title: string;
  rows: { label: string; count: number }[];
  countLabel?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      <div className="mt-2 flex flex-col divide-y divide-gray-100">
        {rows.length === 0 && <p className="py-3 text-xs text-gray-400">No data yet for this period.</p>}
        {rows.slice(0, 10).map((r, i) => (
          <div key={i} className="flex items-center justify-between gap-2 py-2 text-xs">
            <span className="truncate text-gray-700">{r.label || "(not set)"}</span>
            <span className="flex-shrink-0 text-gray-400">
              {r.count} {countLabel}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
