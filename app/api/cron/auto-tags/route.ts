import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { refreshOrgAutoTags } from "@/lib/auto-tags";
import { backfillChatTagsBatch } from "@/lib/chat-tags";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Called once a night by Vercel Cron (see vercel.json). Protected by
// CRON_SECRET, same pattern as every other cron in this app. Recalculates
// every customer's automatic CRM tags (lib/auto-tags.ts) — needed even when
// no new orders come in, because "Inactive" / "New" depend on how many days
// have passed. Also rebuilds chat tags from saved chat facts (e.g. "Price
// asked – not bought" expires after 90 days) and, as a safety net, reads a
// small batch of customers whose chat was never read yet.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orgs = await prisma.organization.findMany({ select: { id: true } });
  const results: Record<string, { checked: number; changed: number }> = {};
  for (const org of orgs) {
    try {
      results[org.id] = await refreshOrgAutoTags(org.id);
      await backfillChatTagsBatch(org.id, 12);
    } catch (err) {
      console.error("auto-tags cron failed for org", org.id, err);
    }
  }
  return NextResponse.json({ ok: true, results });
}
