import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendWhatsAppMessage, sendWhatsAppTemplateMessage } from "@/lib/whatsapp";
import { addDays, istToday, syncBizRange, dailyBriefText, bmsSyncConfigured, rupees } from "@/lib/biz-analyst";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Business Analyst daily job (2026-11-20), 08:00 India time (vercel.json):
// 1. copy the last 3 days from Banglar Doi OS (late closings / edits flow in),
// 2. send the owner his morning sales brief on WhatsApp (owner's number from
//    Agent Studio → Owner Assistant). WhatsApp allows free text only if the
//    owner messaged in the last 24 h; otherwise the approved template chosen
//    on the Business Analyst page is used ({{1}} yesterday, {{2}} month so
//    far, {{3}} % of target). With neither, the brief is skipped (the owner
//    can always ask "kal er report" on WhatsApp).
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!bmsSyncConfigured()) return NextResponse.json({ ok: false, reason: "BMS_INTEGRATION_SECRET not set" });

  const org = await prisma.organization.findFirst();
  if (!org) return NextResponse.json({ ok: false, reason: "no organization" });

  const yesterday = addDays(istToday(), -1);
  let sync: unknown = null;
  try {
    sync = await syncBizRange(org.id, addDays(yesterday, -2), yesterday, 35_000);
  } catch (err) {
    console.error("Business analyst sync failed", err);
    return NextResponse.json({ ok: false, reason: "sync_failed", error: String(err) });
  }

  const settings = await prisma.bizSettings.findUnique({ where: { organizationId: org.id } });
  if (settings && !settings.briefEnabled) return NextResponse.json({ ok: true, sync, brief: "disabled" });

  const profile = await prisma.agentProfile.findFirst({ where: { organizationId: org.id, ownerAssistantPhone: { not: null } } });
  const phone = profile?.ownerAssistantPhone?.replace(/\D/g, "");
  if (!phone) return NextResponse.json({ ok: true, sync, brief: "no_owner_phone" });
  const to = phone.length === 10 ? `91${phone}` : phone;

  const brief = await dailyBriefText(org.id, yesterday);
  const lastOwnerMsg = await prisma.message.findFirst({
    where: { sender: "CLIENT", conversation: { organizationId: org.id, channel: "OWNER_ASSISTANT" } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const windowOpen = lastOwnerMsg && Date.now() - lastOwnerMsg.createdAt.getTime() < 23.5 * 3600 * 1000;

  try {
    if (windowOpen) {
      await sendWhatsAppMessage(to, brief.text + "\n\n_Ask me anything: \"kon product beshi cholche?\", \"Patuli te labh koto?\"_");
      return NextResponse.json({ ok: true, sync, brief: "text" });
    }
    if (settings?.briefTemplateName) {
      const tpl = await prisma.messageTemplate.findFirst({
        where: { organizationId: org.id, metaTemplateName: settings.briefTemplateName, status: "APPROVED" },
      });
      if (tpl) {
        const values = [
          rupees(brief.totalSales),
          rupees(brief.month.achieved),
          brief.month.percent !== null ? `${brief.month.percent}%` : "no target set",
        ];
        const placeholders = (tpl.bodyText.match(/\{\{\d+\}\}/g) || []).length;
        await sendWhatsAppTemplateMessage(to, tpl.metaTemplateName, tpl.language, values.slice(0, placeholders));
        return NextResponse.json({ ok: true, sync, brief: "template" });
      }
    }
    return NextResponse.json({ ok: true, sync, brief: "skipped_no_window_no_template" });
  } catch (err) {
    console.error("Business analyst brief failed", err);
    return NextResponse.json({ ok: true, sync, brief: "send_failed" });
  }
}
