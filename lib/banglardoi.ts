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
