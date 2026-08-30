import { GoogleAuth } from "google-auth-library";

// Google Analytics 4 Data API integration — added 2026-08-24 for the owner's
// "live visitor" dashboard request (Website → GA4 → Banglar Doi OS Dashboard).
// Pulls data GA4 already collects (via the gtag.js tracking wired into
// banglardoi.com separately) back out through GA4's own read-only Data API,
// so the owner never has to open analytics.google.com day-to-day.
//
// Uses its own, separately-named service account credentials
// (GA4_SERVICE_ACCOUNT_EMAIL / GA4_SERVICE_ACCOUNT_PRIVATE_KEY) rather than
// reusing lib/googleSheets.ts's GOOGLE_SERVICE_ACCOUNT_* pair — that pair may
// already be pointed at a different service account for a different purpose
// (Sheets), and GA4's service account only has read-only Viewer access on the
// GA4 property, a narrower scope than Sheets' access. Keeping them distinct
// means one integration's credentials can never accidentally satisfy (or
// break) the other's.

const GA4_DATA_API_BASE = "https://analyticsdata.googleapis.com/v1beta";

let cachedAuth: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (cachedAuth) return cachedAuth;

  const email = process.env.GA4_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GA4_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!email || !rawKey) {
    throw new Error("GA4_SERVICE_ACCOUNT_EMAIL or GA4_SERVICE_ACCOUNT_PRIVATE_KEY is not set");
  }

  // Vercel env vars store literal "\n" — turn them back into real newlines,
  // same pattern as lib/googleSheets.ts.
  const privateKey = rawKey.replace(/\\n/g, "\n");

  cachedAuth = new GoogleAuth({
    credentials: { client_email: email, private_key: privateKey },
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  });
  return cachedAuth;
}

// True only when all 3 required env vars are present — lets callers show a
// clean "not connected yet" state instead of a crash/500 before the owner has
// finished the Vercel env var setup.
export function isGa4Configured(): boolean {
  return Boolean(
    process.env.GA4_SERVICE_ACCOUNT_EMAIL &&
      process.env.GA4_SERVICE_ACCOUNT_PRIVATE_KEY &&
      process.env.GA4_PROPERTY_ID
  );
}

async function getAccessToken(): Promise<string> {
  const auth = getAuth();
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse.token) {
    throw new Error("Failed to obtain Google access token for GA4");
  }
  return tokenResponse.token;
}

function getPropertyId(): string {
  const id = process.env.GA4_PROPERTY_ID;
  if (!id) throw new Error("GA4_PROPERTY_ID is not set");
  return id;
}

type Ga4ApiRow = { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] };
type Ga4ApiResponse = { rows?: Ga4ApiRow[] };

async function callGa4Api(method: "runRealtimeReport" | "runReport", body: unknown): Promise<Ga4ApiResponse> {
  const token = await getAccessToken();
  const propertyId = getPropertyId();
  const url = `${GA4_DATA_API_BASE}/properties/${propertyId}:${method}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // Live dashboard data — never let Next.js cache a stale GA4 response.
    cache: "no-store",
  });

  const data = await res.json();
  if (!res.ok) {
    const errMessage = data?.error?.message || JSON.stringify(data);
    throw new Error(`GA4 Data API ${method} failed: ${res.status} ${errMessage}`);
  }
  return data as Ga4ApiResponse;
}

// Turns { rows: [{dimensionValues, metricValues}] } into plain objects keyed
// by the dimension/metric names passed in, in order — much easier to work
// with than the raw positional arrays the API returns.
function shapeRows(
  data: Ga4ApiResponse,
  dimensionNames: string[],
  metricNames: string[]
): Record<string, string>[] {
  return (data.rows ?? []).map((row) => {
    const out: Record<string, string> = {};
    dimensionNames.forEach((name, i) => {
      out[name] = row.dimensionValues?.[i]?.value ?? "";
    });
    metricNames.forEach((name, i) => {
      out[name] = row.metricValues?.[i]?.value ?? "0";
    });
    return out;
  });
}

// ── Realtime — who's on the site right now ──────────────────────────────
// GA4's Realtime API has a rolling ~30-minute "active users" window. Field
// names verified against Google's own Realtime API schema reference
// (developers.google.com/analytics/devguides/reporting/data/v1/realtime-api-schema)
// on 2026-08-24 — this is a DIFFERENT, more limited field set than the
// standard runReport method below (e.g. no sessionSource in Realtime).
export type RealtimeVisitorRow = {
  page: string;
  country: string;
  city: string;
  device: string;
  activeUsers: number;
};

export async function fetchRealtimeVisitors(): Promise<{ totalActiveUsers: number; rows: RealtimeVisitorRow[] }> {
  const data = await callGa4Api("runRealtimeReport", {
    dimensions: [{ name: "unifiedScreenName" }, { name: "country" }, { name: "city" }, { name: "deviceCategory" }],
    metrics: [{ name: "activeUsers" }],
    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
    limit: 50,
  });

  const rows = shapeRows(data, ["unifiedScreenName", "country", "city", "deviceCategory"], ["activeUsers"]).map(
    (r) => ({
      page: r.unifiedScreenName || "(unknown page)",
      country: r.country || "Unknown",
      city: r.city || "Unknown",
      device: r.deviceCategory || "Unknown",
      activeUsers: Number(r.activeUsers) || 0,
    })
  );

  const totalActiveUsers = rows.reduce((sum, r) => sum + r.activeUsers, 0);
  return { totalActiveUsers, rows };
}

// ── Historical / period reports ─────────────────────────────────────────
// Accepts either a plain "last N days" shorthand (used by the dashboard's
// default 7-day view and the Live panel) or an explicit {startDate, endDate}
// pair — added 2026-08-30 for the report-download feature's Day/Week/Custom
// date-range picker (owner's own request: "report download option
// (days/weekly/customezied date from to)"). GA4's Data API accepts either
// its own relative shorthand ("7daysAgo") or plain "YYYY-MM-DD" strings in
// the exact same dateRanges field, so this is a pure input-normalization
// change — every report query below is otherwise untouched.
export type Ga4DateRangeInput = number | { startDate: string; endDate: string };

function dateRangeFor(range: Ga4DateRangeInput) {
  if (typeof range === "number") {
    return [{ startDate: `${range}daysAgo`, endDate: "today" }];
  }
  return [{ startDate: range.startDate, endDate: range.endDate }];
}

// Small date helpers for the Day/Week/Custom report picker on
// /dashboard/visitors — kept here (rather than duplicated in the page) so
// the page's on-screen figures and its "Download Report" link always
// resolve the exact same explicit {startDate, endDate} pair, instead of the
// page using GA4's relative "7daysAgo" shorthand for one and explicit dates
// for the other and risking an off-by-one mismatch between what's on screen
// and what's in the downloaded file.
export function todayInIndia(): string {
  // en-CA locale formats as YYYY-MM-DD, which doubles as a clean ISO date string.
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export function daysAgoInIndia(days: number): string {
  const now = new Date();
  // Shift by the requested number of days in UTC ms, then re-format in the
  // India timezone the same way todayInIndia does — good enough for whole-day
  // granularity, which is all a date-only report range ever needs.
  const shifted = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return shifted.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export type TrafficOverview = {
  sessions: number;
  totalUsers: number;
  screenPageViews: number;
  engagementRate: number; // 0–1
  averageSessionDuration: number; // seconds
  byDate: { date: string; sessions: number; screenPageViews: number }[];
};

export async function fetchTrafficOverview(range: Ga4DateRangeInput): Promise<TrafficOverview> {
  const [totalsData, byDateData] = await Promise.all([
    callGa4Api("runReport", {
      dateRanges: dateRangeFor(range),
      metrics: [
        { name: "sessions" },
        { name: "totalUsers" },
        { name: "screenPageViews" },
        { name: "engagementRate" },
        { name: "averageSessionDuration" },
      ],
    }),
    callGa4Api("runReport", {
      dateRanges: dateRangeFor(range),
      dimensions: [{ name: "date" }],
      metrics: [{ name: "sessions" }, { name: "screenPageViews" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
    }),
  ]);

  const totalsRow = shapeRows(totalsData, [], [
    "sessions",
    "totalUsers",
    "screenPageViews",
    "engagementRate",
    "averageSessionDuration",
  ])[0] ?? {};

  const byDate = shapeRows(byDateData, ["date"], ["sessions", "screenPageViews"]).map((r) => ({
    date: r.date,
    sessions: Number(r.sessions) || 0,
    screenPageViews: Number(r.screenPageViews) || 0,
  }));

  return {
    sessions: Number(totalsRow.sessions) || 0,
    totalUsers: Number(totalsRow.totalUsers) || 0,
    screenPageViews: Number(totalsRow.screenPageViews) || 0,
    engagementRate: Number(totalsRow.engagementRate) || 0,
    averageSessionDuration: Number(totalsRow.averageSessionDuration) || 0,
    byDate,
  };
}

export type TopPageRow = { path: string; title: string; views: number };

export async function fetchTopPages(range: Ga4DateRangeInput, limit = 10): Promise<TopPageRow[]> {
  const data = await callGa4Api("runReport", {
    dateRanges: dateRangeFor(range),
    dimensions: [{ name: "pagePath" }, { name: "pageTitle" }],
    metrics: [{ name: "screenPageViews" }],
    orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
    limit,
  });
  return shapeRows(data, ["pagePath", "pageTitle"], ["screenPageViews"]).map((r) => ({
    path: r.pagePath,
    title: r.pageTitle,
    views: Number(r.screenPageViews) || 0,
  }));
}

export type NamedCountRow = { name: string; sessions: number };

export async function fetchTrafficSources(range: Ga4DateRangeInput, limit = 10): Promise<NamedCountRow[]> {
  const data = await callGa4Api("runReport", {
    dateRanges: dateRangeFor(range),
    dimensions: [{ name: "sessionSourceMedium" }],
    metrics: [{ name: "sessions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit,
  });
  return shapeRows(data, ["sessionSourceMedium"], ["sessions"]).map((r) => ({
    name: r.sessionSourceMedium || "(direct)",
    sessions: Number(r.sessions) || 0,
  }));
}

export async function fetchDeviceBreakdown(range: Ga4DateRangeInput): Promise<NamedCountRow[]> {
  const data = await callGa4Api("runReport", {
    dateRanges: dateRangeFor(range),
    dimensions: [{ name: "deviceCategory" }],
    metrics: [{ name: "sessions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
  });
  return shapeRows(data, ["deviceCategory"], ["sessions"]).map((r) => ({
    name: r.deviceCategory || "Unknown",
    sessions: Number(r.sessions) || 0,
  }));
}

export async function fetchBrowserBreakdown(range: Ga4DateRangeInput, limit = 8): Promise<NamedCountRow[]> {
  const data = await callGa4Api("runReport", {
    dateRanges: dateRangeFor(range),
    dimensions: [{ name: "browser" }],
    metrics: [{ name: "sessions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit,
  });
  return shapeRows(data, ["browser"], ["sessions"]).map((r) => ({
    name: r.browser || "Unknown",
    sessions: Number(r.sessions) || 0,
  }));
}

// ── Age / Gender — requires "Google signals data collection" to be turned
// ON in GA4 Admin → Data Collection (owner turned this on 2026-08-25). Only
// covers visitors who are signed into a Google account with Ads
// Personalization enabled, so a large "(not set)" bucket is normal and
// expected — that's Google's own privacy limit, not a bug in this
// integration. Data also only starts accumulating from the moment Google
// signals was turned on — it can't backfill demographics for older
// sessions, so this can look sparse/empty for the first day or two.
// Uses activeUsers (not sessions) as the metric — the standard metric GA4's
// own Demographics reports use for age/gender breakdowns.
export async function fetchAgeBreakdown(range: Ga4DateRangeInput): Promise<NamedCountRow[]> {
  const data = await callGa4Api("runReport", {
    dateRanges: dateRangeFor(range),
    dimensions: [{ name: "userAgeBracket" }],
    metrics: [{ name: "activeUsers" }],
    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
  });
  return shapeRows(data, ["userAgeBracket"], ["activeUsers"]).map((r) => ({
    name: r.userAgeBracket && r.userAgeBracket !== "(not set)" ? r.userAgeBracket : "Not available",
    sessions: Number(r.activeUsers) || 0,
  }));
}

export async function fetchGenderBreakdown(range: Ga4DateRangeInput): Promise<NamedCountRow[]> {
  const data = await callGa4Api("runReport", {
    dateRanges: dateRangeFor(range),
    dimensions: [{ name: "userGender" }],
    metrics: [{ name: "activeUsers" }],
    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
  });
  return shapeRows(data, ["userGender"], ["activeUsers"]).map((r) => ({
    name: r.userGender && r.userGender !== "(not set)" ? r.userGender : "Not available",
    sessions: Number(r.activeUsers) || 0,
  }));
}

// ── Ecommerce funnel — product view → add to cart → checkout → purchase ──
// Matches the 4 events banglardoi.com's gtag.js integration fires
// (view_item/add_to_cart/begin_checkout/purchase — see lib/analytics.ts on
// that repo). GA4's own standard ecommerce metrics aggregate these
// automatically; itemsViewed/addToCarts/checkouts/ecommercePurchases are the
// funnel step counts, totalRevenue is real ₹ revenue for the period.
export type EcommerceFunnel = {
  itemsViewed: number;
  addToCarts: number;
  checkouts: number;
  purchases: number;
  totalRevenue: number;
};

export async function fetchEcommerceFunnel(range: Ga4DateRangeInput): Promise<EcommerceFunnel> {
  const data = await callGa4Api("runReport", {
    dateRanges: dateRangeFor(range),
    metrics: [
      { name: "itemsViewed" },
      { name: "addToCarts" },
      { name: "checkouts" },
      { name: "ecommercePurchases" },
      { name: "totalRevenue" },
    ],
  });
  const row =
    shapeRows(data, [], ["itemsViewed", "addToCarts", "checkouts", "ecommercePurchases", "totalRevenue"])[0] ?? {};
  return {
    itemsViewed: Number(row.itemsViewed) || 0,
    addToCarts: Number(row.addToCarts) || 0,
    checkouts: Number(row.checkouts) || 0,
    purchases: Number(row.ecommercePurchases) || 0,
    totalRevenue: Number(row.totalRevenue) || 0,
  };
}
