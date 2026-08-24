import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Reverse direction of the existing lib/banglardoi.ts integration (which
// calls FROM here TO banglardoi.com's own /api/integrations/order-status and
// /product-stock endpoints). This one receives events instead: banglardoi.com
// calls in here whenever a customer signs up (phone+OTP) or places an order,
// so the matching Client record in this app — if one exists, or a new one if
// not — gets tagged source: "WEBSITE" instead of defaulting to "WhatsApp
// direct". Added 2026-08-24 per the owner's request to track where every
// Client's phone number actually came from.
//
// Authenticated with the SAME shared secret as that existing integration
// (BANGLARDOI_INTEGRATION_SECRET here must equal banglardoi.com's own
// INTEGRATION_SHARED_SECRET) — deliberately reused rather than minting a
// second secret, since it's really just "the one shared secret these two
// apps already trust each other with," now used in both directions.
//
// Only one Organization uses this app today (same assumption
// lib/banglardoi.ts documents for the outbound side) — resolved via
// findFirst() rather than requiring a lookup key in the payload.
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const secret = process.env.BANGLARDOI_INTEGRATION_SECRET;
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { phone?: string; name?: string; eventType?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // banglardoi.com stores customer phone numbers as 10 digits, no country
  // code; this app's Client.phone matches WhatsApp's own format (full
  // digits WITH country code, e.g. "919831012345"). India-only business
  // today, so "91" is a safe, deliberate default prefix — matches the same
  // last-10-digit matching approach banglardoi.com's own order-status
  // endpoint already uses for the reverse lookup.
  const last10 = (body.phone ?? "").replace(/[^0-9]/g, "").slice(-10);
  if (last10.length !== 10) {
    return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });
  }
  const phone = `91${last10}`;

  const eventType = body.eventType === "ORDER" ? "ORDER" : "SIGNUP";
  const sourceDetail = eventType === "ORDER" ? "Placed an order on banglardoi.com" : "Signed up on banglardoi.com";
  const name = body.name?.trim() || undefined;

  const organization = await prisma.organization.findFirst();
  if (!organization) {
    return NextResponse.json({ error: "No organization configured" }, { status: 500 });
  }

  const existing = await prisma.client.findFirst({
    where: { organizationId: organization.id, phone },
  });

  if (existing) {
    // Only upgrade a still-default/organic attribution to WEBSITE — never
    // overwrite a more specific one (e.g. a Facebook/Instagram ad this
    // client already came in through, or a staff-entered MANUAL/IMPORTED
    // tag) just because they later visited the website too.
    if (existing.source === "WHATSAPP_DIRECT") {
      await prisma.client.update({
        where: { id: existing.id },
        data: {
          source: "WEBSITE",
          sourceDetail,
          // Only fill in a real name if we don't already have one — a
          // webhook-created Client with no WhatsApp profile name falls back
          // to its own phone number as `name`, so that's the "no real name
          // yet" signal.
          name: existing.name === existing.phone && name ? name : existing.name,
        },
      });
    }
    return NextResponse.json({ ok: true, clientId: existing.id, created: false });
  }

  const client = await prisma.client.create({
    data: {
      organizationId: organization.id,
      name: name || phone,
      phone,
      source: "WEBSITE",
      sourceDetail,
    },
  });

  return NextResponse.json({ ok: true, clientId: client.id, created: true });
}
