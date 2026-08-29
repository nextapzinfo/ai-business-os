import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Sibling of ../customer-event/route.ts, added 2026-08-29 per the owner's
// request to see a customer's real banglardoi.com order history (not just
// a source tag) on their Client row — items/qty/price, order date, and
// current status. Called from banglardoi.com's createOrderAction
// (src/lib/ai-business-os-sync.ts, notifyAiBusinessOsOrderSync) right
// alongside the existing customer-event call, not instead of it — that one
// still owns "tag this Client's source as WEBSITE"; this one owns "attach
// the actual order data."
//
// A DEDICATED endpoint rather than folding order fields onto
// customer-event's payload: that endpoint is also called from a plain
// signup (verifyOtp) with zero order data, and every event it currently
// carries (phone/name/eventType) exists for BOTH signup and order events —
// stuffing optional order-only fields onto it would blur that. Keeping this
// separate also means a later status-update push (order shipped, etc.) is
// simply another POST here, without re-sending or re-validating signup-only
// concerns.
//
// Authenticated with the SAME shared secret as every other banglardoi.com
// <-> ai-business-os integration (BANGLARDOI_INTEGRATION_SECRET here must
// equal banglardoi.com's own INTEGRATION_SHARED_SECRET).
//
// Only one Organization uses this app today (same assumption
// customer-event/route.ts documents) — resolved via findFirst() rather
// than requiring a lookup key in the payload.
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const secret = process.env.BANGLARDOI_INTEGRATION_SECRET;
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    phone?: string;
    name?: string;
    orderNumber?: string;
    status?: string;
    totalInRupees?: number;
    placedAt?: string;
    items?: {
      productName?: string;
      variantLabel?: string | null;
      quantity?: number;
      unitPriceInRupees?: number;
      totalPriceInRupees?: number;
    }[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Same last-10-digit + "91" prefix normalization as customer-event/route.ts
  // — banglardoi.com stores 10-digit-no-country-code, this app's Client.phone
  // matches WhatsApp's own full-digits-with-country-code format.
  const last10 = (body.phone ?? "").replace(/[^0-9]/g, "").slice(-10);
  if (last10.length !== 10) {
    return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });
  }
  const phone = `91${last10}`;

  const orderNumber = (body.orderNumber ?? "").trim();
  const status = (body.status ?? "").trim();
  const totalInRupees = Number(body.totalInRupees);
  const placedAtRaw = body.placedAt ? new Date(body.placedAt) : null;
  if (
    !orderNumber ||
    !status ||
    !Number.isFinite(totalInRupees) ||
    !placedAtRaw ||
    Number.isNaN(placedAtRaw.getTime()) ||
    !Array.isArray(body.items)
  ) {
    return NextResponse.json({ error: "Missing/invalid order fields" }, { status: 400 });
  }

  // Drop malformed rows rather than rejecting the whole order — a single
  // bad line item shouldn't lose the rest of an otherwise-real order.
  const items = body.items
    .filter(
      (i): i is { productName: string; variantLabel?: string | null; quantity: number; unitPriceInRupees: number; totalPriceInRupees: number } =>
        typeof i?.productName === "string" &&
        i.productName.trim().length > 0 &&
        Number.isFinite(i?.quantity) &&
        Number.isFinite(i?.unitPriceInRupees) &&
        Number.isFinite(i?.totalPriceInRupees)
    )
    .map((i) => ({
      productName: i.productName,
      variantLabel: i.variantLabel ?? null,
      quantity: i.quantity,
      unitPriceInRupees: i.unitPriceInRupees,
      totalPriceInRupees: i.totalPriceInRupees,
    }));

  const name = body.name?.trim() || undefined;

  const organization = await prisma.organization.findFirst();
  if (!organization) {
    return NextResponse.json({ error: "No organization configured" }, { status: 500 });
  }

  // Find-or-create the Client, same shape as customer-event/route.ts —
  // duplicated rather than shared because this route must still work (and
  // create a home for the order) even in the rare case its sibling
  // customer-event call failed/raced. Deliberately does NOT re-tag an
  // existing Client's source here — customer-event/route.ts owns that
  // decision; this route only sets source on a brand-new Client it has to
  // create itself.
  let client = await prisma.client.findFirst({
    where: { organizationId: organization.id, phone },
  });
  if (!client) {
    client = await prisma.client.create({
      data: {
        organizationId: organization.id,
        name: name || phone,
        phone,
        source: "WEBSITE",
        sourceDetail: "Placed an order on banglardoi.com",
      },
    });
  }

  const clientOrder = await prisma.clientOrder.upsert({
    where: { orderNumber },
    update: {
      clientId: client.id,
      organizationId: organization.id,
      status,
      totalInRupees,
      placedAt: placedAtRaw,
      itemsJson: items,
    },
    create: {
      organizationId: organization.id,
      clientId: client.id,
      orderNumber,
      status,
      totalInRupees,
      placedAt: placedAtRaw,
      itemsJson: items,
    },
  });

  return NextResponse.json({ ok: true, clientOrderId: clientOrder.id, clientId: client.id });
}
