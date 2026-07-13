import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveDailyRange, istDayKey } from "@/lib/billingRange";

// Excel-compatible CSV (not a true .xlsx) — that's all a "download the daily
// numbers" need requires, and it avoids pulling in a spreadsheet-writing
// dependency for a small, low-risk export. Mirrors exactly what the Daily
// Summary table on the Billing page shows for the same range, in INR.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const organizationId = session?.user?.organizationId;
  if (!organizationId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const range = searchParams.get("range") || "today";
  const from = searchParams.get("from") || undefined;
  const to = searchParams.get("to") || undefined;

  const [org, daily] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId } }),
    Promise.resolve(resolveDailyRange({ range, from, to })),
  ]);
  if (!org) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const [aiLogs, waLogs] = await Promise.all([
    prisma.aiUsageLog.findMany({
      where: { organizationId, createdAt: { gte: daily.from, lt: daily.to } },
      select: { costUsd: true, createdAt: true },
    }),
    prisma.whatsAppCostLog.findMany({
      where: { organizationId, createdAt: { gte: daily.from, lt: daily.to } },
      select: { costUsd: true, kind: true, createdAt: true },
    }),
  ]);

  const buckets: Record<string, { openai: number; template: number; conversation: number }> = {};
  for (const key of daily.dayKeys) buckets[key] = { openai: 0, template: 0, conversation: 0 };
  for (const log of aiLogs) {
    const key = istDayKey(log.createdAt);
    if (buckets[key]) buckets[key].openai += log.costUsd;
  }
  for (const log of waLogs) {
    const key = istDayKey(log.createdAt);
    if (!buckets[key]) continue;
    if (log.kind === "CONVERSATION") buckets[key].conversation += log.costUsd;
    else buckets[key].template += log.costUsd;
  }

  const rate = org.usdToInrRate;
  const rows = [["Date", "OpenAI Cost (INR)", "WhatsApp Template Cost (INR)", "WhatsApp Conversation Cost (INR)", "Total AI Cost (INR)"]];
  let totalOpenai = 0;
  let totalTemplate = 0;
  let totalConversation = 0;

  for (const key of daily.dayKeys) {
    const b = buckets[key];
    const total = b.openai + b.template + b.conversation;
    totalOpenai += b.openai;
    totalTemplate += b.template;
    totalConversation += b.conversation;
    rows.push([
      key,
      (b.openai * rate).toFixed(2),
      (b.template * rate).toFixed(2),
      (b.conversation * rate).toFixed(2),
      (total * rate).toFixed(2),
    ]);
  }
  rows.push([
    "Total",
    (totalOpenai * rate).toFixed(2),
    (totalTemplate * rate).toFixed(2),
    (totalConversation * rate).toFixed(2),
    ((totalOpenai + totalTemplate + totalConversation) * rate).toFixed(2),
  ]);

  const csv = rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="billing-${daily.dayKeys[0]}_to_${daily.dayKeys[daily.dayKeys.length - 1]}.csv"`,
    },
  });
}
