// Phase 9 — lets this app's WhatsApp agent (running on Banglar Doi's own
// number, 7980081014) answer real "where's my order?" and "is X in stock?"
// questions using Banglar Doi's actual live order/inventory data, instead of
// guessing from whatever it was taught in Agent Studio. Banglar Doi exposes
// two small shared-secret-authenticated endpoints for this
// (banglardoi-app: src/app/api/integrations/order-status and
// /product-stock) — this file is the client side of that integration.
//
// Feature-flagged purely by env var presence (same pattern as
// isWhatsAppConfigured() in this same file's sibling), not a DB column —
// there's only one organization using this today, so a migration wasn't
// worth it. If a second, unrelated retail business ever joins this app,
// gate this per-organization for real before enabling it for them too.

export function isBanglarDoiIntegrationEnabled(): boolean {
  return Boolean(process.env.BANGLARDOI_API_BASE_URL && process.env.BANGLARDOI_INTEGRATION_SECRET);
}

export type BanglarDoiOrder = {
  orderNumber: string;
  status: string;
  placedAt: string;
  total: string;
  items: string[];
  lastUpdate: { status: string; note: string | null; at: string } | null;
};

export type BanglarDoiProductVariant = {
  label: string;
  price: string;
  minOrderQty: number;
  inStock: boolean;
};

export type BanglarDoiProduct = {
  name: string;
  variants: BanglarDoiProductVariant[];
};

export type BanglarDoiDeliveryFeeTier = { uptoInPaise: number; feeInPaise: number };

export type BanglarDoiDeliveryQuote = {
  feeInPaise: number;
  codAllowed: boolean;
  minOrderInPaise: number;
  meetsMinOrder: boolean;
  freeDeliveryThresholdInPaise: number | null;
  feeTiers: BanglarDoiDeliveryFeeTier[];
};

async function banglarDoiFetch(path: string): Promise<any> {
  const baseUrl = process.env.BANGLARDOI_API_BASE_URL;
  const secret = process.env.BANGLARDOI_INTEGRATION_SECRET;
  if (!baseUrl || !secret) {
    throw new Error("BANGLARDOI_API_BASE_URL or BANGLARDOI_INTEGRATION_SECRET is not set");
  }

  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Banglar Doi API call failed: ${res.status} ${errText}`);
  }
  return res.json();
}

// phone should be the customer's own WhatsApp number (digits, e.g.
// "919831012345") — Banglar Doi matches on the last 10 digits, so it works
// regardless of whether a leading "91" is present.
export async function fetchBanglarDoiOrderStatus(phone: string): Promise<BanglarDoiOrder[]> {
  const data = await banglarDoiFetch(`/api/integrations/order-status?phone=${encodeURIComponent(phone)}`);
  return (data.orders ?? []) as BanglarDoiOrder[];
}

export async function fetchBanglarDoiProductStock(query: string): Promise<BanglarDoiProduct[]> {
  const data = await banglarDoiFetch(`/api/integrations/product-stock?q=${encodeURIComponent(query)}`);
  return (data.products ?? []) as BanglarDoiProduct[];
}

// Finds a confident live-price match for `name` in banglardoi.com's real
// catalog and formats it as a short fragment ready to drop into a product
// info block — or returns null if there's nothing confident to say, so the
// caller falls back to its own locally-taught price text instead of
// guessing. Added 2026-08-20, owner's own instruction: "product r price o AI
// website ta follow korle aro bhalo hobe" (product price should follow the
// website too, for the same reason as delivery). "Confident" deliberately
// means an exact case-insensitive name match, or — when nothing matched
// exactly — the single result IF it's the only one returned; never picks
// among several ambiguous candidates (same "don't guess" philosophy as
// check_product_stock's own tool description).
export async function fetchLiveProductPriceText(name: string): Promise<string | null> {
  try {
    const products = await fetchBanglarDoiProductStock(name);
    if (products.length === 0) return null;
    const norm = name.trim().toLowerCase();
    const exact = products.find((p) => p.name.trim().toLowerCase() === norm);
    const best = exact ?? (products.length === 1 ? products[0] : null);
    if (!best || best.variants.length === 0) return null;
    return best.variants
      .map(
        (v) =>
          `${v.label} — ${v.price}${v.minOrderQty > 1 ? ` (min order ${v.minOrderQty})` : ""} — ${
            v.inStock ? "in stock" : "OUT OF STOCK"
          }`
      )
      .join("; ");
  } catch (err) {
    console.error("fetchLiveProductPriceText failed:", err);
    return null;
  }
}

// Live delivery fee/minimum-order/COD-availability for a PIN code, straight
// from banglardoi.com's own /api/delivery/check — the SAME endpoint the
// checkout page's own pincode preview calls, and the same calculateDelivery()
// logic createOrderAction re-validates against server-side. Added Aug 2026 so
// AI Business OS's own, separately-configured DeliveryZone/DeliveryTier
// tables could be retired as the thing the AI actually quotes from (owner's
// own instruction: "delivery ta ekhon theke website follow korbe, 2ta thakle
// AI confused hoye jabe" — two sources of delivery truth was the risk, not
// just staleness). See lib/business-rules.ts for how this is used.
//
// This endpoint is intentionally public (no shared secret) on the
// banglardoi-app side, same as the browser's own checkout preview — nothing
// sensitive in a delivery-fee quote — so this call doesn't need the
// INTEGRATION_SHARED_SECRET banglarDoiFetch() always attaches; the extra
// header is simply ignored server-side.
//
// subtotalInPaise only affects which bracket the single `feeInPaise` number
// reflects — pass 0 when the customer's cart total isn't known yet (still
// returns a fully valid quote, e.g. the top/most-expensive bracket) and use
// the returned `feeTiers` schedule to show the full ladder instead.
export async function fetchBanglarDoiDeliveryCheck(
  pincode: string,
  subtotalInPaise: number
): Promise<BanglarDoiDeliveryQuote> {
  const data = await banglarDoiFetch(
    `/api/delivery/check?pincode=${encodeURIComponent(pincode)}&subtotal=${Math.max(0, Math.round(subtotalInPaise))}`
  );
  return {
    feeInPaise: data.feeInPaise,
    codAllowed: data.codAllowed,
    minOrderInPaise: data.minOrderInPaise,
    meetsMinOrder: data.meetsMinOrder,
    freeDeliveryThresholdInPaise: data.freeDeliveryThresholdInPaise ?? null,
    feeTiers: Array.isArray(data.feeTiers) ? data.feeTiers : [],
  };
}
