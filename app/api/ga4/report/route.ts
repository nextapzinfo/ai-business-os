import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  isGa4Configured,
  fetchTrafficOverview,
  fetchTopPages,
  fetchTrafficSources,
  fetchDeviceBreakdown,
  fetchBrowserBreakdown,
  fetchEcommerceFunnel,
} from "@/lib/ga4";

export const dynamic = "force-dynamic";

// Downloadable CSV version of the /dashboard/visitors page — added
// 2026-08-30, owner's own request: "report download option (days/weekly/
// customezied date from to)". Takes the SAME explicit from/to dates the
// page itself resolves its Day/Week/Custom picker down to (see
// resolveReportRange in dashboard/visitors/page.tsx) rather than
// re-implementing that logic here, so the downloaded file always matches
// exactly what was on screen when it was requested.
function csvEscape(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(cells: (string | number)[]): string {
  return cells.map(csvEscape).join(",") + "\r\n";
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isGa4Configured()) {
    return NextResponse.json({ error: "GA4 is not connected yet." }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ error: "Missing or invalid from/to dates (expected YYYY-MM-DD)." }, { status: 400 });
  }
  const range = { startDate: from, endDate: to };

  try {
    const [overview, topPages, sources, devices, browsers, funnel] = await Promise.all([
      fetchTrafficOverview(range),
      fetchTopPages(range, 50),
      fetchTrafficSources(range, 50),
      fetchDeviceBreakdown(range),
      fetchBrowserBreakdown(range, 50),
      fetchEcommerceFunnel(range),
    ]);

    let csv = "";
    csv += csvRow(["Banglar Doi — Website Visitors Report"]);
    csv += csvRow(["Period", `${from} to ${to}`]);
    csv += "\r\n";

    csv += csvRow(["Overview"]);
    csv += csvRow(["Sessions", overview.sessions]);
    csv += csvRow(["Visitors", overview.totalUsers]);
    csv += csvRow(["Page Views", overview.screenPageViews]);
    csv += csvRow(["Engagement Rate", `${Math.round(overview.engagementRate * 100)}%`]);
    csv += csvRow(["Avg. Session Duration (s)", Math.round(overview.averageSessionDuration)]);
    csv += "\r\n";

    csv += csvRow(["Sessions by Date"]);
    csv += csvRow(["Date", "Sessions", "Page Views"]);
    for (const d of overview.byDate) csv += csvRow([d.date, d.sessions, d.screenPageViews]);
    csv += "\r\n";

    csv += csvRow(["Ecommerce Funnel"]);
    csv += csvRow(["Product Views", funnel.itemsViewed]);
    csv += csvRow(["Added to Cart", funnel.addToCarts]);
    csv += csvRow(["Checkouts Started", funnel.checkouts]);
    csv += csvRow(["Purchases", funnel.purchases]);
    csv += csvRow(["Revenue (INR)", funnel.totalRevenue]);
    csv += "\r\n";

    csv += csvRow(["Top Pages"]);
    csv += csvRow(["Page", "Views"]);
    for (const p of topPages) csv += csvRow([p.title || p.path, p.views]);
    csv += "\r\n";

    csv += csvRow(["Traffic Sources"]);
    csv += csvRow(["Source / Medium", "Sessions"]);
    for (const s of sources) csv += csvRow([s.name, s.sessions]);
    csv += "\r\n";

    csv += csvRow(["Devices"]);
    csv += csvRow(["Device", "Sessions"]);
    for (const d of devices) csv += csvRow([d.name, d.sessions]);
    csv += "\r\n";

    csv += csvRow(["Browsers"]);
    csv += csvRow(["Browser", "Sessions"]);
    for (const b of browsers) csv += csvRow([b.name, b.sessions]);

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="banglardoi-visitors-${from}_to_${to}.csv"`,
      },
    });
  } catch (err) {
    console.error("[ga4/report] fetch failed:", err);
    return NextResponse.json({ error: "GA4 request failed." }, { status: 502 });
  }
}
