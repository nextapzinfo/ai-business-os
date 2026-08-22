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
  // Real estimate from banglardoi.com — the zone's own configured value, or
  // its DEFAULT_ESTIMATED_DELIVERY_DAYS fallback (currently 3 days) when the
  // zone didn't set one. Lets the AI state an actual delivery-time estimate
  // instead of inventing one.
  estimatedDeliveryDays: number;
  // false means this PIN didn't match any admin-configured Delivery Zone on
  // banglardoi.com — the numbers above are still a real, valid quote (the
  // website's own flat fallback rate), but nobody has actually confirmed we
  // deliver to this area. See lib/business-rules.ts for how this is used to
  // hand off to staff instead of quoting a fee for an unconfirmed area.
  zoneMatched: boolean;
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

// Structured full-catalog data — one call gets EVERY active product's real
// name/description/category and its FULL variant list (each variant's real
// label/price/compareAtPrice/min-max order quantity/stock — the same "2 Pc /
// 5 Pieces"-style pack pricing shown as buttons on the product page). Added
// 2026-08-20 at the owner's own instruction: "product r price o AI website
// ta follow korle aro bhalo hobe... no need knowledge base data for product
// priceing and min order qty" — this is what lets AI Business OS stop
// maintaining its own separately-typed copy of prices/min-orders entirely,
// the same duplication that already caused a real customer-facing mistake
// this session (a per-piece price shown next to a "5 pcs" label). Backed by
// banglardoi-app's /api/integrations/product-catalog (same shared-secret
// auth as the other integrations here).
export type BanglarDoiCatalogVariant = {
  label: string;
  price: string;
  compareAtPrice: string | null;
  minOrderQty: number;
  maxOrderQty: number | null;
  inStock: boolean;
};

// "What's inside this pack" — only non-empty for a Combo/Gift Box product
// (banglardoi-app's ProductBundleItem, added 2026-08-20 at the owner's own
// request: "Combo and Gift box r khetre multiple product aksathe rakte
// hobe .. tar jonno admin e kono option nei"). Lets the AI answer
// "combo-te ki ki ache?" with the real, admin-set contents instead of
// guessing or saying it doesn't know.
export type BanglarDoiBundleItem = {
  quantity: number;
  name: string;
  variantLabel: string | null;
};

export type BanglarDoiCatalogProduct = {
  name: string;
  slug: string;
  description: string | null;
  category: string | null;
  featured: boolean;
  bestSeller: boolean;
  pricePerPiece: string | null;
  variants: BanglarDoiCatalogVariant[];
  bundleItems: BanglarDoiBundleItem[];
};

export type BanglarDoiCatalogCategory = { name: string; slug: string; isSubcategory: boolean };

export type BanglarDoiCatalog = {
  products: BanglarDoiCatalogProduct[];
  categories: BanglarDoiCatalogCategory[];
};

// Every single WhatsApp reply now needs this (buildSystemPrompt's
// catalogNote — see lib/llm.ts), unlike the on-demand per-product lookup
// above, so an in-memory cache avoids hitting banglardoi.com on every
// customer message. Module-scoped, so it only helps within one warm
// serverless instance — a cold start just fetches fresh, which is fine
// (correctness never depends on the cache; it's a latency/load optimization
// only). 5 minutes comfortably keeps prices/stock fresh enough while
// cutting the vast majority of calls a busy conversation would otherwise
// make.
let catalogCache: { data: BanglarDoiCatalog; fetchedAt: number } | null = null;
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

export async function fetchBanglarDoiFullCatalog(): Promise<BanglarDoiCatalog | null> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return catalogCache.data;
  }
  try {
    const data = await banglarDoiFetch(`/api/integrations/product-catalog`);
    const catalog: BanglarDoiCatalog = {
      products: Array.isArray(data.products) ? data.products : [],
      categories: Array.isArray(data.categories) ? data.categories : [],
    };
    catalogCache = { data: catalog, fetchedAt: now };
    return catalog;
  } catch (err) {
    console.error("fetchBanglarDoiFullCatalog failed:", err);
    // Serve a stale cache rather than nothing, if one exists — a live
    // catalog a few minutes old is still far more trustworthy than falling
    // all the way back to the local DB's manually-retyped prices. Only
    // returns null (triggering the caller's local-DB fallback) on a true
    // cold failure with nothing cached yet at all.
    return catalogCache ? catalogCache.data : null;
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
    // Falls back to 3 (banglardoi-app's own DEFAULT_ESTIMATED_DELIVERY_DAYS)
    // on an older deployment that doesn't send this field yet.
    estimatedDeliveryDays: typeof data.estimatedDeliveryDays === "number" ? data.estimatedDeliveryDays : 3,
    // Defaults true (older banglardoi.com deployments before this field
    // existed always meant "a real zone" as far as this app knew) — only an
    // explicit `false` from the website should ever trigger the
    // area-not-confirmed handoff path.
    zoneMatched: data.zoneMatched !== false,
  };
}
