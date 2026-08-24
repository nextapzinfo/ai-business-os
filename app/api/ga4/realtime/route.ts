import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { fetchRealtimeVisitors, isGa4Configured } from "@/lib/ga4";

// Polled every ~30s by the client-side LiveVisitorsPanel on
// /dashboard/visitors — kept as its own tiny endpoint (rather than baked
// into the server-rendered page) specifically so refreshing "who's on the
// site right now" never re-runs the heavier historical-report queries on
// the rest of that page.
export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.organizationId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isGa4Configured()) {
    return NextResponse.json({ configured: false, totalActiveUsers: 0, rows: [] });
  }

  try {
    const { totalActiveUsers, rows } = await fetchRealtimeVisitors();
    return NextResponse.json({ configured: true, totalActiveUsers, rows });
  } catch (err) {
    console.error("[ga4/realtime] fetch failed:", err);
    return NextResponse.json({ configured: true, error: "GA4 request failed", totalActiveUsers: 0, rows: [] }, { status: 502 });
  }
}
