import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { formatDate } from "@/lib/formatDate";
import ConfirmSubmitButton from "@/components/ConfirmSubmitButton";

// ---------------------------------------------------------------------------
// Delivery Rules — the admin UI for lib/business-rules.ts's DeliveryZone/
// DeliveryTier/ZonePincode/Campaign tables.
//
// 2026-08-20 UPDATE — the Zones section below (name/min-order/PIN
// codes/fee tiers) is now LEGACY. Delivery fee, minimum order, COD
// availability, and free-delivery threshold the AI actually quotes come
// live from banglardoi.com's own Admin → Delivery instead (owner's own
// instruction — two separately-edited copies of the same zones was a real
// risk of the AI getting confused, not just staleness). Edits here to a
// zone's fee tiers or minimum order no longer affect anything the AI says.
// Kept (not deleted) only because Campaigns below can still optionally be
// scoped to one of these zones by PIN code.
//
// The Campaigns section below is NOT legacy — campaigns/offers you train
// here keep working exactly as before; banglardoi.com has no equivalent
// concept. See lib/business-rules.ts's file-header comment for the full
// rationale.
// ---------------------------------------------------------------------------

// Bulk-entry format for tiers, one per line: "minAmount-maxAmount:fee", or
// "minAmount-:fee" (leave the upper bound blank) for the top "and above"
// tier. E.g. "350-599:100" / "1000-:0" for free delivery at ₹1,000+.
function parseTiers(raw: string): { minAmount: number; maxAmount: number | null; feeAmount: number }[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [range, feeRaw] = line.split(":").map((s) => s.trim());
      const [minRaw, maxRaw] = (range || "").split("-").map((s) => s.trim());
      const minAmount = Number(minRaw);
      const maxAmount = !maxRaw ? null : Number(maxRaw);
      const feeAmount = Number(feeRaw);
      return { minAmount, maxAmount, feeAmount };
    })
    .filter((t) => Number.isFinite(t.minAmount) && Number.isFinite(t.feeAmount));
}

function tiersToText(tiers: { minAmount: number; maxAmount: number | null; feeAmount: number }[]): string {
  return tiers
    .slice()
    .sort((a, b) => a.minAmount - b.minAmount)
    .map((t) => `${t.minAmount}-${t.maxAmount ?? ""}:${t.feeAmount}`)
    .join("\n");
}

// Bulk-entry for PIN codes — comma, space, or newline separated, dedupes automatically.
function parsePincodes(raw: string): string[] {
  return Array.from(new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)));
}

async function addZone(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const name = (formData.get("name") as string)?.trim();
  if (!name) return;
  const minOrderAmount = Number(formData.get("minOrderAmount")) || 0;
  const isActive = formData.get("isActive") === "on";
  const tiers = parseTiers((formData.get("tiers") as string) || "");
  const pincodes = parsePincodes((formData.get("pincodes") as string) || "");

  const zone = await prisma.deliveryZone.create({
    data: {
      organizationId: user.organizationId,
      name,
      minOrderAmount,
      isActive,
      tiers: { create: tiers },
      pincodes: { create: pincodes.map((pincode) => ({ pincode })) },
    },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "DELIVERY_ZONE_CREATED",
    metadata: { zoneId: zone.id, name, tierCount: tiers.length, pincodeCount: pincodes.length },
  });

  revalidatePath("/dashboard/delivery-rules");
}

async function updateZone(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const zoneId = formData.get("zoneId") as string;
  const zone = await prisma.deliveryZone.findFirst({ where: { id: zoneId, organizationId: user.organizationId } });
  if (!zone) return;

  const name = (formData.get("name") as string)?.trim();
  if (!name) return;
  const minOrderAmount = Number(formData.get("minOrderAmount")) || 0;
  const isActive = formData.get("isActive") === "on";
  const tiers = parseTiers((formData.get("tiers") as string) || "");
  const pincodes = parsePincodes((formData.get("pincodes") as string) || "");

  await prisma.deliveryZone.update({
    where: { id: zoneId },
    data: { name, minOrderAmount, isActive },
  });

  // Simplest reliable approach for edits: replace tiers/pincodes wholesale
  // rather than diffing — same "delete and recreate" pattern already used by
  // prisma/seed-delivery-rules.ts, safe because nothing else references a
  // DeliveryTier/ZonePincode row directly (only the parent zone).
  await prisma.deliveryTier.deleteMany({ where: { deliveryZoneId: zoneId } });
  await prisma.zonePincode.deleteMany({ where: { deliveryZoneId: zoneId } });
  if (tiers.length > 0) {
    await prisma.deliveryTier.createMany({ data: tiers.map((t) => ({ ...t, deliveryZoneId: zoneId })) });
  }
  if (pincodes.length > 0) {
    await prisma.zonePincode.createMany({ data: pincodes.map((pincode) => ({ pincode, deliveryZoneId: zoneId })) });
  }

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "DELIVERY_ZONE_UPDATED",
    metadata: { zoneId, name, tierCount: tiers.length, pincodeCount: pincodes.length },
  });

  revalidatePath("/dashboard/delivery-rules");
}

async function deleteZone(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const zoneId = formData.get("zoneId") as string;
  const zone = await prisma.deliveryZone.findFirst({ where: { id: zoneId, organizationId: user.organizationId } });
  if (!zone) return;

  // Any campaign restricted to this zone gets promoted to "all zones" instead
  // of failing on a foreign-key error — never leaves a campaign silently broken.
  await prisma.campaign.updateMany({ where: { deliveryZoneId: zoneId }, data: { deliveryZoneId: null } });
  await prisma.deliveryZone.delete({ where: { id: zoneId } }); // cascades tiers + pincodes

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "DELIVERY_ZONE_DELETED",
    metadata: { zoneId, name: zone.name },
  });

  revalidatePath("/dashboard/delivery-rules");
}

async function addCampaign(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const name = (formData.get("name") as string)?.trim();
  const startDateRaw = formData.get("startDate") as string;
  const endDateRaw = formData.get("endDate") as string;
  if (!name || !startDateRaw || !endDateRaw) return;

  const zoneId = (formData.get("deliveryZoneId") as string) || "";
  if (zoneId) {
    const zone = await prisma.deliveryZone.findFirst({ where: { id: zoneId, organizationId: user.organizationId } });
    if (!zone) return;
  }

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: user.organizationId,
      deliveryZoneId: zoneId || null,
      name,
      isActive: formData.get("isActive") === "on",
      startsAt: new Date(`${startDateRaw}T00:00:00`),
      endsAt: new Date(`${endDateRaw}T23:59:59`),
      minOrderAmount: Number(formData.get("minOrderAmount")) || 0,
      freeDelivery: formData.get("freeDelivery") === "on",
      freeGiftDescription: (formData.get("freeGiftDescription") as string)?.trim() || null,
    },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "CAMPAIGN_CREATED",
    metadata: { campaignId: campaign.id, name },
  });

  revalidatePath("/dashboard/delivery-rules");
}

async function updateCampaign(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const campaignId = formData.get("campaignId") as string;
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, organizationId: user.organizationId },
  });
  if (!campaign) return;

  const name = (formData.get("name") as string)?.trim();
  const startDateRaw = formData.get("startDate") as string;
  const endDateRaw = formData.get("endDate") as string;
  if (!name || !startDateRaw || !endDateRaw) return;

  const zoneId = (formData.get("deliveryZoneId") as string) || "";
  if (zoneId) {
    const zone = await prisma.deliveryZone.findFirst({ where: { id: zoneId, organizationId: user.organizationId } });
    if (!zone) return;
  }

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      deliveryZoneId: zoneId || null,
      name,
      isActive: formData.get("isActive") === "on",
      startsAt: new Date(`${startDateRaw}T00:00:00`),
      endsAt: new Date(`${endDateRaw}T23:59:59`),
      minOrderAmount: Number(formData.get("minOrderAmount")) || 0,
      freeDelivery: formData.get("freeDelivery") === "on",
      freeGiftDescription: (formData.get("freeGiftDescription") as string)?.trim() || null,
    },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "CAMPAIGN_UPDATED",
    metadata: { campaignId, name },
  });

  revalidatePath("/dashboard/delivery-rules");
}

async function deleteCampaign(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const campaignId = formData.get("campaignId") as string;
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, organizationId: user.organizationId },
  });
  if (!campaign) return;

  await prisma.campaign.delete({ where: { id: campaignId } });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "CAMPAIGN_DELETED",
    metadata: { campaignId, name: campaign.name },
  });

  revalidatePath("/dashboard/delivery-rules");
}

// Explicit shapes for the query results below — the sandbox this was
// written in couldn't run `prisma generate` (no network access to Prisma's
// binary CDN), so these are hand-written to exactly match the include/select
// shape of the two queries. Run `npx prisma generate` locally and these can
// be replaced with Prisma's own generated payload types if preferred; either
// way, TypeScript checks them the same.
type ZoneWithDetails = {
  id: string;
  name: string;
  minOrderAmount: number;
  isActive: boolean;
  tiers: { id: string; minAmount: number; maxAmount: number | null; feeAmount: number }[];
  pincodes: { id: string; pincode: string }[];
};
type CampaignWithZone = {
  id: string;
  name: string;
  isActive: boolean;
  startsAt: Date;
  endsAt: Date;
  minOrderAmount: number;
  freeDelivery: boolean;
  freeGiftDescription: string | null;
  deliveryZoneId: string | null;
  deliveryZone: { name: string } | null;
};

export default async function DeliveryRulesPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const [zones, campaigns]: [ZoneWithDetails[], CampaignWithZone[]] = await Promise.all([
    prisma.deliveryZone.findMany({
      where: { organizationId: user.organizationId },
      include: { tiers: true, pincodes: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.campaign.findMany({
      where: { organizationId: user.organizationId },
      include: { deliveryZone: { select: { name: true } } },
      orderBy: { startsAt: "desc" },
    }),
  ]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">Delivery Rules</h1>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">
        The AI only ever quotes a campaign offer that's configured here, or a delivery fee/minimum order/COD
        availability read live from banglardoi.com — it can never invent a number. See the notice below before
        editing zones.
      </p>

      {/* -------------------------- Delivery Zones -------------------------- */}
      <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-semibold">Legacy — banglardoi.com Admin → Delivery use koro</p>
        <p className="mt-1 text-amber-800">
          Delivery fee, minimum order, free-delivery threshold, and Cash on Delivery availability are now read live
          from banglardoi.com every time the AI replies. Editing a zone&apos;s fee tiers or minimum order below no
          longer changes what the AI quotes — go to banglardoi.com&apos;s own Admin → Delivery for that. Zones below
          are kept only so a Campaign further down this page can optionally be restricted to one area.
        </p>
      </div>
      <div className="mt-3 rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Add a delivery zone</h3>
        <form action={addZone} className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <input
              name="name"
              placeholder="Zone name (e.g. Kolkata & Covered Areas)"
              required
              className="flex-1 basis-56 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <input
              name="minOrderAmount"
              type="number"
              min="0"
              step="1"
              placeholder="Minimum order ₹ (0 = none)"
              defaultValue={0}
              className="w-48 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <label className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600">
              <input type="checkbox" name="isActive" defaultChecked /> Active
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="flex-1 basis-64">
              <label className="mb-1 block text-xs font-medium text-gray-500">
                Delivery fee tiers — one per line: minAmount-maxAmount:fee. Leave the max blank for the top "and
                above" tier. Example: <code className="text-gray-400">350-599:100</code>,{" "}
                <code className="text-gray-400">1000-:0</code> (₹0 = free delivery).
              </label>
              <textarea
                name="tiers"
                rows={4}
                placeholder={"350-599:100\n600-799:75\n800-999:50\n1000-:0"}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs"
              />
            </div>
            <div className="flex-1 basis-64">
              <label className="mb-1 block text-xs font-medium text-gray-500">
                PIN codes covered by this zone — comma, space, or newline separated.
              </label>
              <textarea
                name="pincodes"
                rows={4}
                placeholder={"700001, 700019, 700091"}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs"
              />
            </div>
          </div>
          <button
            type="submit"
            className="self-start rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light"
          >
            Add Zone
          </button>
        </form>
      </div>

      <h3 className="mt-6 text-sm font-semibold text-gray-900">Zones ({zones.length})</h3>
      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {zones.map((z) => (
          <div key={z.id} className="flex flex-col rounded-xl border border-gray-200 bg-white p-3">
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium text-gray-900">{z.name}</span>
              <span
                className={`flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                  z.isActive ? "bg-accent-light text-accent" : "bg-gray-100 text-gray-500"
                }`}
              >
                {z.isActive ? "Active" : "Inactive"}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-gray-500">
              Minimum order: {z.minOrderAmount > 0 ? `₹${z.minOrderAmount}` : "none"} · {z.pincodes.length} PIN
              code{z.pincodes.length === 1 ? "" : "s"}
            </p>
            <div className="mt-2 overflow-hidden rounded-lg border border-gray-100">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-gray-100 text-gray-400">
                    <th className="px-2 py-1 font-medium">Order range</th>
                    <th className="px-2 py-1 font-medium">Fee</th>
                  </tr>
                </thead>
                <tbody>
                  {z.tiers
                    .slice()
                    .sort((a, b) => a.minAmount - b.minAmount)
                    .map((t) => (
                      <tr key={t.id} className="border-b border-gray-50 last:border-0">
                        <td className="px-2 py-1 text-gray-600">
                          ₹{t.minAmount}
                          {t.maxAmount !== null ? `–₹${t.maxAmount}` : "+"}
                        </td>
                        <td className="px-2 py-1 text-gray-600">{t.feeAmount === 0 ? "FREE" : `₹${t.feeAmount}`}</td>
                      </tr>
                    ))}
                  {z.tiers.length === 0 && (
                    <tr>
                      <td className="px-2 py-2 text-gray-400" colSpan={2}>
                        No tiers configured yet — the AI can't quote a fee for this zone.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <details className="mt-2 rounded-lg border border-gray-200">
              <summary className="cursor-pointer select-none px-2.5 py-1.5 text-xs font-medium text-gray-600">
                Edit zone
              </summary>
              <form action={updateZone} className="flex flex-col gap-1.5 p-2.5 pt-0">
                <input type="hidden" name="zoneId" value={z.id} />
                <input
                  name="name"
                  defaultValue={z.name}
                  required
                  className="rounded border border-gray-300 px-2 py-1 text-xs"
                />
                <div className="flex items-center gap-2">
                  <input
                    name="minOrderAmount"
                    type="number"
                    min="0"
                    step="1"
                    defaultValue={z.minOrderAmount}
                    className="w-32 rounded border border-gray-300 px-2 py-1 text-xs"
                  />
                  <label className="flex items-center gap-1 text-xs text-gray-600">
                    <input type="checkbox" name="isActive" defaultChecked={z.isActive} /> Active
                  </label>
                </div>
                <textarea
                  name="tiers"
                  rows={4}
                  defaultValue={tiersToText(z.tiers)}
                  className="rounded border border-gray-300 px-2 py-1 font-mono text-xs"
                />
                <textarea
                  name="pincodes"
                  rows={3}
                  defaultValue={z.pincodes.map((p) => p.pincode).join(", ")}
                  className="rounded border border-gray-300 px-2 py-1 font-mono text-xs"
                />
                <button
                  type="submit"
                  className="mt-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-white hover:bg-primary-light"
                >
                  Save Changes
                </button>
              </form>
            </details>

            <form action={deleteZone} className="mt-1.5">
              <input type="hidden" name="zoneId" value={z.id} />
              <ConfirmSubmitButton
                label="Delete Zone"
                confirmText={`Delete "${z.name}"? This removes its tiers and PIN codes too, and the AI will no longer be able to confirm delivery for those PINs. This can't be undone.`}
                className="w-full rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
              />
            </form>
          </div>
        ))}
        {zones.length === 0 && (
          <p className="col-span-full rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
            No delivery zones yet — add your first one above. Until then, the AI will honestly tell customers it
            can't confirm delivery yet, rather than guessing a fee.
          </p>
        )}
      </div>

      {/* ---------------------------- Campaigns ------------------------------ */}
      <div className="mt-8 rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Add a campaign</h3>
        <p className="mt-0.5 text-xs text-gray-500">
          A time-boxed offer that overrides a zone's normal tiers — e.g. free delivery + a free gift for a festival,
          restricted to one zone and a minimum order. Outside its dates, or below its minimum, normal zone tiers
          apply as usual.
        </p>
        <form action={addCampaign} className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <input
              name="name"
              placeholder="Campaign name (e.g. Janmashtami 2026)"
              required
              className="flex-1 basis-56 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <select name="deliveryZoneId" className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600">
              <option value="">All zones</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name} only
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Starts</label>
              <input name="startDate" type="date" required className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Ends</label>
              <input name="endDate" type="date" required className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600" />
            </div>
            <input
              name="minOrderAmount"
              type="number"
              min="0"
              step="1"
              placeholder="Minimum order ₹"
              defaultValue={0}
              className="w-40 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <label className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600">
              <input type="checkbox" name="freeDelivery" defaultChecked /> Free delivery
            </label>
            <label className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600">
              <input type="checkbox" name="isActive" defaultChecked /> Active
            </label>
          </div>
          <input
            name="freeGiftDescription"
            placeholder="Free gift, if any (e.g. 500g Laal Kheer Doi) — optional"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="self-start rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light"
          >
            Add Campaign
          </button>
        </form>
      </div>

      <h3 className="mt-6 text-sm font-semibold text-gray-900">Campaigns ({campaigns.length})</h3>
      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {campaigns.map((c) => (
          <div key={c.id} className="flex flex-col rounded-xl border border-gray-200 bg-white p-3">
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium text-gray-900">{c.name}</span>
              <span
                className={`flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                  c.isActive ? "bg-accent-light text-accent" : "bg-gray-100 text-gray-500"
                }`}
              >
                {c.isActive ? "Active" : "Inactive"}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-gray-500">
              {formatDate(c.startsAt)} – {formatDate(c.endsAt)} · {c.deliveryZone ? c.deliveryZone.name : "All zones"}{" "}
              · Min ₹{c.minOrderAmount}
            </p>
            <p className="mt-0.5 text-xs text-gray-600">
              {c.freeDelivery ? "Free delivery" : "No free delivery"}
              {c.freeGiftDescription ? ` + ${c.freeGiftDescription} free` : ""}
            </p>

            <details className="mt-2 rounded-lg border border-gray-200">
              <summary className="cursor-pointer select-none px-2.5 py-1.5 text-xs font-medium text-gray-600">
                Edit campaign
              </summary>
              <form action={updateCampaign} className="flex flex-col gap-1.5 p-2.5 pt-0">
                <input type="hidden" name="campaignId" value={c.id} />
                <input
                  name="name"
                  defaultValue={c.name}
                  required
                  className="rounded border border-gray-300 px-2 py-1 text-xs"
                />
                <select
                  name="deliveryZoneId"
                  defaultValue={c.deliveryZoneId ?? ""}
                  className="rounded border border-gray-300 px-2 py-1 text-xs"
                >
                  <option value="">All zones</option>
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name} only
                    </option>
                  ))}
                </select>
                <div className="flex gap-1.5">
                  <input
                    name="startDate"
                    type="date"
                    required
                    defaultValue={c.startsAt.toISOString().slice(0, 10)}
                    className="w-1/2 rounded border border-gray-300 px-2 py-1 text-xs"
                  />
                  <input
                    name="endDate"
                    type="date"
                    required
                    defaultValue={c.endsAt.toISOString().slice(0, 10)}
                    className="w-1/2 rounded border border-gray-300 px-2 py-1 text-xs"
                  />
                </div>
                <input
                  name="minOrderAmount"
                  type="number"
                  min="0"
                  step="1"
                  defaultValue={c.minOrderAmount}
                  className="rounded border border-gray-300 px-2 py-1 text-xs"
                />
                <div className="flex gap-3">
                  <label className="flex items-center gap-1 text-xs text-gray-600">
                    <input type="checkbox" name="freeDelivery" defaultChecked={c.freeDelivery} /> Free delivery
                  </label>
                  <label className="flex items-center gap-1 text-xs text-gray-600">
                    <input type="checkbox" name="isActive" defaultChecked={c.isActive} /> Active
                  </label>
                </div>
                <input
                  name="freeGiftDescription"
                  defaultValue={c.freeGiftDescription ?? ""}
                  placeholder="Free gift (optional)"
                  className="rounded border border-gray-300 px-2 py-1 text-xs"
                />
                <button
                  type="submit"
                  className="mt-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-white hover:bg-primary-light"
                >
                  Save Changes
                </button>
              </form>
            </details>

            <form action={deleteCampaign} className="mt-1.5">
              <input type="hidden" name="campaignId" value={c.id} />
              <ConfirmSubmitButton
                label="Delete Campaign"
                confirmText={`Delete "${c.name}"? This can't be undone.`}
                className="w-full rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
              />
            </form>
          </div>
        ))}
        {campaigns.length === 0 && (
          <p className="col-span-full rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
            No campaigns yet — normal zone tiers apply to everyone.
          </p>
        )}
      </div>
    </div>
  );
}
