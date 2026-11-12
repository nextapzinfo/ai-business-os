import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Banglar Doi OS (the WordPress "Business OS" plugin at app.banglardoi.com)
// → AI Business OS. Added 2026-11-12 for the Event Shop / QR ordering:
// every customer who scans a stall QR and gives their WhatsApp number is
// saved here with the event's name, and every confirmed event bill is
// recorded on their CRM profile and sent to their WhatsApp.
//
// Auth: "Authorization: Bearer <secret>". The secret is BMS_INTEGRATION_SECRET
// (set the same value in Banglar Doi OS → Event Shop → Settings). If that env
// var isn't set, the existing BANGLARDOI_INTEGRATION_SECRET is accepted too,
// so it works with what's already configured on Vercel.
export function bmsAuthorized(req: NextRequest): boolean {
  const header = req.headers.get("authorization") ?? "";
  const secrets = [process.env.BMS_INTEGRATION_SECRET, process.env.BANGLARDOI_INTEGRATION_SECRET].filter(
    (s): s is string => !!s && s.length >= 8
  );
  return secrets.some((s) => header === `Bearer ${s}`);
}

// Banglar Doi OS sends "91" + 10 digits; normalise anything to that shape.
export function normalizeIndianPhone(raw: unknown): string | null {
  const last10 = String(raw ?? "").replace(/[^0-9]/g, "").slice(-10);
  return /^[6-9]\d{9}$/.test(last10) ? `91${last10}` : null;
}

export function eventTag(eventName: string): string | null {
  const name = eventName.replace(/\s+/g, " ").trim().slice(0, 60);
  return name ? `Event: ${name}` : null;
}

// Find the customer or create them (source EVENT). Never downgrades a more
// specific source an existing customer already has (Facebook ad, website…);
// only a plain WhatsApp-direct customer is re-labelled. Adds the event name as
// a normal tag so staff can filter / broadcast to "everyone from this mela".
export async function upsertEventClient(opts: { phone: string; name?: string; eventName?: string }) {
  const organization = await prisma.organization.findFirst();
  if (!organization) throw new Error("No organization configured");
  const name = opts.name?.trim() || undefined;
  const tag = opts.eventName ? eventTag(opts.eventName) : null;
  const detail = opts.eventName ? `Scanned the stall QR at ${opts.eventName.trim()}` : "Scanned an event stall QR";

  const existing = await prisma.client.findFirst({ where: { organizationId: organization.id, phone: opts.phone } });
  if (existing) {
    const tags = tag && !existing.tags.includes(tag) ? [...existing.tags, tag] : existing.tags;
    const client = await prisma.client.update({
      where: { id: existing.id },
      data: {
        tags,
        ...(existing.source === "WHATSAPP_DIRECT" ? { source: "EVENT", sourceDetail: detail } : {}),
        name: existing.name === existing.phone && name ? name : existing.name,
      },
    });
    return { organization, client, created: false };
  }
  const client = await prisma.client.create({
    data: {
      organizationId: organization.id,
      name: name || opts.phone,
      phone: opts.phone,
      source: "EVENT",
      sourceDetail: detail,
      tags: tag ? [tag] : [],
    },
  });
  return { organization, client, created: true };
}
