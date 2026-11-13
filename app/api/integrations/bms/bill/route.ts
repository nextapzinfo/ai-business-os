import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { bmsAuthorized, normalizeIndianPhone, upsertEventClient } from "@/lib/bms-integration";
import { refreshClientAutoTags } from "@/lib/auto-tags";
import { sendWhatsAppMessage, sendWhatsAppTemplateMessage } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

// Banglar Doi OS Event Shop: the counter confirmed a QR order, so a real POS
// bill now exists. This route
//   1. records it on the customer's CRM profile (ClientOrder, channel EVENT —
//      counts toward spend, VIP/Regular auto-tags, etc.), and
//   2. sends the bill to their WhatsApp:
//      - as a normal text message if they've messaged us in the last 24 h
//        (free, and allowed by WhatsApp), otherwise
//      - with the approved template named by Banglar Doi OS (Event Shop →
//        Settings → "WhatsApp bill template name"). Template variables, in
//        order: {{1}} name, {{2}} event, {{3}} invoice no, {{4}} total,
//        {{5}} bill link — a template may use fewer; the first N are sent.
// Replies { ok, sent: "text" | "template" | "skipped", reason? } so the
// Counter screen can show whether the customer got it.

type BillItem = { name?: string; quantity?: number; price?: number; total?: number };

function rupees(n: number): string {
  return `₹${Math.round(n * 100) / 100}`.replace(/\.0+$/, "");
}

function qty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

export async function POST(req: NextRequest) {
  if (!bmsAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    phone?: string;
    name?: string;
    invoiceNo?: string;
    orderNo?: string;
    total?: number;
    paymentMethod?: string;
    eventName?: string;
    billUrl?: string;
    reviewUrl?: string;
    placedAt?: string;
    items?: BillItem[];
    template?: string;
    templateLanguage?: string;
    // false = only record the sale in the CRM (sent at Confirm); the
    // customer's own "Send bill to my WhatsApp" tap calls again with true.
    // Owner 2026-11-13: WhatsApp bill is optional, the permanent copy lives
    // in their banglardoi.com account.
    sendWhatsApp?: boolean;
    // "delete": the bill was deleted in Banglar Doi OS (e.g. a test bill).
    action?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.action === "delete") {
    const invoice = (body.invoiceNo ?? "").trim();
    if (!invoice) return NextResponse.json({ error: "Missing invoiceNo" }, { status: 400 });
    const existing = await prisma.clientOrder.findFirst({ where: { orderNumber: invoice, channel: "EVENT" }, select: { id: true, clientId: true } });
    if (existing) {
      await prisma.clientOrder.delete({ where: { id: existing.id } });
      if (existing.clientId) await refreshClientAutoTags(existing.clientId);
    }
    return NextResponse.json({ ok: true, deleted: existing ? 1 : 0 });
  }

  const phone = normalizeIndianPhone(body.phone);
  const invoiceNo = (body.invoiceNo ?? "").trim();
  const total = Number(body.total);
  if (!phone || !invoiceNo || !Number.isFinite(total)) {
    return NextResponse.json({ error: "Missing/invalid bill fields" }, { status: 400 });
  }
  const eventName = (body.eventName ?? "").trim();
  const placedAt = body.placedAt && !Number.isNaN(new Date(body.placedAt).getTime()) ? new Date(body.placedAt) : new Date();
  const items = (Array.isArray(body.items) ? body.items : [])
    .filter((i) => typeof i?.name === "string" && i.name.trim() && Number.isFinite(Number(i.quantity)))
    .map((i) => ({
      productName: String(i.name).trim(),
      variantLabel: null,
      quantity: Number(i.quantity),
      unitPriceInRupees: Number(i.price) || 0,
      totalPriceInRupees: Number(i.total) || 0,
    }));

  const { organization, client } = await upsertEventClient({ phone, name: body.name, eventName });

  // 1. CRM record (idempotent on the invoice number).
  await prisma.clientOrder.upsert({
    where: { orderNumber: invoiceNo },
    update: { clientId: client.id, status: "DELIVERED", totalInRupees: total, placedAt, itemsJson: items, channel: "EVENT" },
    create: {
      organizationId: organization.id,
      clientId: client.id,
      orderNumber: invoiceNo,
      status: "DELIVERED",
      totalInRupees: total,
      placedAt,
      itemsJson: items,
      channel: "EVENT",
    },
  });
  await refreshClientAutoTags(client.id);

  if (body.sendWhatsApp === false) {
    return NextResponse.json({ ok: true, sent: "skipped", reason: "not_requested" });
  }

  // 2. WhatsApp bill.
  const firstName = (body.name ?? "").trim() || (client.name !== client.phone ? client.name : "") || "Customer";
  const billUrl = (body.billUrl ?? "").trim();
  const lines = items.map((i) => `• ${i.productName} × ${qty(i.quantity)} = ${rupees(i.totalPriceInRupees)}`).join("\n");
  const text = [
    `🧾 *Banglar Doi — Bill*`,
    eventName ? `📍 ${eventName}` : null,
    `Invoice: ${invoiceNo}${body.orderNo ? ` (Order ${body.orderNo})` : ""}`,
    "",
    lines,
    "",
    `*Total: ${rupees(total)}* · Paid by ${body.paymentMethod === "online" ? "UPI" : "Cash"}`,
    billUrl ? `\nFull bill: ${billUrl}` : null,
    `All your Banglar Doi purchases: https://www.banglardoi.com/account`,
    body.reviewUrl ? `\n⭐ Enjoyed it? Please leave us a Google review: ${body.reviewUrl}` : null,
    `\nThank you, ${firstName}! Please visit again 🙏`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  let conversation = await prisma.conversation.findFirst({
    where: { organizationId: organization.id, clientId: client.id },
    orderBy: { createdAt: "desc" },
  });
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentInbound = await prisma.message.findFirst({
    where: { conversation: { clientId: client.id }, sender: "CLIENT", createdAt: { gte: since } },
    select: { id: true },
  });

  let sent: "text" | "template" | "skipped" = "skipped";
  let reason: string | undefined;
  try {
    if (recentInbound) {
      await sendWhatsAppMessage(phone, text);
      sent = "text";
    } else {
      const templateName = (body.template ?? "").trim();
      if (!templateName) {
        reason = "no_template";
      } else {
        const template = await prisma.messageTemplate.findFirst({
          where: { organizationId: organization.id, metaTemplateName: templateName },
          orderBy: { updatedAt: "desc" },
        });
        if (template && template.status !== "APPROVED") {
          reason = "template_not_approved";
        } else {
          const values = [firstName, eventName || "Banglar Doi", invoiceNo, rupees(total), billUrl || invoiceNo];
          const needed = template ? Math.max(0, ...[...template.bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]))) : 5;
          await sendWhatsAppTemplateMessage(
            phone,
            templateName,
            template?.language || body.templateLanguage || "en",
            values.slice(0, needed),
            template?.headerType === "IMAGE" ? template.headerImageUrl ?? undefined : undefined
          );
          sent = "template";
        }
      }
    }
  } catch (err) {
    console.error("BMS bill WhatsApp send failed", err);
    return NextResponse.json({ ok: true, sent: "error", reason: "whatsapp_failed" });
  }

  // Show it in the Inbox too, so staff see what the customer received.
  if (sent !== "skipped") {
    if (!conversation) {
      conversation = await prisma.conversation.create({ data: { organizationId: organization.id, clientId: client.id } });
    }
    await prisma.message.create({
      data: { conversationId: conversation.id, sender: "AI", content: sent === "text" ? text : `[Bill template sent] ${invoiceNo} · ${rupees(total)}` },
    });
  }

  return NextResponse.json({ ok: true, sent, ...(reason ? { reason } : {}) });
}
