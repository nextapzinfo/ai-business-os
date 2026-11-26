import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { getVapid } from "@/lib/owner-notify";

export const dynamic = "force-dynamic";

// Phone notifications (2026-11-26). GET → the app's public push key;
// POST → save this phone/browser; DELETE → forget it.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { publicKey } = await getVapid();
  return NextResponse.json({ publicKey });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const sub = body?.subscription;
  const endpoint = String(sub?.endpoint || "");
  const p256dh = String(sub?.keys?.p256dh || "");
  const auth = String(sub?.keys?.auth || "");
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) return NextResponse.json({ error: "Bad subscription" }, { status: 400 });
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { endpoint, p256dh, auth, organizationId: user.organizationId, userId: user.id, userAgent: (req.headers.get("user-agent") || "").slice(0, 190) },
    update: { p256dh, auth, organizationId: user.organizationId, userId: user.id },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const endpoint = String(body?.endpoint || "");
  if (endpoint) await prisma.pushSubscription.deleteMany({ where: { endpoint, organizationId: user.organizationId } });
  return NextResponse.json({ ok: true });
}
