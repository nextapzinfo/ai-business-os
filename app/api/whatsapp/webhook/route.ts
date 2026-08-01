import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { embedText, toVectorLiteral } from "@/lib/embeddings";
import {
  askAIWithTools,
  SAVE_ADDRESS_TOOL,
  SET_REMINDER_TOOL,
  RECORD_INTEREST_TOOL,
  PLACE_ORDER_TOOL,
  REQUEST_HANDOFF_TOOL,
  SEND_PRODUCT_PHOTO_TOOL,
  applyTerminologySwaps,
  type ToolDefinition,
  type ChatHistoryMessage,
} from "@/lib/llm";
import {
  sendWhatsAppMessage,
  sendWhatsAppImageMessage,
  sendWhatsAppProductMessage,
  sendWhatsAppProductListMessage,
  downloadWhatsAppMedia,
} from "@/lib/whatsapp";
import { logAudit } from "@/lib/audit";
import { appendSheetRow } from "@/lib/googleSheets";
import { logAiUsage } from "@/lib/billing";
import { put } from "@vercel/blob";

// Turns Meta's structured location payload ({latitude, longitude, name?, address?})
// into a readable text line — this is what gets logged as the Message and fed to
// the AI, and it includes a plain Google Maps link so staff can tap/click straight
// through to it (MessageThread auto-linkifies URLs in message content).
function formatLocationMessage(location: {
  latitude?: number;
  longitude?: number;
  name?: string;
  address?: string;
}): string {
  if (!location || typeof location.latitude !== "number" || typeof location.longitude !== "number") {
    return "";
  }
  const label = [location.name, location.address].filter(Boolean).join(", ");
  const mapsUrl = `https://maps.google.com/?q=${location.latitude},${location.longitude}`;
  return `📍 Shared location${label ? `: ${label}` : ""}\n${mapsUrl}`;
}

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

    // Ignore delivery/read status updates and anything else we don't handle.
    // "text" = a normal typed message. "button" = a customer tapped a Quick
    // Reply button on a template we broadcast (e.g. "Order Now") — Meta sends
    // this as its own message type, not "text", so it needs handling here too
    // or it silently vanishes: no conversation log, no AI reply. "location" =
    // customer shared a location pin (e.g. for home delivery) — same deal,
    // Meta sends lat/lng as structured data, not text, so without this it was
    // being silently dropped too (never logged, never seen by the AI).
    if (
      !message ||
      !phoneNumberId ||
      (message.type !== "text" &&
        message.type !== "button" &&
        message.type !== "location" &&
        message.type !== "image" &&
        message.type !== "order")
    ) {
      return NextResponse.json({ status: "ignored" });
    }

    const from = message.from as string; // sender's WhatsApp number
    const isImage = message.type === "image";
    // "order" = customer hit "Send order" on a WhatsApp Catalog cart review
    // screen (built from Interactive Product Messages we sent — see
    // sendWhatsAppProductMessage). Structured event, no free text attached.
    const isOrder = message.type === "order";
    const text =
      isImage || isOrder
        ? ""
        : message.type === "button"
        ? (message.button?.text as string)
        : message.type === "location"
        ? formatLocationMessage(message.location)
        : (message.text.body as string);
    if (!isImage && !isOrder && !text) {
      return NextResponse.json({ status: "ignored" });
    }
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

    // Customer sent a photo — most commonly a payment screenshot for staff to
    // verify (manual-confirm flow, no payment gateway). This never goes
    // through RAG/AI question-answering (there's no text to search against);
    // it's just stored so it shows up in Conversations for a human to look at,
    // plus a short FIXED acknowledgment (not an OpenAI call — no point paying
    // for a reply here) so the customer knows it was received.
    if (isImage) {
      const mediaId = message.image?.id as string | undefined;
      let imageUrl: string | null = null;
      if (mediaId) {
        try {
          const { buffer, contentType } = await downloadWhatsAppMedia(mediaId);
          const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
          const blob = await put(
            `customer-uploads/${organization.id}/${conversation.id}-${Date.now()}.${ext}`,
            buffer,
            { access: "public", contentType, addRandomSuffix: true }
          );
          imageUrl = blob.url;
        } catch (err) {
          console.error("Failed to download/store customer image:", err);
        }
      }

      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          sender: "CLIENT",
          content: (message.image?.caption as string) || "📷 Photo",
          imageUrl,
        },
      });

      if (!conversation.aiPaused) {
        const ackText = "আপনার ছবি/স্ক্রিনশট পেয়েছি। আমাদের টিম শীঘ্রই যাচাই করে জানাবে। ধন্যবাদ!";
        try {
          await sendWhatsAppMessage(from, ackText);
          await prisma.message.create({
            data: { conversationId: conversation.id, sender: "AI", content: ackText },
          });
        } catch (err) {
          console.error("Image ack send failed:", err);
        }
      }

      await logAudit({
        organizationId: organization.id,
        action: "WHATSAPP_IMAGE_RECEIVED",
        metadata: { clientId: client.id, hasImageUrl: !!imageUrl },
      });

      return NextResponse.json({ status: "image-received" });
    }

    // Customer completed a WhatsApp Catalog cart checkout ("Send order" from
    // the cart review screen). Meta hands us the exact items + prices it
    // pulled from the connected Commerce Manager catalog at that moment — we
    // use those, not our own Product.price (which is free-text and can't be
    // trusted for math). Structured event, never goes through AI/RAG.
    if (isOrder) {
      const orderPayload = message.order as {
        catalog_id?: string;
        // Meta's webhook payload sends quantity/item_price as either numbers
        // or numeric strings depending on version — Number() handles both.
        product_items?: { product_retailer_id: string; quantity: number | string; item_price: number | string; currency?: string }[];
        text?: string;
      };
      const productItems = orderPayload?.product_items ?? [];

      const retailerIds = productItems.map((it) => it.product_retailer_id).filter(Boolean);
      const matchedProducts = retailerIds.length
        ? await prisma.product.findMany({
            where: { organizationId: organization.id, retailerId: { in: retailerIds } },
          })
        : [];
      const productByRetailerId = new Map(matchedProducts.map((p) => [p.retailerId, p]));

      let subtotal = 0;
      const lineLines: string[] = [];
      for (const item of productItems) {
        const qty = Number(item.quantity) || 0;
        const price = Number(item.item_price) || 0;
        const lineTotal = price * qty;
        subtotal += lineTotal;
        const name = productByRetailerId.get(item.product_retailer_id)?.name || item.product_retailer_id;
        lineLines.push(`${qty} x ${name} — ৳${price} = ৳${lineTotal}`);
      }
      const shippingCharge = organization.shippingCharge ?? 0;
      const totalAmount = subtotal + shippingCharge;
      const itemsSummary = lineLines.join("\n") || "(no items)";

      const order = await prisma.order.create({
        data: {
          organizationId: organization.id,
          clientId: client.id,
          items: itemsSummary,
          note: orderPayload?.text?.trim() || undefined,
          status: "PENDING",
          subtotal,
          shippingCharge,
          totalAmount,
        },
      });

      const billText =
        `আপনার অর্ডার পেয়েছি! 🧾\n\n${itemsSummary}\n\n` +
        `Subtotal: ৳${subtotal}\n` +
        `Shipping: ৳${shippingCharge}\n` +
        `মোট (Total): ৳${totalAmount}\n\n` +
        `নিচের QR কোড স্ক্যান করে পেমেন্ট করুন এবং পেমেন্টের স্ক্রিনশট পাঠান — আমাদের টিম যাচাই করে অর্ডার কনফার্ম করবে।`;

      try {
        await sendWhatsAppMessage(from, billText);
        await prisma.message.create({
          data: { conversationId: conversation.id, sender: "AI", content: billText },
        });

        if (agentProfile?.qrCodeUrl) {
          await sendWhatsAppImageMessage(from, agentProfile.qrCodeUrl, "Payment QR Code");
          await prisma.message.create({
            data: {
              conversationId: conversation.id,
              sender: "AI",
              content: "[Sent payment QR code]",
              imageUrl: agentProfile.qrCodeUrl,
            },
          });
        }
      } catch (err) {
        console.error("Order bill/QR send failed:", err);
      }

      await logAudit({
        organizationId: organization.id,
        action: "WHATSAPP_ORDER_RECEIVED",
        metadata: { clientId: client.id, orderId: order.id, subtotal, shippingCharge, totalAmount },
      });

      return NextResponse.json({ status: "order-received" });
    }

    // Fetch recent history BEFORE logging this new message (so it isn't
    // duplicated in both the history list and the final question below). This
    // is what lets the AI actually follow the conversation — e.g. resolve a
    // bare "Yes" or "50" against what was asked two messages ago — instead of
    // answering every message as if it were the first one ever sent.
    const HISTORY_LIMIT = 20;
    const priorMessages = conversation.aiPaused
      ? []
      : await prisma.message.findMany({
          where: { conversationId: conversation.id },
          orderBy: { createdAt: "desc" },
          take: HISTORY_LIMIT,
        });
    const history: ChatHistoryMessage[] = priorMessages
      .slice()
      .reverse()
      .map((m) => ({ role: m.sender === "CLIENT" ? "user" : "assistant", content: m.content }));

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
          data: {
            conversationId: conversation.id,
            sender: "AI",
            content: `[Sent payment QR code] ${qrCaption}`,
            imageUrl: agentProfile.qrCodeUrl,
          },
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

    // Precompute whether a product/event photo will actually accompany this
    // reply (same threshold check used below when sending) — the AI needs to
    // know this BEFORE it writes its answer, otherwise it's guessing blind and
    // sometimes wrongly claims it "can't share image links" (it actually can,
    // it just didn't have one this specific time). Reused below so the send
    // logic doesn't need to re-query the same product/event a second time.
    const PRODUCT_PHOTO_DISTANCE_THRESHOLD = 0.35; // lower = stricter match required; tune from real usage
    const EVENT_PHOTO_DISTANCE_THRESHOLD = 0.35;
    let matchedProduct: { id: string; name: string; imageUrl: string | null; retailerId: string | null } | null = null;
    let matchedEvent: { id: string; title: string; imageUrl: string | null } | null = null;

    // Direct name word-match — checked FIRST, ahead of the RAG distance
    // threshold below. A customer typing a product's actual name ("Sorbhaja")
    // should always resolve to that exact product, but RAG has both missed
    // real matches (distance landing just above the threshold) and picked
    // the WRONG product on short/generic messages (embedding noise).
    //
    // Matches ONLY against the product NAME (not description — description
    // is marketing prose full of generic words like "customer"/"product"
    // that appear on every item and caused false matches), filters out
    // common filler words first, and picks the product with the MOST
    // matching words rather than the first one sharing any single word —
    // otherwise a shared category word like "Baked" alone could match the
    // wrong "Baked ___" product instead of the one actually named.
    const STOPWORDS = new Set([
      "customer", "customers", "product", "products", "order", "orders", "please", "want", "wants",
      "would", "have", "this", "that", "with", "from", "details", "detail", "about", "some", "more",
      "info", "information", "price", "prices", "item", "items", "shop", "menu", "hello", "thanks",
      "chai", "chan", "korte", "korbo", "ache", "achi", "amar", "apnar", "kichu", "janan", "janate",
      "dekhte", "dekhan", "koto", "kobe", "kore", "hoy", "hobe", "niben", "nite", "valo", "bhalo",
    ]);
    function extractWords(s: string): string[] {
      return s
        .toLowerCase()
        .split(/[^a-z0-9ঀ-৿]+/i)
        .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
    }
    const textWords = extractWords(text);
    if (textWords.length > 0) {
      const orgProducts = await prisma.product.findMany({
        where: { organizationId: organization.id },
        select: { id: true, name: true, imageUrl: true, retailerId: true },
      });
      let bestMatch: (typeof orgProducts)[number] | null = null;
      let bestScore = 0;
      for (const p of orgProducts) {
        const nameWords = extractWords(p.name);
        const score = textWords.filter((w) => nameWords.includes(w)).length;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = p;
        }
      }
      if (bestMatch) matchedProduct = bestMatch;
    }

    if (!matchedProduct && results.length > 0 && results[0].distance <= PRODUCT_PHOTO_DISTANCE_THRESHOLD) {
      matchedProduct = await prisma.product.findUnique({
        where: { documentId: results[0].documentId },
        select: { id: true, name: true, imageUrl: true, retailerId: true },
      });
    }
    if (
      !matchedProduct?.imageUrl &&
      !matchedProduct?.retailerId &&
      agentProfile?.skillSendEventPhotos &&
      results.length > 0 &&
      results[0].distance <= EVENT_PHOTO_DISTANCE_THRESHOLD
    ) {
      matchedEvent = await prisma.event.findUnique({
        where: { documentId: results[0].documentId },
        select: { id: true, title: true, imageUrl: true },
      });
    }

    // Deterministic fallback — a context-only follow-up like "pic ache?" (no
    // product name repeated) usually RAG-matches too weakly on its own to
    // clear the threshold above, even though the customer clearly means the
    // product just discussed. Rather than relying on the model to correctly
    // call send_product_photo every single time (it doesn't, reliably — same
    // lesson as the guaranteed terminology swaps), fall back to whatever
    // product this conversation last resolved to, when the message itself
    // looks like a photo request. This runs BEFORE photoNote is built, so if
    // it fires, the reply below correctly says "sending automatically."
    const PHOTO_REQUEST_REGEX =
      /\b(pic|pics|photo|photos|picture|pictures|image|images)\b|ছবি|ফটো|দেখতে চাই|দেখাও|দেখান|দেখব/i;
    if (
      !matchedProduct?.imageUrl &&
      !matchedProduct?.retailerId &&
      !matchedEvent?.imageUrl &&
      PHOTO_REQUEST_REGEX.test(text) &&
      conversation.lastProductId
    ) {
      const fallbackProduct = await prisma.product.findUnique({
        where: { id: conversation.lastProductId },
        select: { id: true, name: true, imageUrl: true, retailerId: true },
      });
      if (fallbackProduct?.imageUrl || fallbackProduct?.retailerId) {
        matchedProduct = fallbackProduct;
      }
    }

    // General "show me your products" browsing — only checked when nothing
    // more specific matched above (no named product, no context follow-up).
    // Sends a native swipeable carousel of a few featured/bestseller
    // products (marked on the Products page) instead of the AI guessing at
    // one product to push, matching how a customer expects to browse when
    // they haven't named anything specific yet.
    const BROWSE_REQUEST_REGEX =
      /\b(products?|items?|menu|catalog|catalogue|shop|options?)\b|প্রোডাক্ট|প্রডাক্ট|মেনু|কি কি আছে|কি আছে|সব দেখা|লিস্ট/i;
    let featuredCarousel: { id: string; name: string; retailerId: string | null; imageUrl: string | null }[] = [];
    if (
      !matchedProduct?.imageUrl &&
      !matchedProduct?.retailerId &&
      !matchedEvent?.imageUrl &&
      BROWSE_REQUEST_REGEX.test(text)
    ) {
      featuredCarousel = await prisma.product.findMany({
        where: { organizationId: organization.id, featured: true },
        select: { id: true, name: true, retailerId: true, imageUrl: true },
        take: 3,
      });
    }

    let photoNote: string;
    if (matchedProduct?.imageUrl || matchedProduct?.retailerId) {
      photoNote = `A photo of "${matchedProduct.name}" will be sent automatically right after this text reply — you do NOT need to say you can't share images; just answer naturally (you can casually mention a photo is coming if it fits).`;
    } else if (matchedEvent?.imageUrl) {
      photoNote = `A photo for "${matchedEvent.title}" will be sent automatically right after this text reply — you do NOT need to say you can't share images; just answer naturally.`;
    } else if (featuredCarousel.length > 0) {
      photoNote = `A carousel of a few of our featured products (with photos) will be sent automatically right after this text reply — you do NOT need to list product photos yourself; just answer naturally and briefly mention you're sharing a few options.`;
    } else {
      photoNote = `No product/event photo is precomputed for this specific reply. If the customer is asking to see a photo of a specific product — including a product only mentioned earlier in this conversation, not necessarily repeated just now — use the send_product_photo tool with that product's exact name. You DO have this capability; never say you're generally unable to share images or photo links. Only if the tool itself reports no photo is saved should you honestly say you don't have one on hand right now.`;
    }

    // Remember which product this reply settled on (RAG match or the fallback
    // above) so a LATER context-only "pic ache?" can resolve back to it, even
    // several turns from now — this is what the fallback block above reads.
    if (matchedProduct && conversation.lastProductId !== matchedProduct.id) {
      try {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastProductId: matchedProduct.id },
        });
      } catch (err) {
        console.error("Failed to update conversation.lastProductId:", err);
      }
    }

    // Function-calling skills — only wired up when the matching Skills toggle is on
    // in Agent Studio. executeTool actually writes to the real database here (this
    // is the live WhatsApp path, unlike the Test Sandbox which only simulates).
    // REQUEST_HANDOFF_TOOL is always included (not a toggle) — see its definition.
    const tools: ToolDefinition[] = [REQUEST_HANDOFF_TOOL, SEND_PRODUCT_PHOTO_TOOL];
    if (agentProfile?.skillSaveAddress) tools.push(SAVE_ADDRESS_TOOL);
    if (agentProfile?.skillReminders) tools.push(SET_REMINDER_TOOL);
    if (agentProfile?.skillTrackInterest) tools.push(RECORD_INTEREST_TOOL);
    if (agentProfile?.skillTakeOrders) tools.push(PLACE_ORDER_TOOL);

    // Tracks a product photo already sent via the send_product_photo tool this
    // reply, so the automatic RAG-matched send below doesn't fire a duplicate
    // image for the same product.
    let toolSentPhotoForProductId: string | null = null;

    async function executeTool(name: string, args: Record<string, any>): Promise<string> {
      if (name === "send_product_photo") {
        const productName = (args.productName as string)?.trim();
        if (!productName) return "No product specified — nothing sent.";

        // Match on name OR description — a customer usually says the brand/
        // generic name (e.g. "Laal Kheer Doi"), but the actual Product row is
        // often named after its catalog SKU/variant instead (e.g. "Doi 500 gm
        // (App)"), which name-only search would miss even though the product
        // clearly exists. The description field almost always still contains
        // the full product name in a sentence, so it's a reliable fallback.
        const product = await prisma.product.findFirst({
          where: {
            organizationId: organization!.id,
            OR: [
              { name: { contains: productName, mode: "insensitive" } },
              { description: { contains: productName, mode: "insensitive" } },
            ],
          },
        });
        if (!product) {
          return `No matching product found for "${productName}" — tell the customer honestly you couldn't find that product, don't pretend to send a photo.`;
        }
        // Guard against the model calling this tool twice for the same
        // product in one turn (it does happen occasionally) — without this,
        // the customer gets the identical photo/card sent to them twice.
        if (toolSentPhotoForProductId === product.id) {
          return `Already sent a photo of "${product.name}" earlier in this same reply — do not send it again, just acknowledge naturally.`;
        }
        if (!product.imageUrl && !product.retailerId) {
          return `No photo is saved for "${product.name}" yet — tell the customer honestly you don't have a photo on hand right now, don't pretend to send one.`;
        }

        try {
          let sentWithCard = !!(product.retailerId && organization!.metaCatalogId);
          if (sentWithCard) {
            try {
              await sendWhatsAppProductMessage(from, organization!.metaCatalogId!, product.retailerId!, product.name);
            } catch (cardErr) {
              // Meta rejected the catalog card (e.g. a catalog-side eligibility
              // issue, often with variant items) — fall back to a plain photo
              // so the customer still gets something instead of nothing.
              console.error("Catalog card send failed, falling back to plain image:", cardErr);
              sentWithCard = false;
              if (!product.imageUrl) throw cardErr; // nothing to fall back to
              await sendWhatsAppImageMessage(from, product.imageUrl, product.name);
            }
          } else {
            await sendWhatsAppImageMessage(from, product.imageUrl!, product.name);
          }
          await prisma.message.create({
            data: {
              conversationId: conversation!.id,
              sender: "AI",
              content: `[Sent photo${sentWithCard ? " + Add to Cart" : ""}] ${product.name}`,
              imageUrl: product.imageUrl,
            },
          });
          toolSentPhotoForProductId = product.id;
          await prisma.conversation.update({
            where: { id: conversation!.id },
            data: { lastProductId: product.id },
          }).catch((err) => console.error("Failed to update conversation.lastProductId:", err));
          await logAudit({
            organizationId: organization!.id,
            action: "PRODUCT_PHOTO_SENT_BY_AI",
            metadata: { clientId: client!.id, productId: product.id },
          });
          return `Sent a photo of "${product.name}". Just acknowledge briefly in your reply — don't re-describe the product in detail again.`;
        } catch (err) {
          console.error("send_product_photo tool failed:", err);
          return `Failed to send the photo due to a technical issue — apologize briefly and say you'll send it shortly instead.`;
        }
      }
      if (name === "request_human_handoff") {
        const reason = (args.reason as string)?.trim() || "AI couldn't help — needs a staff member.";
        await prisma.conversation.update({
          where: { id: conversation!.id },
          data: { aiPaused: true, handoffReason: reason },
        });
        await logAudit({
          organizationId: organization!.id,
          action: "AI_INITIATED_HANDOFF",
          metadata: { clientId: client!.id, reason },
        });
        return `Handed off to a staff member. Let the customer know someone will follow up shortly — don't say anything that implies you'll keep helping after this.`;
      }
      if (name === "save_customer_address") {
        const address = (args.address as string)?.trim();
        if (!address) return "No address was given — nothing saved.";
        await prisma.client.update({ where: { id: client!.id }, data: { address } });
        await logAudit({
          organizationId: organization!.id,
          action: "CLIENT_ADDRESS_SAVED_BY_AI",
          metadata: { clientId: client!.id, address },
        });
        return `Saved address: ${address}`;
      }
      if (name === "set_reminder") {
        const title = (args.title as string)?.trim();
        const dueDateRaw = args.dueDate as string;
        const dueDate = dueDateRaw ? new Date(dueDateRaw) : null;
        if (!title || !dueDate || isNaN(dueDate.getTime())) {
          return "Missing or invalid title/date — nothing was scheduled.";
        }
        await prisma.reminder.create({
          data: { organizationId: organization!.id, clientId: client!.id, title, dueDate },
        });
        await logAudit({
          organizationId: organization!.id,
          action: "REMINDER_CREATED_BY_AI",
          metadata: { clientId: client!.id, title, dueDate: dueDateRaw },
        });
        return `Reminder set: "${title}" on ${dueDateRaw}`;
      }
      if (name === "record_product_interest") {
        const productName = (args.productName as string)?.trim();
        if (!productName) return "No product name given — nothing recorded.";

        const product = await prisma.product.findFirst({
          where: {
            organizationId: organization!.id,
            OR: [
              { name: { contains: productName, mode: "insensitive" } },
              { description: { contains: productName, mode: "insensitive" } },
            ],
          },
        });
        if (!product) return `No matching product found for "${productName}" — nothing recorded.`;

        const note = (args.note as string)?.trim() || undefined;
        await prisma.clientProductInterest.upsert({
          where: { clientId_productId: { clientId: client!.id, productId: product.id } },
          update: { note },
          create: { organizationId: organization!.id, clientId: client!.id, productId: product.id, note },
        });
        await logAudit({
          organizationId: organization!.id,
          action: "PRODUCT_INTEREST_RECORDED_BY_AI",
          metadata: { clientId: client!.id, productId: product.id, productName: product.name, note },
        });
        return `Recorded interest in "${product.name}".`;
      }
      if (name === "record_order") {
        const items = (args.items as string)?.trim();
        if (!items) return "No items given — nothing recorded.";

        const deliveryAddress = (args.deliveryAddress as string)?.trim() || undefined;
        const note = (args.note as string)?.trim() || undefined;

        const order = await prisma.order.create({
          data: {
            organizationId: organization!.id,
            clientId: client!.id,
            items,
            deliveryAddress,
            note,
            status: "PENDING",
          },
        });
        await logAudit({
          organizationId: organization!.id,
          action: "ORDER_RECORDED_BY_AI",
          metadata: { clientId: client!.id, orderId: order.id, items, deliveryAddress },
        });
        return `Order recorded: ${items}. Our team will confirm shortly.`;
      }
      return "Unknown tool.";
    }

    // REQUEST_HANDOFF_TOOL is always in `tools` now (see above), so this always
    // goes through the real model — including zero-RAG-match questions, which
    // now get an honest "I don't know, let me get someone" instead of the old
    // hardcoded canned line, and the AI can genuinely escalate when it means it.
    const { answer, usage } = await askAIWithTools(
      text,
      results.map((r) => ({ title: r.documentTitle, content: r.content })),
      agentProfile ?? undefined,
      tools,
      executeTool,
      history,
      photoNote
    );
    await logAiUsage(organization.id, "webhook_reply", usage);

    // Guaranteed brand-vocabulary swap (e.g. "পণ্য" → "মিষ্টি") — the system
    // prompt already asks the model to do this, but that's a hint, not a
    // promise; this is the actual enforcement so a saved Word Swap is never
    // silently skipped in what the customer receives.
    const finalAnswer = applyTerminologySwaps(answer, agentProfile?.brandLanguage);

    const noKnowledgeMatch = results.length === 0;

    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: "AI",
        content: finalAnswer,
        noKnowledgeMatch,
        answeredQuestion: text,
      },
    });

    await sendWhatsAppMessage(from, finalAnswer);

    // Actually send the product/event photo determined above (matchedProduct /
    // matchedEvent were precomputed before the AI call so its text reply could
    // stay honest about whether a photo is coming — see photoNote above).
    if ((matchedProduct?.imageUrl || matchedProduct?.retailerId) && matchedProduct.id !== toolSentPhotoForProductId) {
      try {
        let sentWithCard = !!(matchedProduct.retailerId && organization.metaCatalogId);
        if (sentWithCard) {
          try {
            await sendWhatsAppProductMessage(from, organization.metaCatalogId!, matchedProduct.retailerId!, matchedProduct.name);
          } catch (cardErr) {
            console.error("Catalog card send failed, falling back to plain image:", cardErr);
            sentWithCard = false;
            if (!matchedProduct.imageUrl) throw cardErr;
            await sendWhatsAppImageMessage(from, matchedProduct.imageUrl, matchedProduct.name);
          }
        } else {
          await sendWhatsAppImageMessage(from, matchedProduct.imageUrl!, matchedProduct.name);
        }
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            sender: "AI",
            content: `[Sent photo${sentWithCard ? " + Add to Cart" : ""}] ${matchedProduct.name}`,
            imageUrl: matchedProduct.imageUrl,
          },
        });
      } catch (err) {
        console.error("Product image send failed:", err);
      }
    }

    if (matchedEvent?.imageUrl) {
      try {
        await sendWhatsAppImageMessage(from, matchedEvent.imageUrl, matchedEvent.title);
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            sender: "AI",
            content: `[Sent photo] ${matchedEvent.title}`,
            imageUrl: matchedEvent.imageUrl,
          },
        });
      } catch (err) {
        console.error("Event image send failed:", err);
      }
    }

    // Featured products carousel — general "what do you sell" browsing
    // (precomputed above, before the AI's text answer, so photoNote can tell
    // it a carousel is coming). Prefer the native swipeable Multi-Product
    // Message when every featured item has a catalog Content ID; otherwise
    // fall back to sending each one's plain photo individually so the
    // customer still sees them.
    if (featuredCarousel.length > 0) {
      try {
        const withRetailer = featuredCarousel.filter((p) => p.retailerId);
        if (withRetailer.length === featuredCarousel.length && organization.metaCatalogId) {
          await sendWhatsAppProductListMessage(
            from,
            organization.metaCatalogId,
            "Our Products",
            withRetailer.map((p) => p.retailerId!),
            "Our Products",
            "Here are a few of our favourites — tap any to see more or add to cart."
          );
          await prisma.message.create({
            data: {
              conversationId: conversation.id,
              sender: "AI",
              content: `[Sent product carousel] ${withRetailer.map((p) => p.name).join(", ")}`,
            },
          });
        } else {
          for (const p of featuredCarousel) {
            if (!p.imageUrl) continue;
            await sendWhatsAppImageMessage(from, p.imageUrl, p.name);
            await prisma.message.create({
              data: { conversationId: conversation.id, sender: "AI", content: `[Sent photo] ${p.name}`, imageUrl: p.imageUrl },
            });
          }
        }
      } catch (err) {
        console.error("Featured carousel send failed:", err);
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
