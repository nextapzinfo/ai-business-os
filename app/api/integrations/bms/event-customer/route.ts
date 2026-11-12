import { NextRequest, NextResponse } from "next/server";
import { bmsAuthorized, normalizeIndianPhone, upsertEventClient } from "@/lib/bms-integration";

export const dynamic = "force-dynamic";

// Banglar Doi OS Event Shop: a customer scanned a stall QR and entered their
// WhatsApp number. Save them (source EVENT, tag "Event: <event name>").
export async function POST(req: NextRequest) {
  if (!bmsAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { phone?: string; name?: string; eventName?: string; zoneName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const phone = normalizeIndianPhone(body.phone);
  if (!phone) return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });
  const { client, created } = await upsertEventClient({ phone, name: body.name, eventName: body.eventName });
  return NextResponse.json({ ok: true, clientId: client.id, created });
}
