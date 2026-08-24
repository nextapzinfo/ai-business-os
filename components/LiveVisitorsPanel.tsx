"use client";

import { useEffect, useState } from "react";
import { Radio } from "lucide-react";

type RealtimeRow = { page: string; country: string; city: string; device: string; activeUsers: number };
type RealtimeResponse = {
  configured: boolean;
  error?: string;
  totalActiveUsers: number;
  rows: RealtimeRow[];
};

// Polls /api/ga4/realtime every 30s — its own small, cheap client-side loop
// rather than the codebase's usual full-page AutoRefresh/router.refresh()
// pattern, specifically so a dashboard tab left open all day doesn't keep
// re-running the heavier historical report queries on the rest of this page
// every 30 seconds too (GA4's Realtime API has a rolling ~30-minute "active
// users" window — a refresh every 30-60s gives a genuinely live feel without
// approaching quota).
export default function LiveVisitorsPanel() {
  const [data, setData] = useState<RealtimeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/ga4/realtime", { cache: "no-store" });
        const json = (await res.json()) as RealtimeResponse;
        if (!cancelled) setData(json);
      } catch {
        // Network hiccup — keep showing the last good data rather than
        // flashing an error state on every transient failure.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    poll();
    const id = setInterval(poll, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!loading && data && !data.configured) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-800">
          <Radio size={16} /> Live Visitors — not connected yet
        </h3>
        <p className="mt-1 text-xs text-amber-700">
          GA4_SERVICE_ACCOUNT_EMAIL / GA4_SERVICE_ACCOUNT_PRIVATE_KEY / GA4_PROPERTY_ID aren&apos;t set as
          Environment Variables on this project yet.
        </p>
      </div>
    );
  }

  const totalActiveUsers = data?.totalActiveUsers ?? 0;
  const rows = data?.rows ?? [];

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
          Live Right Now
        </h3>
        <span className="text-[11px] text-gray-400">auto-refreshes every 30s</span>
      </div>

      <p className="mt-2 text-3xl font-semibold text-gray-900">
        {loading && !data ? "…" : totalActiveUsers}
        <span className="ml-1.5 text-sm font-normal text-gray-500">
          {totalActiveUsers === 1 ? "visitor" : "visitors"} on the site
        </span>
      </p>

      {data?.error && <p className="mt-1 text-xs text-red-600">Couldn&apos;t reach GA4 just now — will retry.</p>}

      <div className="mt-3 max-h-64 divide-y divide-gray-100 overflow-y-auto">
        {rows.length === 0 && !loading && (
          <p className="py-3 text-xs text-gray-400">No active visitors right now.</p>
        )}
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between gap-2 py-2 text-xs">
            <div className="min-w-0">
              <p className="truncate font-medium text-gray-800">{r.page}</p>
              <p className="truncate text-gray-400">
                {r.city !== "Unknown" ? `${r.city}, ` : ""}
                {r.country} · {r.device}
              </p>
            </div>
            <span className="flex-shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
              {r.activeUsers}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
