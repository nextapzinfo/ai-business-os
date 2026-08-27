import { getCurrentUser } from "@/lib/getCurrentUser";
import {
  isBanglarDoiIntegrationEnabled,
  fetchBanglarDoiHostingStatus,
  type BanglarDoiHostingStatus,
} from "@/lib/banglardoi";

export const dynamic = "force-dynamic";

// Hosting Usage — added 2026-08-27 per the owner's own request, right after
// the Vercel Blob bandwidth outage: "kotota bandwidth galo eta dekhte
// chai" (I want to see how much bandwidth is used) — a way to catch the next
// usage-cap problem before it becomes another sudden "images are down"
// incident, instead of finding out from a broken storefront.
//
// Cloudinary and the database are shown as real, live numbers (fetched via
// banglardoi.com's own /api/integrations/hosting-status — see that route's
// comment for exactly how). Vercel and Neon are NOT — checked directly
// against their docs on 2026-08-27: Neon's usage-metrics API only works on a
// paid usage-based plan (this project is Free), and Vercel's usage/billing
// API only works for Team accounts, not a personal Hobby account. Both are
// still one click away on their own dashboards, which is what the quick-link
// buttons below are for — better an honest link than a number that's
// actually unavailable.

// Neon's Free plan storage cap, per Neon's own docs (neon.com/faqs/free-
// plan-limits-and-quotas, checked 2026-08-27) — not returned by any
// free-plan API, so hardcoded here. Update this if the Neon plan is ever
// upgraded (Launch/Scale/etc. raise this considerably).
const NEON_FREE_STORAGE_LIMIT_MB = 500;

export default async function UsagePage() {
  const user = await getCurrentUser();
  if (!user) return null;

  if (!isBanglarDoiIntegrationEnabled()) {
    return (
      <div className="flex h-full flex-col gap-4 overflow-y-auto">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Hosting Usage</h1>
          <p className="mt-1 text-sm text-gray-500">Cloudinary and database usage for banglardoi.com.</p>
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center">
          <p className="text-sm font-medium text-amber-800">Not connected yet</p>
          <p className="mt-1 text-xs text-amber-700">
            BANGLARDOI_API_BASE_URL and BANGLARDOI_INTEGRATION_SECRET need to be set as Environment Variables on
            this project in Vercel, then redeploy.
          </p>
        </div>
      </div>
    );
  }

  const status = await fetchBanglarDoiHostingStatus();

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Hosting Usage</h1>
        <p className="mt-1 text-sm text-gray-500">
          Live Cloudinary + database usage for banglardoi.com, plus quick links to Vercel/Neon/GitHub.
        </p>
      </div>

      {!status && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Couldn&apos;t reach banglardoi.com&apos;s hosting-status right now — try refreshing this page in a bit.
        </div>
      )}

      {status && (
        <div className="grid gap-4 sm:grid-cols-2">
          <DatabaseCard database={status.database} />
          <CloudinaryCard cloudinary={status.cloudinary} />
        </div>
      )}

      {status && (
        <p className="text-xs text-gray-400">
          Last checked: {new Date(status.checkedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}. This page
          re-checks every time you open it — no need to refresh manually.
        </p>
      )}

      <div>
        <h3 className="text-sm font-semibold text-gray-900">Vercel / Neon / GitHub</h3>
        <p className="mt-1 text-xs text-gray-500">
          These don&apos;t offer a free way to show real numbers here directly (Neon&apos;s usage API needs a paid
          plan; Vercel&apos;s needs a Team account) — so these open their own real dashboard instead, one click away.
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <LinkCard
            label="Vercel — banglardoi.com"
            sub="Bandwidth, Blob, deployments"
            href="https://vercel.com/aibos/banglar-doi-ecommerce"
          />
          <LinkCard
            label="Vercel — AI Business OS"
            sub="Bandwidth, functions, deployments"
            href="https://vercel.com/aibos/ai-business-os"
          />
          <LinkCard label="Neon" sub="Database storage/compute" href="https://console.neon.tech/" />
          <LinkCard
            label="GitHub"
            sub="Code only — no bandwidth cap that matters here"
            href="https://github.com/"
          />
        </div>
      </div>
    </div>
  );
}

function bytesToMB(bytes: number): number {
  return bytes / (1024 * 1024);
}

function formatBytes(bytes: number): string {
  const mb = bytesToMB(bytes);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

function barColor(percent: number): string {
  if (percent >= 90) return "bg-red-500";
  if (percent >= 70) return "bg-amber-500";
  return "bg-emerald-500";
}

function UsageBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100">
      <div className={`h-full rounded-full ${barColor(clamped)}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

function DatabaseCard({ database }: { database: BanglarDoiHostingStatus["database"] }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-gray-900">Database (Neon)</h3>
      {!database ? (
        <p className="mt-2 text-xs text-gray-400">Couldn&apos;t read database size right now.</p>
      ) : (
        (() => {
          const usedMB = bytesToMB(database.sizeBytes);
          const percent = (usedMB / NEON_FREE_STORAGE_LIMIT_MB) * 100;
          return (
            <>
              <p className="mt-2 text-2xl font-semibold text-gray-900">{formatBytes(database.sizeBytes)}</p>
              <p className="text-xs text-gray-500">
                of {NEON_FREE_STORAGE_LIMIT_MB} MB Free-plan storage limit ({percent.toFixed(1)}%)
              </p>
              <UsageBar percent={percent} />
              <p className="mt-2 text-[11px] text-gray-400">
                This is real product/order/customer data storage — separate from Cloudinary&apos;s image storage
                below.
              </p>
            </>
          );
        })()
      )}
    </div>
  );
}

function CloudinaryCard({ cloudinary }: { cloudinary: BanglarDoiHostingStatus["cloudinary"] }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-gray-900">Images (Cloudinary)</h3>
      {!cloudinary ? (
        <p className="mt-2 text-xs text-gray-400">Couldn&apos;t read Cloudinary usage right now.</p>
      ) : cloudinary.credits ? (
        (() => {
          const { usage, limit } = cloudinary.credits!;
          const percent = limit > 0 ? (usage / limit) * 100 : 0;
          return (
            <>
              <p className="mt-2 text-2xl font-semibold text-gray-900">
                {usage.toFixed(1)} / {limit} credits
              </p>
              <p className="text-xs text-gray-500">
                {percent.toFixed(1)}% used this billing cycle — 1 credit ≈ 1 GB storage, 1 GB delivered bandwidth,
                or 1,000 image transformations
              </p>
              <UsageBar percent={percent} />
              <div className="mt-3 flex flex-col gap-1 text-[11px] text-gray-500">
                {cloudinary.storage && <span>Storage: {formatBytes(cloudinary.storage.usage)}</span>}
                {cloudinary.bandwidth && <span>Bandwidth this cycle: {formatBytes(cloudinary.bandwidth.usage)}</span>}
                {cloudinary.transformations && (
                  <span>Transformations this cycle: {cloudinary.transformations.usage.toLocaleString("en-IN")}</span>
                )}
              </div>
            </>
          );
        })()
      ) : (
        <p className="mt-2 text-xs text-gray-400">
          Cloudinary didn&apos;t return a credits figure for this plan type — check{" "}
          <a href="https://cloudinary.com/console/usage" target="_blank" rel="noreferrer" className="underline">
            Cloudinary&apos;s own usage page
          </a>{" "}
          directly.
        </p>
      )}
    </div>
  );
}

function LinkCard({ label, sub, href }: { label: string; sub: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="rounded-xl border border-gray-200 bg-white p-3 text-xs transition-colors hover:border-primary/40 hover:bg-primary/5"
    >
      <p className="font-medium text-gray-900">{label} ↗</p>
      <p className="mt-0.5 text-gray-500">{sub}</p>
    </a>
  );
}
