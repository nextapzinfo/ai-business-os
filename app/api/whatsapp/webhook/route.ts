import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { embedText, toVectorLiteral } from "@/lib/embeddings";
import { askAI } from "@/lib/llm";
import { sendWhatsAppMessage, sendWhatsAppImageMessage } from "@/lib/whatsapp";
import { logAudit } from "@/lib/audit";
import { appendSheetRow } from "@/lib/googleSheets";

// Meta calls this once when the webhook URL is configured, to verify ownership.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200 });
  }

  return new NextResponse("Forbidden", { status: 403 });
}

// Meta calls this every time a message (or status update) happens on the connected number.
export async function POST(req: NextRequest) {
  const body = await req.json();

  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const phoneNumberId = value?.metadata?.phone_number_id;
    const message = value?.messages?.[0];

    // Ignore anything that isn't an inbound text message (delivery/read status updates, etc.)
    if (!message || message.type !== "text" || !phoneNumberId) {
      return NextResponse.json({ status: "ignored" });
    }

    const from = message.from as string; // sender's WhatsApp number
    const text = message.text.body as string;
    const contactName = value.contacts?.[0]?.profile?.name ?? from;

    const organization = await prisma.organization.findUnique({
      where: { whatsappPhoneNumberId: phoneNumberId },
    });

    if (!organization) {
      console.error("No organization matches WhatsApp phone_number_id:", phoneNumberId);
      return NextResponse.json({ status: "no-org" });
    }

    const agentProfile = await prisma.agentProfile.findUnique({
      where: { organizationId: organization.id },
    });

    let client = await prisma.client.findFirst({
      where: { organizationId: organization.id, phone: from },
    });
    if (!client) {
      client = await prisma.client.create({
        data: {
          organizationId: organization.id,
          name: contactName,
          phone: from,
        },
      });

      // Log every brand-new WhatsApp customer to a Google Sheet, if configured,
      // so Banglar Doi always has an up-to-date customer log in a format they
      // already use (optional — silently skipped if the env vars aren't set).
      const newCustomersSheetId = process.env.NEW_CUSTOMERS_SHEET_ID;
      const newCustomersSheetRange = process.env.NEW_CUSTOMERS_SHEET_RANGE;
      if (newCustomersSheetId && newCustomersSheetRange) {
        try {
          await appendSheetRow(newCustomersSheetId, newCustomersSheetRange, [
            contactName,
            from,
            "WhatsApp",
            new Date().toISOString(),
          ]);
        } catch (err) {
          console.error("New customer Sheet append failed:", err);
        }
      }
    }

    let conversation = await prisma.conversation.findFirst({
      where: {
        organizationId: organization.id,
        clientId: client.id,
        channel: "WHATSAPP",
        status: "OPEN",
      },
    });
    let isNewConversation = false;
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          organizationId: organization.id,
          clientId: client.id,
          channel: "WHATSAPP",
          status: "OPEN",
        },
      });
      isNewConversation = true;
    }

    await prisma.message.create({
      data: { conversationId: conversation.id, sender: "CLIENT", content: text },
    });

    // First message of a brand-new conversation: send the configured greeting
    // (if any) word-for-word before the AI's normal RAG-based answer.
    if (isNewConversation && agentProfile?.greetingMessage?.trim()) {
      try {
        await sendWhatsAppMessage(from, agentProfile.greetingMessage.trim());
        await prisma.message.create({
          data: { conversationId: conversation.id, sender: "AI", content: agentProfile.greetingMessage.trim() },
        });
      } catch (err) {
        console.error("Greeting message send failed:", err);
      }
    }

    // If staff has "intervened" on this conversation (sent a manual reply), the AI
    // stays silent so it doesn't talk over a human agent — staff must resume it
    // from the dashboard. The client's message is still logged above either way.
    if (conversation.aiPaused) {
      await logAudit({
        organizationId: organization.id,
        action: "WHATSAPP_MESSAGE_RECEIVED_AI_PAUSED",
        metadata: { clientId: client.id, question: text },
      });
      return NextResponse.json({ status: "ai-paused" });
    }

    // Payment QR skill: a lightweight keyword trigger (not full AI function-calling
    // yet) — if enabled and a QR image has been uploaded in Agent Studio, send that
    // exact fixed image whenever the customer's message looks payment-related.
    const QR_TRIGGER_REGEX = /\b(qr|payment|pay|upi)\b|টাকা|পেমেন্ট|কিউআর|পে\s*করব/i;
    if (agentProfile?.skillSendQr && agentProfile.qrCodeUrl && QR_TRIGGER_REGEX.test(text)) {
      try {
        await sendWhatsAppImageMessage(from, agentProfile.qrCodeUrl, "Payment QR Code");
        const qrCaption = "এই QR কোড স্ক্যান করে পেমেন্ট করতে পারেন।";
        await sendWhatsAppMessage(from, qrCaption);
        await prisma.message.create({
          data: { conversationId: conversation.id, sender: "AI", content: `[Sent payment QR code] ${qrCaption}` },
        });
        await logAudit({
          organizationId: organization.id,
          action: "WHATSAPP_QR_SENT",
          metadata: { clientId: client.id },
        });
        return NextResponse.json({ status: "qr-sent" });
      } catch (err) {
        console.error("QR send failed:", err);
        // fall through to the normal RAG answer if sending the QR fails
      }
    }

    const queryEmbedding = await embedText(text, "query");
    const vectorLiteral = toVectorLiteral(queryEmbedding);

    const results = (await prisma.$queryRaw`
      SELECT dc.content as content, d.title as "documentTitle", d.id as "documentId",
             (dc.embedding <=> ${vectorLiteral}::vector) as distance
      FROM "DocumentChunk" dc
      JOIN "Document" d ON d.id = dc."documentId"
      WHERE dc."organizationId" = ${organization.id}
      ORDER BY dc.embedding <=> ${vectorLiteral}::vector ASC
      LIMIT 5
    `) as { content: string; documentTitle: string; documentId: string; distance: number }[];

    let answer: string;
    if (results.length === 0) {
      answer =
        "Thanks for your message — we don't have an answer ready for that yet, our team will get back to you shortly.";
    } else {
      answer = await askAI(
        text,
        results.map((r) => ({ title: r.documentTitle, content: r.content })),
        agentProfile ?? undefined
      );
    }

    await prisma.message.create({
      data: { conversationId: conversation.id, sender: "AI", content: answer },
    });

    await sendWhatsAppMessage(from, answer);

    // If the top-matching source is a Retail Product with a photo, send it too —
    // but only when that top match is actually close enough to be relevant.
    // Vector search always returns *something* from the top 5, even for questions
    // with no real match (e.g. "Balun" when no such product exists); without this
    // check, the closest-but-irrelevant product's photo would get attached to an
    // answer where the AI correctly said "I don't know".
    const PRODUCT_PHOTO_DISTANCE_THRESHOLD = 0.35; // lower = stricter match required; tune from real usage
    if (results.length > 0 && results[0].distance <= PRODUCT_PHOTO_DISTANCE_THRESHOLD) {
      try {
        const product = await prisma.product.findUnique({
          where: { documentId: results[0].documentId },
        });
        if (product?.imageUrl) {
          await sendWhatsAppImageMessage(from, product.imageUrl, product.name);
        }
      } catch (err) {
        console.error("Product image send failed:", err);
      }
    }

    await logAudit({
      organizationId: organization.id,
      action: "WHATSAPP_MESSAGE_ANSWERED",
      metadata: { clientId: client.id, question: text },
    });

    return NextResponse.json({ status: "ok" });
  } catch (err) {
    console.error("WhatsApp webhook processing failed:", err);
    // Always return 200 so Meta doesn't retry-storm us over our own bugs.
    return NextResponse.json({ status: "error" });
  }
}
