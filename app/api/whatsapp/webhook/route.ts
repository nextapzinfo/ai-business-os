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
  CHECK_ORDER_STATUS_TOOL,
  CHECK_PRODUCT_STOCK_TOOL,
  applyTerminologySwaps,
  stripHallucinatedProductListings,
  validateEntityAssociationClaims,
  type ToolDefinition,
  type ChatHistoryMessage,
  type CatalogProduct,
} from "@/lib/llm";
import {
  sendWhatsAppMessage,
  sendWhatsAppImageMessage,
  sendWhatsAppProductMessage,
  sendWhatsAppProductListMessage,
  downloadWhatsAppMedia,
} from "@/lib/whatsapp";
import {
  isBanglarDoiIntegrationEnabled,
  fetchBanglarDoiOrderStatus,
  fetchBanglarDoiProductStock,
  fetchLiveProductPriceText,
  fetchBanglarDoiFullCatalog,
} from "@/lib/banglardoi";
import {
  resolveDeliveryZone,
  buildBusinessRulesNote,
  validateOrderState,
  validateBusinessClaims,
  validateAddress,
  resolveActiveCampaign,
  fetchLiveDeliveryQuote,
} from "@/lib/business-rules";
import { resolvePincodeAreaNames } from "@/lib/pincode";
import { fetchBoostedQAChunk } from "@/lib/qa-retrieval";
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

    // When a customer taps "Send WhatsApp Message" on a Facebook/Instagram
    // Click-to-WhatsApp ad, or the WhatsApp button on an organic FB/IG post,
    // Meta attaches a `referral` object to the FIRST message of that chat —
    // no separate Meta Ads integration needed to detect this, WhatsApp
    // supplies it automatically. Only present on that first message, so this
    // only ever affects new-Client creation below, never existing clients.
    const referral = message.referral as
      | { source_type?: string; source_url?: string; headline?: string; body?: string }
      | undefined;
    let detectedSource = "WHATSAPP_DIRECT";
    let detectedSourceDetail: string | null = null;
    if (referral) {
      const platform = (referral.source_url ?? "").includes("instagram") ? "INSTAGRAM" : "FACEBOOK";
      const kind = referral.source_type === "ad" ? "AD" : "POST";
      detectedSource = `${platform}_${kind}`;
      detectedSourceDetail = referral.headline || referral.body || referral.source_url || null;
    }

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
          source: detectedSource,
          sourceDetail: detectedSourceDetail,
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
      // No OPEN conversation for this client — before starting a brand-new,
      // empty-looking thread, check whether they have an existing CLOSED
      // conversation and reopen that instead of creating a separate row.
      // Root-caused 2026-08-24 from the owner's own screenshots ("~pratima"
      // and "Joydeep" conversations): once staff (or any future auto-close
      // logic) closes a conversation, the customer's NEXT message used to
      // always spawn a brand-new Conversation row — the full message
      // history was still safely in the database, but silently orphaned
      // under the old CLOSED row, so the Conversations page appeared to
      // show the thread "starting mid-conversation" with no visible history
      // before that point, and the configured greeting fired again as if
      // talking to this customer for the very first time. Reopening the
      // most recent existing conversation instead keeps one continuous
      // thread per customer — matching how staff actually think about "a
      // conversation with this customer," the same way WhatsApp itself
      // works — and correctly leaves `isNewConversation` false so the
      // greeting only ever fires for a genuinely brand-new client.
      const previousConversation = await prisma.conversation.findFirst({
        where: {
          organizationId: organization.id,
          clientId: client.id,
          channel: "WHATSAPP",
        },
        orderBy: { createdAt: "desc" },
      });

      if (previousConversation) {
        conversation = await prisma.conversation.update({
          where: { id: previousConversation.id },
          data: { status: "OPEN" },
        });
      } else {
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

    // Deterministic PIN code detection — Intent/Entity layer, no LLM call
    // needed for this: a 6-digit PIN code is 100% regex-identifiable. Feeds
    // conversation.pincode (survives even when the customer doesn't repeat
    // it every message, same "current message first, then conversation
    // memory" pattern already used below for lastProductId) and is what
    // buildBusinessRulesNote() uses to compute the one authoritative
    // delivery-fee/minimum-order/campaign block injected into this reply.
    const PINCODE_REGEX = /\b[1-9][0-9]{5}\b/;
    const pincodeMatch = text.match(PINCODE_REGEX);
    const effectivePincode: string | null = pincodeMatch ? pincodeMatch[0] : conversation.pincode;
    if (pincodeMatch && conversation.pincode !== pincodeMatch[0]) {
      try {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { pincode: pincodeMatch[0] },
        });
      } catch (err) {
        console.error("Failed to update conversation.pincode:", err);
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

    // Trained-Q&A boost (see lib/qa-retrieval.ts for the full incident this
    // fixes) — a customer's real phrasing can easily fail to rank a Trained
    // Q&A into the plain top-5 above once the org has enough other
    // documents, even when the Q&A is conceptually the right answer. This
    // guarantees the single best-matching trained Q&A is considered too,
    // appended (not replacing anything) so it never disturbs results[0],
    // which the product/event photo matching just below still depends on.
    const boostedQA = await fetchBoostedQAChunk(organization.id, vectorLiteral);
    if (boostedQA && !results.some((r) => r.documentId === boostedQA.documentId)) {
      results.push(boostedQA);
    }

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
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    }
    type ProductForMatch = { id: string; name: string; imageUrl: string | null; retailerId: string | null };
    // Confident match = at least one shared word that's DISTINCTIVE — i.e.
    // appears in exactly one product's name across the whole catalog. A word
    // shared by multiple products (e.g. "Kheer", appearing in both "Laal
    // Kheer Doi" and "Baked Kheer Malai"; or "Baked", shared by two "Baked
    // ___" items) is a category term, not an identifier, and must never
    // decide a match — length alone isn't a reliable enough signal for that
    // (a long word can still be a shared category term). Products that only
    // share non-distinctive words correctly resolve to "no confident match"
    // rather than guessing — e.g. a bare "doi" with no variant specified
    // legitimately can't tell 500gm Doi from 1kg Doi apart, so no photo
    // should be forced; a later "pic" gets resolved by conversation context
    // instead (see the send_product_photo tool).
    function findBestProductMatch(words: string[], products: ProductForMatch[]): ProductForMatch | null {
      const productNameWords = products.map((p) => extractWords(p.name));
      const wordProductCount = new Map<string, number>();
      for (const nameWords of productNameWords) {
        for (const w of new Set(nameWords)) {
          wordProductCount.set(w, (wordProductCount.get(w) ?? 0) + 1);
        }
      }

      let bestMatch: ProductForMatch | null = null;
      let bestScore = 0;
      products.forEach((p, i) => {
        const nameWords = productNameWords[i];
        const distinctiveMatches = words.filter((w) => nameWords.includes(w) && wordProductCount.get(w) === 1);
        const score = distinctiveMatches.length;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = p;
        }
      });
      return bestScore > 0 ? bestMatch : null;
    }
    // Same distinctive-word scoring as findBestProductMatch, but returns EVERY
    // product with a confident match instead of only the single best one —
    // needed for order messages that name several products in one line (e.g.
    // "baked kheer malai 1 pcs, sorbhaja 2 pcs"), where relying on fuzzy RAG
    // retrieval alone had already caused a real mix-up: the AI quoted the
    // wrong minimum-order number for Kheer Gulab Jamun (said 5, actual is 10)
    // because a similar-sounding sweet's RAG chunk got pulled in instead.
    // This fetches EXACT price/description straight from the Product table
    // for every product actually named in the message, so the model has
    // ground truth for minimum-order/price checks instead of a guess.
    function findAllProductMatches(words: string[], products: ProductForMatch[]): ProductForMatch[] {
      const productNameWords = products.map((p) => extractWords(p.name));
      const wordProductCount = new Map<string, number>();
      for (const nameWords of productNameWords) {
        for (const w of new Set(nameWords)) {
          wordProductCount.set(w, (wordProductCount.get(w) ?? 0) + 1);
        }
      }
      const matches: ProductForMatch[] = [];
      products.forEach((p, i) => {
        const nameWords = productNameWords[i];
        const distinctiveMatches = words.filter((w) => nameWords.includes(w) && wordProductCount.get(w) === 1);
        if (distinctiveMatches.length > 0) matches.push(p);
      });
      return matches;
    }

    // Topic continuity (Aug 2026 — see topic-continuity-assessment.md).
    // Same distinctive-word scoring as findBestProductMatch, run against
    // Document titles instead of product names, so a conversation can also
    // remember "which knowledge document/Event this is about" and not just
    // "which product" — needed because a generic follow-up like "kiki ache?"
    // or "ar ki ki pabo?" often repeats no distinctive word at all, so RAG's
    // fuzzy top-5 semantic search can drift onto unrelated content instead
    // of staying anchored to the document just discussed.
    type DocumentForMatch = { id: string; title: string };
    function findBestTopicMatch(words: string[], documents: DocumentForMatch[]): DocumentForMatch | null {
      const titleWords = documents.map((d) => extractWords(d.title));
      const wordDocCount = new Map<string, number>();
      for (const tWords of titleWords) {
        for (const w of new Set(tWords)) {
          wordDocCount.set(w, (wordDocCount.get(w) ?? 0) + 1);
        }
      }
      let bestMatch: DocumentForMatch | null = null;
      let bestScore = 0;
      documents.forEach((d, i) => {
        const tWords = titleWords[i];
        const distinctiveMatches = words.filter((w) => tWords.includes(w) && wordDocCount.get(w) === 1);
        const score = distinctiveMatches.length;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = d;
        }
      });
      return bestScore > 0 ? bestMatch : null;
    }

    const textWords = extractWords(text);
    let exactProductInfoBlocks: { title: string; content: string }[] = [];
    let messageNamedProduct = false;
    if (textWords.length > 0) {
      const orgProducts = await prisma.product.findMany({
        where: { organizationId: organization.id },
        select: { id: true, name: true, imageUrl: true, retailerId: true },
      });
      matchedProduct = findBestProductMatch(textWords, orgProducts);

      const allMentioned = findAllProductMatches(textWords, orgProducts);
      messageNamedProduct = allMentioned.length > 0;
      if (allMentioned.length > 0) {
        const withFullInfo = await prisma.product.findMany({
          where: { id: { in: allMentioned.map((p) => p.id) } },
          select: { name: true, price: true, description: true },
        });
        // Live price from banglardoi.com first (2026-08-20 — "product r
        // price o AI website ta follow korle aro bhalo hobe"), falling back
        // to this app's own locally-taught Product.price only when the
        // integration is off, the live lookup errors, or there's no
        // confident name match on the website (never guess).
        exactProductInfoBlocks = await Promise.all(
          withFullInfo.map(async (p) => {
            const livePrice = isBanglarDoiIntegrationEnabled() ? await fetchLiveProductPriceText(p.name) : null;
            const priceText = livePrice
              ? `Live price/stock (from banglardoi.com): ${livePrice}. `
              : p.price
                ? `Price: ${p.price}. `
                : "";
            return {
              title: `EXACT CURRENT INFO — ${p.name}`,
              content: `${p.name}. ${priceText}${p.description ?? ""}`.trim(),
            };
          })
        );
      }
    }

    // Topic match against this message's own text — scoped to Documents that
    // AREN'T a Product's own sheet (product-level continuity is already
    // covered by lastProductId/exactProductInfoBlocks above; this is
    // deliberately narrowed to knowledge docs/Events only, so a message that
    // names a product doesn't also get treated as "changing the topic").
    let freshTopicMatch: DocumentForMatch | null = null;
    if (textWords.length > 0) {
      const orgDocuments = await prisma.document.findMany({
        where: { organizationId: organization.id, product: null },
        select: { id: true, title: true },
      });
      freshTopicMatch = findBestTopicMatch(textWords, orgDocuments);
    }
    // Persist immediately, same "current message first" pattern as pincode
    // above — a later fallback read of conversation.lastTopicDocumentId this
    // same reply should never see a stale value once this message itself
    // resolved to something fresher.
    if (freshTopicMatch && conversation.lastTopicDocumentId !== freshTopicMatch.id) {
      try {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastTopicDocumentId: freshTopicMatch.id },
        });
      } catch (err) {
        console.error("Failed to update conversation.lastTopicDocumentId:", err);
      }
    }

    // Topic fallback for a generic/referential follow-up that names no
    // product AND doesn't itself repeat a distinctive topic word (turn 2's
    // "kiki ache?" in the Janmashtami transcript) — inject the last resolved
    // topic document's full content as a trusted block, same "EXACT CURRENT
    // INFO, trust this over fuzzy retrieval" pattern already used for
    // products above. Deliberately does NOT fire when the message named a
    // product (that continuity is handled by exactProductInfoBlocks/
    // lastProductId instead) or when it already resolved a fresh topic match
    // this turn (nothing stale to fall back to).
    let topicInfoBlocks: { title: string; content: string }[] = [];
    if (!messageNamedProduct && !freshTopicMatch && conversation.lastTopicDocumentId) {
      const topicDoc = await prisma.document.findUnique({
        where: { id: conversation.lastTopicDocumentId },
        select: { id: true, title: true },
      });
      if (topicDoc) {
        const topicChunks = await prisma.documentChunk.findMany({
          where: { documentId: topicDoc.id },
          orderBy: { chunkIndex: "asc" },
          select: { content: true },
        });
        const fullText = topicChunks.map((c: { content: string }) => c.content).join(" ").trim();
        if (fullText) {
          topicInfoBlocks = [{ title: `EXACT CURRENT INFO — ${topicDoc.title}`, content: fullText }];
        }
      }
    }

    // Name-less follow-up (e.g. "min kota", "koto ta minimum lagbe") — the
    // current message doesn't repeat the product name, so the match above
    // found nothing. Without this fallback, the model has no fresh ground
    // truth for this turn and just repeats whatever it said earlier in
    // conversation history — including a wrong number it already stated
    // once. Fall back to the product this conversation was last actually
    // about (conversation.lastProductId, same memory used for "pic ache?").
    if (exactProductInfoBlocks.length === 0 && conversation.lastProductId) {
      const lastProduct = await prisma.product.findUnique({
        where: { id: conversation.lastProductId },
        select: { name: true, price: true, description: true },
      });
      if (lastProduct) {
        const livePrice = isBanglarDoiIntegrationEnabled() ? await fetchLiveProductPriceText(lastProduct.name) : null;
        const priceText = livePrice
          ? `Live price/stock (from banglardoi.com): ${livePrice}. `
          : lastProduct.price
            ? `Price: ${lastProduct.price}. `
            : "";
        exactProductInfoBlocks = [
          {
            title: `EXACT CURRENT INFO — ${lastProduct.name}`,
            content: `${lastProduct.name}. ${priceText}${lastProduct.description ?? ""}`.trim(),
          },
        ];
      }
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
        orderBy: [{ featuredOrder: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
        take: 10,
      });
    }

    // Free-delivery-upsell carousel — set inside the record_order tool
    // handler below (see its BILL BREAKDOWN / FREE DELIVERY UPSELL comment)
    // when a just-confirmed order sits below the zone's free-delivery
    // threshold. Sent at the end of this handler, the same way as
    // featuredCarousel above, once the AI's text reply (which names these
    // same products) has already gone out.
    let upsellCarousel: { id: string; name: string; retailerId: string | null; imageUrl: string | null }[] = [];

    // Janmashtami Special (Taal Pulp / Taal Bora) is a prose-only seasonal
    // mention driven by Custom Instructions — it isn't a real Product record,
    // so it can never appear in the featuredCarousel's hard-coded list below.
    // Without this exception, the "do not add extra ones" constraint on that
    // list silently overrides the Custom Instructions rule on every "what
    // products do you have" style message (BROWSE_REQUEST_REGEX), which is
    // exactly the discrepancy reported 2026-08-25 (Sandbox mentioned it,
    // real WhatsApp never did, no matter how the Custom Instructions/
    // Knowledge Base wording was tuned). Gate stays purely additive — the
    // required carousel list itself is untouched.
    const todayIndia = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const janmashtamiPromoActive = todayIndia <= "2026-09-03";
    // Applied to EVERY branch below, not just the featuredCarousel one — an
    // earlier version of this fix only patched the carousel branch, but a
    // real customer's "May I know ur products" (2026-08-25, 1:07am) took the
    // matchedProduct branch instead (a single RAG-matched product photo, e.g.
    // Kalojam) and still got zero Janmashtami mention, proving the gap has to
    // be universal — whichever photoNote branch fires on a given turn is not
    // predictable per-message, so the model needs this option available no
    // matter which one wins.
    const janmashtamiAddendum = janmashtamiPromoActive
      ? ` Separately, per your Custom Instructions: while today's date is on or before 3 September 2026, you may add ONE short additional festive sentence naturally introducing the Janmashtami Special (Taal Pulp + Taal Bora) somewhere in your text reply — this is a seasonal mention, independent of whatever photo/carousel this note describes, so it never counts as substituting or adding to any required product list above. Skip it if you've already mentioned Janmashtami earlier in this same conversation.`
      : "";

    let photoNote: string;
    if (matchedProduct?.imageUrl || matchedProduct?.retailerId) {
      photoNote = `A photo of "${matchedProduct.name}" will be sent automatically right after this text reply — you do NOT need to say you can't share images; just answer naturally (you can casually mention a photo is coming if it fits).${janmashtamiAddendum}`;
    } else if (matchedEvent?.imageUrl) {
      photoNote = `A photo for "${matchedEvent.title}" will be sent automatically right after this text reply — you do NOT need to say you can't share images; just answer naturally.${janmashtamiAddendum}`;
    } else if (featuredCarousel.length > 0) {
      // The carousel sent right after this text is HARD-CODED to exactly this
      // list, in exactly this order (see featuredCarousel query above, sorted
      // by the owner's featuredOrder). The text reply must name these same
      // products in this same order — otherwise the customer sees a written
      // list that doesn't match the photos underneath it, which reads as
      // broken/confusing. Never substitute, add, or reorder products here.
      const orderedNames = featuredCarousel.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
      photoNote = `A carousel of these exact products (with photos), in this exact order, will be sent automatically right after this text reply:\n${orderedNames}\n\nYour text reply must list these SAME products in this SAME order (a short numbered or bulleted list is fine) — do not substitute different products, add extra ones, or change the order within that list. You do not need to describe each in detail; the carousel below your text will show photos and prices.${janmashtamiAddendum}`;
    } else {
      photoNote = `No product/event photo is precomputed for this specific reply. If the customer is asking to see a photo of a specific product — including a product only mentioned earlier in this conversation, not necessarily repeated just now — use the send_product_photo tool with that product's exact name. You DO have this capability; never say you're generally unable to share images or photo links. Only if the tool itself reports no photo is saved should you honestly say you don't have one on hand right now.${janmashtamiAddendum}`;
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
    // Phase 9 — real Banglar Doi order/stock lookups, not a Skills toggle
    // (see CHECK_ORDER_STATUS_TOOL's comment in lib/llm.ts for why).
    if (organization.vertical === "RETAIL" && isBanglarDoiIntegrationEnabled()) {
      tools.push(CHECK_ORDER_STATUS_TOOL, CHECK_PRODUCT_STOCK_TOOL);
    }

    // Tracks a product photo already sent via the send_product_photo tool this
    // reply, so the automatic RAG-matched send below doesn't fire a duplicate
    // image for the same product.
    let toolSentPhotoForProductId: string | null = null;

    // Sends a product to the customer — either a single Interactive Product
    // card (with plain-image fallback if the card fails), or, when this
    // product belongs to a multi-item variant group (owner-tagged in
    // Products → "Variant group", e.g. all 3 Ghee pack sizes sharing the
    // label "Ghee"), a swipeable carousel of every sibling so the customer
    // can pick which size to add to cart instead of guessing from one card.
    type SendableProduct = { id: string; name: string; imageUrl: string | null; retailerId: string | null };
    async function sendProductCardOrVariants(
      to: string,
      product: SendableProduct,
      organizationId: string,
      metaCatalogId: string | null
    ): Promise<{ sentWithCard: boolean; sentAsCarousel: boolean; sentNames: string[] }> {
      const full = await prisma.product.findUnique({ where: { id: product.id }, select: { variantGroup: true } });
      if (full?.variantGroup) {
        const siblings = await prisma.product.findMany({
          where: { organizationId, variantGroup: full.variantGroup },
          select: { id: true, name: true, imageUrl: true, retailerId: true },
        });
        if (siblings.length > 1) {
          const withRetailer = siblings.filter((p) => p.retailerId);
          if (withRetailer.length === siblings.length && metaCatalogId) {
            try {
              await sendWhatsAppProductListMessage(
                to,
                metaCatalogId,
                full.variantGroup,
                withRetailer.map((p) => p.retailerId!),
                full.variantGroup,
                `Here are all the ${full.variantGroup} options — tap the one you'd like to add to cart.`
              );
              return { sentWithCard: true, sentAsCarousel: true, sentNames: withRetailer.map((p) => p.name) };
            } catch (err) {
              console.error("Variant carousel send failed, falling back to single card:", err);
              // fall through to single-card logic below for just this one product
            }
          } else {
            // Not every sibling has a Content ID yet — send plain photos for
            // each so the customer still sees all sizes instead of just one.
            const sentNames: string[] = [];
            for (const p of siblings) {
              if (!p.imageUrl) continue;
              await sendWhatsAppImageMessage(to, p.imageUrl, p.name);
              sentNames.push(p.name);
            }
            if (sentNames.length > 0) {
              return { sentWithCard: false, sentAsCarousel: true, sentNames };
            }
          }
        }
      }

      // Single product — original behavior.
      let sentWithCard = !!(product.retailerId && metaCatalogId);
      if (sentWithCard) {
        try {
          await sendWhatsAppProductMessage(to, metaCatalogId!, product.retailerId!, product.name);
        } catch (cardErr) {
          console.error("Catalog card send failed, falling back to plain image:", cardErr);
          sentWithCard = false;
          if (!product.imageUrl) throw cardErr;
          await sendWhatsAppImageMessage(to, product.imageUrl, product.name);
        }
      } else {
        await sendWhatsAppImageMessage(to, product.imageUrl!, product.name);
      }
      return { sentWithCard, sentAsCarousel: false, sentNames: [product.name] };
    }

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
          const { sentWithCard, sentAsCarousel, sentNames } = await sendProductCardOrVariants(
            from,
            product,
            organization!.id,
            organization!.metaCatalogId
          );
          await prisma.message.create({
            data: {
              conversationId: conversation!.id,
              sender: "AI",
              content: sentAsCarousel
                ? `[Sent variant carousel] ${sentNames.join(", ")}`
                : `[Sent photo${sentWithCard ? " + Add to Cart" : ""}] ${product.name}`,
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
          return sentAsCarousel
            ? `Sent a carousel showing all the size/variant options for "${product.name}" (${sentNames.join(", ")}) so the customer can pick which one to add to cart. Just acknowledge briefly — don't re-describe each one in detail.`
            : `Sent a photo of "${product.name}". Just acknowledge briefly in your reply — don't re-describe the product in detail again.`;
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

        // Pincode capture — prefer what the model explicitly extracted, fall
        // back to pulling a 6-digit PIN straight out of the address text
        // itself (same deterministic regex used at message-intake time).
        // Written to both Client.pinCode (staff-facing record) and
        // Conversation.pincode (what lib/business-rules.ts actually reads
        // for delivery-fee/minimum-order/campaign lookups) so a pincode
        // given here is usable immediately, not only after a staff edit.
        const pincodeArg = (args.pincode as string)?.trim();
        const pincodeFromAddress = address.match(/\b[1-9][0-9]{5}\b/)?.[0];
        const pincode = pincodeArg && /^[1-9][0-9]{5}$/.test(pincodeArg) ? pincodeArg : pincodeFromAddress;

        await prisma.client.update({
          where: { id: client!.id },
          data: { address, ...(pincode ? { pinCode: pincode } : {}) },
        });
        if (pincode && conversation!.pincode !== pincode) {
          await prisma.conversation
            .update({ where: { id: conversation!.id }, data: { pincode } })
            .catch((err: unknown) => console.error("Failed to update conversation.pincode:", err));
        }
        await logAudit({
          organizationId: organization!.id,
          action: "CLIENT_ADDRESS_SAVED_BY_AI",
          metadata: { clientId: client!.id, address, pincode },
        });
        // Deliberately worded to steer the model's next reply, not just log
        // what happened — a naive "Saved address: ..." return here (even
        // with no PIN) let the model confidently tell the customer their
        // address/PIN was saved correctly regardless, since it wasn't told
        // anything was actually missing. Real incident (2026-08-22, owner's
        // own screenshot): customer sent a 5-digit "70001", the model
        // replied the address was "সঠিকভাবে সংরক্ষিত হয়েছে" (correctly
        // saved) with that PIN and moved straight on to quoting a total —
        // the invalid PIN was silently dropped here (pincode stayed
        // undefined, nothing wrong with that on its own), but the model had
        // no signal that it should NOT have confirmed it.
        if (!pincode) {
          return `Address text saved, but NO valid 6-digit PIN code was found in "${address}". Do NOT tell the customer their address or PIN is confirmed, and do NOT quote a delivery fee or total yet — ask them to resend just their correct 6-digit PIN code.`;
        }

        // Ground truth for "which area is this PIN" — a SECOND real
        // incident (2026-08-22, same conversation): the customer's own
        // earlier free-text address said "Newtown, action area 1", then
        // they gave PIN 700001 — which actually resolves to Fairley
        // Place/BBD Bagh/Netaji Subhas Road, Kolkata, nowhere near Newtown.
        // Asked "amar area janen apni?" (do you know my area), the model
        // answered "নিউটাউন এলাকায়" (Newtown) anyway — just parroting the
        // earlier address text instead of ever actually checking what the
        // PIN itself resolves to, so a customer's own mistake (or a
        // mismatched PIN/address) was never caught or corrected. Same free
        // India Post API banglardoi.com's own Delivery Zone admin already
        // uses for this exact purpose (see pincode.ts).
        const areaNames = await resolvePincodeAreaNames(pincode);
        const areaNote =
          areaNames.length > 0
            ? ` India Post confirms PIN ${pincode} covers: ${areaNames.join(" / ")}. When telling the customer their area/locality, state ONLY this — never state a different area name (including one the customer themselves typed earlier in this conversation) unless it genuinely matches one of these. If the customer's own address text names a different area, gently point out the mismatch and ask them to confirm which is correct rather than picking one yourself.`
            : ` Could not confirm PIN ${pincode}'s real area right now — if the customer asks what area their PIN is in, say you're not able to confirm it rather than guessing or reusing an area name from earlier in the conversation.`;

        // Real incident (2026-08-23, owner's own words): "Birati, PIN 700051"
        // — an area name plus a PIN and nothing else — was accepted here as
        // a complete address; the AI later told the customer their address
        // was already on file and moved straight to asking for name/mobile,
        // then confirmed an order against it. validateAddress() (the same
        // hard check record_order's tool-safety backstop uses) is run here
        // too, so this is caught as early as possible — right when the
        // address is first saved — instead of only if/when an order is
        // actually attempted.
        const completeness = validateAddress({ line: address, pincode });
        const houseDetailNote = completeness.valid
          ? ""
          : ` This address does NOT yet include a house/plot/flat number — an area name and PIN code alone is not enough to deliver to. Do NOT tell the customer their address is complete or ready to order against; ask them for their full address with house/plot/flat number (e.g. house no., flat no., road/lane no.) before proceeding to name/mobile or confirming any order.`;

        return `Saved address: ${address} (PIN ${pincode}).${areaNote}${houseDetailNote}`;
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
        const estimatedTotalRaw = args.estimatedTotal;
        const estimatedTotal =
          typeof estimatedTotalRaw === "number" && isFinite(estimatedTotalRaw) ? estimatedTotalRaw : null;

        // Tool Safety backstop (lib/business-rules.ts validateOrderState) —
        // the hard code-level check behind PLACE_ORDER_TOOL's prompt
        // instructions. Runs for RETAIL orgs whenever a delivery address was
        // given; in-store pickup (no deliveryAddress) skips all of this.
        // Blocked here means the Order row is NEVER created and the model is
        // told exactly why, so it asks the customer for what's missing on
        // its next reply instead of confirming an order that isn't actually
        // deliverable yet.
        //
        // billNote — the full items+delivery=total breakdown and the
        // free-delivery upsell nudge, appended to the tool result once
        // validation passes. Real incident (2026-08-23, owner's own WhatsApp
        // screenshots): an order was confirmed as just "Combo Janmastami —
        // ₹600" with no delivery fee or grand total ever stated — the
        // customer had to separately ask "delivery charge lagbe na?" (which
        // got ignored) before any total was given, and even then it didn't
        // match the confirmed order. Owner's own words: "Ai full bill tai
        // nijer theke bolche na" (the AI isn't stating the full bill itself)
        // and "Kobe delivery hobe setao bolche na" (it's not saying when
        // delivery will happen either). Computed live here, from the exact
        // same banglardoi.com quote used everywhere else, and handed back as
        // part of THIS tool result so the model states it in the SAME reply
        // that confirms the order.
        let billNote = "";

        if (organization!.vertical === "RETAIL" && deliveryAddress) {
          const pincodeFromArg = deliveryAddress.match(/\b[1-9][0-9]{5}\b/)?.[0] ?? null;
          const pincode = pincodeFromArg ?? conversation!.pincode ?? null;
          const validation = await validateOrderState({
            organizationId: organization!.id,
            orderAmount: estimatedTotal ?? 0,
            pincode,
            addressLine: deliveryAddress,
            isDelivery: true,
          });
          // A zero/unknown estimatedTotal would otherwise fail every
          // minimum-order check by default — only enforce that specific
          // blocker when we actually have a real amount to check; address/
          // PIN-code completeness is still always enforced either way.
          const blockers = validation.blockers.filter(
            (b) => estimatedTotal !== null || !b.startsWith("Order total")
          );
          if (blockers.length > 0) {
            return `ORDER_BLOCKED: ${blockers.join(" ")} Do not tell the customer the order is confirmed — ask for what's missing instead.`;
          }

          if (pincode && estimatedTotal !== null) {
            const quote = await fetchLiveDeliveryQuote(pincode, Math.round(estimatedTotal * 100));
            if (quote && quote.zoneMatched) {
              const deliveryFee = quote.feeInPaise / 100;
              const grandTotal = estimatedTotal + deliveryFee;
              billNote =
                `\n\nBILL BREAKDOWN — state this FULL breakdown to the customer in THIS reply (translate/phrase naturally, don't just paste it), not just the item total:\n` +
                `  Items: ₹${estimatedTotal}\n` +
                `  Delivery: ${deliveryFee === 0 ? "FREE" : `₹${deliveryFee}`}\n` +
                `  Grand total: ₹${grandTotal}\n` +
                `  Estimated delivery: ${quote.estimatedDeliveryDays} day${quote.estimatedDeliveryDays === 1 ? "" : "s"}\n`;

              // Free-delivery upsell nudge — owner's own instruction: "er
              // sathe customer ke to bolbe apni ar 400/- r jinish nile
              // apnar delivery charge free hoe jabe" (also tell the
              // customer that adding ₹400 more gets them free delivery),
              // plus "sathe sathe 3 te product r name, price r 3 te
              // carasoul dakhake" (also show 3 product names/prices and a
              // 3-item carousel). Only fires when a real gap to the zone's
              // own free-delivery threshold exists. upsellCarousel (outer
              // scope, declared near featuredCarousel above) is read at the
              // end of this handler to actually send the carousel, the same
              // way featuredCarousel already does for general browsing.
              if (quote.freeDeliveryThresholdInPaise != null) {
                const gapInPaise = quote.freeDeliveryThresholdInPaise - Math.round(estimatedTotal * 100);
                if (gapInPaise > 0) {
                  const gapRupees = Math.ceil(gapInPaise / 100);
                  // take: 6, then filtered down to 3 fresh ones below — a
                  // customer's order might already include 1-2 of the
                  // featured items, and we don't want to "upsell" something
                  // they've already ordered.
                  const suggestions = await prisma.product.findMany({
                    where: { organizationId: organization!.id, featured: true },
                    select: { id: true, name: true, price: true, retailerId: true, imageUrl: true },
                    orderBy: [{ featuredOrder: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
                    take: 6,
                  });
                  const itemsLower = items.toLowerCase();
                  const freshSuggestions = suggestions
                    .filter((p: { name: string }) => !itemsLower.includes(p.name.toLowerCase()))
                    .slice(0, 3);
                  if (freshSuggestions.length > 0) {
                    upsellCarousel = freshSuggestions;
                    const suggestionLines = freshSuggestions
                      .map((p: { name: string; price: string | null }) => `  - ${p.name}${p.price ? ` — ${p.price}` : ""}`)
                      .join("\n");
                    billNote +=
                      `\nFREE DELIVERY UPSELL: this order is ₹${gapRupees} short of free delivery (free above ₹${
                        quote.freeDeliveryThresholdInPaise / 100
                      }). Tell the customer, naturally and briefly, that adding about ₹${gapRupees} more to their order would make delivery free, and mention these as easy options — a carousel of these SAME 3 products (with photos) will be sent automatically right after this text reply, so name these same 3 in your text, don't substitute or add others:\n${suggestionLines}\n`;
                  }
                }
              }
            }
          }
        }

        const order = await prisma.order.create({
          data: {
            organizationId: organization!.id,
            clientId: client!.id,
            items,
            deliveryAddress,
            note,
            status: "PENDING",
            ...(estimatedTotal !== null ? { totalAmount: estimatedTotal } : {}),
          },
        });
        await logAudit({
          organizationId: organization!.id,
          action: "ORDER_RECORDED_BY_AI",
          metadata: { clientId: client!.id, orderId: order.id, items, deliveryAddress, estimatedTotal },
        });
        return `Order recorded: ${items}.${billNote}\nOur team will confirm shortly.`;
      }
      if (name === "check_order_status") {
        try {
          const orders = await fetchBanglarDoiOrderStatus(client!.phone);
          if (orders.length === 0) {
            return "No orders were found for this customer's WhatsApp number — tell them honestly you don't see any orders on file for this number, and ask if they ordered using a different phone number.";
          }
          const summary = orders
            .map((o) => {
              const lastUpdate = o.lastUpdate
                ? `, last update: ${o.lastUpdate.status.replace(/_/g, " ").toLowerCase()}${
                    o.lastUpdate.note ? ` (${o.lastUpdate.note})` : ""
                  } at ${o.lastUpdate.at}`
                : "";
              return `Order ${o.orderNumber}: ${o.status.replace(/_/g, " ").toLowerCase()}, placed ${o.placedAt}, total ${o.total}, items: ${o.items.join(", ")}${lastUpdate}`;
            })
            .join("\n");
          return `Here are this customer's real recent orders, most recent first — answer using only this data, don't invent anything beyond it:\n${summary}`;
        } catch (err) {
          console.error("check_order_status tool failed:", err);
          return "Order lookup failed due to a technical issue — apologize briefly and say you'll check and follow up shortly, don't guess a status.";
        }
      }
      if (name === "check_product_stock") {
        const productName = (args.productName as string)?.trim();
        if (!productName) return "No product specified — nothing looked up.";
        try {
          const products = await fetchBanglarDoiProductStock(productName);
          if (products.length === 0) {
            return `No matching product found for "${productName}" in the live catalog — tell the customer honestly, don't guess a price or availability.`;
          }
          const summary = products
            .map(
              (p) =>
                `${p.name}: ${p.variants
                  .map(
                    (v) =>
                      `${v.label} — ${v.price}${v.minOrderQty > 1 ? ` (min order ${v.minOrderQty})` : ""} — ${
                        v.inStock ? "in stock" : "OUT OF STOCK"
                      }`
                  )
                  .join("; ")}`
            )
            .join("\n");
          return `Live catalog data for "${productName}" — this may be more current than what you were taught, prefer it if it conflicts:\n${summary}`;
        } catch (err) {
          console.error("check_product_stock tool failed:", err);
          return "Stock lookup failed due to a technical issue — answer from what you already know, but mention you'll confirm exact availability.";
        }
      }
      return "Unknown tool.";
    }

    // Full catalog (name, price, description) for this org — this is what
    // powers buildSystemPrompt's catalogNote (the closed "these are literally
    // the only products/prices that exist" list, including a [min order: N
    // pcs] tag extracted from each description) and priceFormatNote's
    // minimum-order enforcement rule. This was previously defined in lib/llm.ts
    // but never actually fetched/passed from this webhook, meaning that whole
    // safety layer was silently inactive on real WhatsApp traffic the entire
    // time — this is what actually turns it on.
    const localCatalogProducts: CatalogProduct[] = await prisma.product.findMany({
      where: { organizationId: organization.id },
      select: { name: true, price: true, description: true },
    });

    // Prefer banglardoi.com's own live, structured catalog — real per-variant
    // price + minOrderQty + category, straight from the same data the
    // storefront itself sells from — over this org's local Product table,
    // which the owner would otherwise have to keep manually re-typing in
    // sync by hand. Owner's own instruction (2026-08-20): "product r price o
    // AI website ta follow korle aro bhalo hobe... no need knowledge base
    // data for product priceing and min order qty." Falls back to the local
    // list above whenever the live fetch is unavailable/disabled or returns
    // nothing — this must never block or degrade a reply just because
    // banglardoi.com is briefly unreachable.
    let catalogProducts: CatalogProduct[] = localCatalogProducts;
    if (organization.vertical === "RETAIL" && isBanglarDoiIntegrationEnabled()) {
      const liveCatalog = await fetchBanglarDoiFullCatalog();
      if (liveCatalog && liveCatalog.products.length > 0) {
        catalogProducts = liveCatalog.products.map((p) => ({
          name: p.name,
          price:
            p.variants.length > 0
              ? p.variants.map((v) => `${v.label}: ${v.price}`).join(", ")
              : p.pricePerPiece,
          description: p.description,
          category: p.category,
          variants: p.variants.map((v) => ({ label: v.label, price: v.price, minOrderQty: v.minOrderQty })),
          bundleItems: p.bundleItems.map((b) => ({
            quantity: b.quantity,
            name: b.name,
            variantLabel: b.variantLabel,
          })),
        }));
      }
    }

    // Business Rule Engine note (lib/business-rules.ts) — the authoritative
    // delivery-fee/minimum-order/active-campaign facts for this customer's
    // known PIN code, computed fresh from DeliveryZone/Campaign every reply
    // (never cached, never guessed). null when no PIN code is known yet —
    // buildSystemPrompt simply omits the block in that case rather than
    // stating a number that isn't backed by a real configured zone. RETAIL-
    // vertical only, same gating already used for the Banglar Doi tools.
    const businessRulesNote =
      organization.vertical === "RETAIL"
        ? await buildBusinessRulesNote(
            organization.id,
            effectivePincode,
            client.address,
            // This turn's own product match wins if there is one, else fall
            // back to whatever this conversation last settled on — same
            // "current message first, then conversation memory" pattern used
            // for lastProductId itself (see the comment near PINCODE_REGEX).
            matchedProduct?.id ?? conversation.lastProductId
          )
        : null;

    // Real incident (2026-08-20, owner's own report): asked "ki ki product
    // ache" (general browse), a 7-item featured carousel was sent, but the
    // AI's own TEXT reply only named ONE of the 7 (a Ghee). Root cause: the
    // featuredCarousel photoNote above (built before catalogProducts existed
    // yet) only gave the model each product's NAME, not its real price —
    // left to guess a price from memory, a wrong guess for 6 of 7 products
    // got silently dropped by stripHallucinatedProductListings() further
    // down in this same request (a real name paired with a WRONG price is
    // treated the same as an invented product — see that function's own
    // comment in lib/llm.ts). Re-building photoNote here, now that
    // catalogProducts is known, with each product's REAL price included,
    // means the model has no reason to guess — and whatever it echoes will
    // match catalogProducts exactly, so it survives that later check.
    if (featuredCarousel.length > 0) {
      const priceByName = new Map(catalogProducts.map((p) => [p.name.trim().toLowerCase(), p.price]));
      const orderedNames = featuredCarousel
        .map((p, i) => {
          const price = priceByName.get(p.name.trim().toLowerCase());
          return `${i + 1}. ${p.name}${price ? ` — ${price}` : ""}`;
        })
        .join("\n");
      photoNote = `A carousel of these exact products (with photos), in this exact order, will be sent automatically right after this text reply:\n${orderedNames}\n\nYour text reply must list these SAME products, with these SAME real prices shown above, in this SAME order (a short numbered or bulleted list is fine) — do not substitute different products, invent or guess a different price, add extra ones, or change the order within that list.${janmashtamiAddendum}`;
    }

    // Category-aware retrieval — real incident (2026-08-20, owner's own
    // report): a customer asking about "combo" or "pithe" (a CATEGORY, e.g.
    // "Pithe-Puli"/"Combo" on banglardoi.com — see the categories in
    // catalogProducts above) got either nothing found, or a wrong, unrelated
    // product (asking about pithe returned Ghee). The exact-product-name
    // matching above (findBestProductMatch/RAG) has nothing to anchor to for
    // a category word — there's no single product literally named "Combo" or
    // "Pithe" — so it either finds nothing or a loose fuzzy match. This fixes
    // that specific gap: when the customer's message contains a real category
    // NAME (from the live catalog), inject the real, complete list of
    // products actually in that category as trusted reference material, the
    // same "ground truth ahead of fuzzy RAG" pattern as exactProductInfoBlocks
    // below. Only engages once live category data exists (catalogProducts
    // sourced from banglardoi.com, not the local-DB fallback, which has no
    // category concept) — a no-op otherwise, never blocks a reply.
    const categoryInfoBlocks: { title: string; content: string }[] = [];
    const categoriesPresent = Array.from(
      new Set(catalogProducts.map((p) => p.category).filter((c): c is string => Boolean(c && c.trim())))
    );
    if (categoriesPresent.length > 0) {
      const customerCategoryWords = new Set(
        text
          .toLowerCase()
          .split(/[^a-z0-9ঀ-৿]+/i)
          .filter((w) => w.length >= 3)
      );
      const matchedCategory = categoriesPresent.find((cat) =>
        cat
          .toLowerCase()
          .split(/[^a-z0-9ঀ-৿]+/i)
          .some((catWord) => catWord.length >= 3 && customerCategoryWords.has(catWord))
      );
      if (matchedCategory) {
        const productsInCategory = catalogProducts.filter((p) => p.category === matchedCategory);
        if (productsInCategory.length > 0) {
          const listing = productsInCategory.map((p) => `${p.name}${p.price ? ` — ${p.price}` : ""}`).join("\n");
          categoryInfoBlocks.push({
            title: `Real products in category "${matchedCategory}"`,
            content: `The customer's message seems to be asking about the "${matchedCategory}" category. Here is the REAL, COMPLETE list of products actually in this category:\n${listing}\n\nAnswer using ONLY these real items for this category — never substitute, invent, or pull in a product from a different category.`,
          });
        }
      }
    }

    // REQUEST_HANDOFF_TOOL is always in `tools` now (see above), so this always
    // goes through the real model — including zero-RAG-match questions, which
    // now get an honest "I don't know, let me get someone" instead of the old
    // hardcoded canned line, and the AI can genuinely escalate when it means it.
    // Exact product info blocks go FIRST — ground truth for any product
    // actually named in this message, ahead of fuzzy RAG chunks that can pull
    // in a similar-sounding product's numbers by mistake (see comment above
    // findAllProductMatches).
    const { answer, usage } = await askAIWithTools(
      text,
      [
        ...exactProductInfoBlocks,
        ...categoryInfoBlocks,
        ...topicInfoBlocks,
        ...results.map((r) => ({ title: r.documentTitle, content: r.content })),
      ],
      agentProfile ?? undefined,
      tools,
      executeTool,
      history,
      photoNote,
      catalogProducts,
      businessRulesNote
    );
    await logAiUsage(organization.id, "webhook_reply", usage);

    // If nothing was resolved to a specific product BEFORE the AI answered
    // (no name match on the customer's own text, no tool call), check
    // whether the AI's OWN answer names one confidently — e.g. it
    // recommends "SORBHAJA" as the best-seller even though the customer's
    // message just said "what's best?" with no product name in it. Without
    // this, that reply sends no photo at all, AND conversation.lastProductId
    // stays stuck on whatever product was last resolved several turns ago —
    // so a following "pic" wrongly pulls up the STALE old product instead of
    // the one the AI just actually talked about.
    //
    // Real incident (2026-08-23, owner's own WhatsApp screenshot): customer
    // asked a general "ki ki aval ache ar price koto" (what's available and
    // the price) — a phrasing that didn't clear BROWSE_REQUEST_REGEX above,
    // so no featuredCarousel kicked in. matchedProduct instead got set from
    // the RAG distance-threshold fallback (line ~700), using the raw
    // customer message — which happened to land on "Jeggery Powder", a
    // product wholly unrelated to what the reply ended up saying. The reply
    // itself confidently listed 4 completely different named products (Laal
    // Kheer Doi, Combo Janmastami, Sorbhaja, Baked Rosogolla) drawn from the
    // general catalog — but since matchedProduct was already non-null before
    // the answer was even generated, the reconciliation block below never
    // used to run at all (it was gated on `!matchedProduct`), so the
    // Jeggery Powder photo went out anyway, next to text that never
    // mentioned it. Owner's own words: "he shold send pics form the above
    // list" — the photo must be one of the products the text actually named,
    // or no photo at all, never an independently-guessed one.
    if (!toolSentPhotoForProductId) {
      const answerWords = extractWords(answer);
      if (answerWords.length > 0) {
        const orgProducts = await prisma.product.findMany({
          where: { organizationId: organization.id },
          select: { id: true, name: true, imageUrl: true, retailerId: true },
        });

        if (matchedProduct) {
          // Reconciliation: a photo was already picked before the reply
          // existed (name match on the customer's message, or RAG). Verify
          // the reply's own text actually names it — if the reply instead
          // confidently names one or more OTHER real products and never
          // mentions the precomputed one, that photo would be a mismatch.
          // If the reply names no confident product at all, leave the
          // precomputed match alone — it may still be legitimate (a
          // description that doesn't literally repeat the catalog name).
          const namedInAnswer = findAllProductMatches(answerWords, orgProducts);
          if (namedInAnswer.length > 0 && !namedInAnswer.some((p) => p.id === matchedProduct!.id)) {
            const replacement = namedInAnswer.length === 1 ? namedInAnswer[0] : null;
            matchedProduct = replacement && (replacement.imageUrl || replacement.retailerId) ? replacement : null;
            if (matchedProduct && conversation.lastProductId !== matchedProduct.id) {
              await prisma.conversation
                .update({ where: { id: conversation.id }, data: { lastProductId: matchedProduct.id } })
                .catch((err: unknown) => console.error("Failed to update conversation.lastProductId:", err));
            }
          }
        } else {
          const bestMatch = findBestProductMatch(answerWords, orgProducts);
          if (bestMatch && (bestMatch.imageUrl || bestMatch.retailerId)) {
            matchedProduct = bestMatch;
            if (conversation.lastProductId !== matchedProduct.id) {
              await prisma.conversation
                .update({ where: { id: conversation.id }, data: { lastProductId: matchedProduct.id } })
                .catch((err: unknown) => console.error("Failed to update conversation.lastProductId:", err));
            }
          }
        }
      }
    }

    // Deterministic backstop: strip out any bulleted product-listing line
    // naming a product that isn't real, or quoting a price that doesn't
    // actually belong to that product — a hard code-level check, not just a
    // prompt instruction, for the exact "real name + wrong price" and
    // "invented product" incidents this was built for (see comment above
    // stripHallucinatedProductListings in lib/llm.ts).
    const hallucinationChecked = stripHallucinatedProductListings(answer, catalogProducts);

    // Product ↔ Event/Campaign association backstop (topic-continuity work,
    // Aug 2026 — see topic-continuity-assessment.md). Real incident: asked
    // "etaiki janmastami r special?" about a product photo (Kheer Gulab
    // Jamun) just sent, the AI confirmed it as a Janmashtami special even
    // though that product is never mentioned anywhere in the real
    // Janmashtami Event's own text. Fetches every Event's full text fresh
    // (same "check against current live truth" pattern as the business-claim
    // check below) and strips any sentence naming both a real product and a
    // real Event unless that product is actually named in that Event's own
    // content — see validateEntityAssociationClaims in lib/llm.ts for why
    // this is deliberately blunt (same "drop rather than risk it" trade-off
    // as stripHallucinatedProductListings above).
    const orgEventsForClaimCheck =
      catalogProducts.length > 0
        ? await (async () => {
            const events: { title: string; documentId: string }[] = await prisma.event.findMany({
              where: { organizationId: organization.id },
              select: { title: true, documentId: true },
            });
            if (events.length === 0) return [];
            const chunks: { documentId: string; content: string }[] = await prisma.documentChunk.findMany({
              where: { documentId: { in: events.map((e: { documentId: string }) => e.documentId) } },
              orderBy: { chunkIndex: "asc" },
              select: { documentId: true, content: true },
            });
            const textByDoc = new Map<string, string>();
            for (const c of chunks) {
              textByDoc.set(c.documentId, `${textByDoc.get(c.documentId) ?? ""} ${c.content}`);
            }
            return events.map((e: { title: string; documentId: string }) => ({
              title: e.title,
              fullText: textByDoc.get(e.documentId) ?? "",
            }));
          })()
        : [];
    const entityChecked = validateEntityAssociationClaims(hallucinationChecked, catalogProducts, orgEventsForClaimCheck);

    // Business Claim Validation backstop — the code-level check behind the
    // businessRulesNote prompt text above. Re-resolves the same zone/
    // campaign fresh (not reused from the note step, so this checks against
    // the current live truth right before sending) and strips any sentence
    // in the AI's reply that quotes a ₹ delivery/minimum-order/campaign
    // number not backed by a real configured value. Only runs when a PIN
    // code is actually known — with none known, there's nothing authoritative
    // to check against, so the reply is left alone (same conservative, only-
    // check-what-we-can-verify approach as the hallucination filter above).
    let claimChecked = entityChecked;
    if (organization.vertical === "RETAIL" && effectivePincode) {
      // Live quote, not this app's own (legacy) DeliveryZone table — see
      // lib/business-rules.ts's 2026-08-20 header note. resolveDeliveryZone
      // is still consulted here, but only to find a zone-restricted
      // campaign; a null zone just means no zone-scoped campaign can apply,
      // it does NOT mean the claim check is skipped.
      const liveQuote = await fetchLiveDeliveryQuote(effectivePincode, 0);
      if (liveQuote) {
        const zoneForCheck = await resolveDeliveryZone(effectivePincode, organization.id);
        const campaignForCheck = await resolveActiveCampaign(organization.id, zoneForCheck?.id ?? null, new Date());
        claimChecked = validateBusinessClaims(entityChecked, {
          quote: liveQuote,
          campaign: campaignForCheck,
        });
      }
    }

    // Guaranteed brand-vocabulary swap (e.g. "পণ্য" → "মিষ্টি") — the system
    // prompt already asks the model to do this, but that's a hint, not a
    // promise; this is the actual enforcement so a saved Word Swap is never
    // silently skipped in what the customer receives.
    const finalAnswer = applyTerminologySwaps(claimChecked, agentProfile?.brandLanguage);

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
    //
    // If the model already sent a photo via the send_product_photo tool this
    // turn, skip this automatic send entirely — even if it resolved to a
    // DIFFERENT product than matchedProduct. The tool call is informed by
    // the model reading the full conversation history and its own
    // just-written answer, which is a better signal than our precomputed
    // guess (e.g. a stale conversation.lastProductId from several turns
    // back) — sending both means the customer gets one right photo and one
    // wrong/extra one.
    // Extra guard: even when matchedProduct resolves to something real, don't
    // auto-resend its photo/card if we already sent one for this exact
    // product earlier in this SAME conversation recently (e.g. during an
    // ongoing order flow — "2 pcs" → "here's your address?" → "confirmed" —
    // where the product name keeps getting mentioned every turn but the
    // customer never asked to see the photo again). An explicit re-request
    // still works fine, since that goes through the send_product_photo TOOL
    // path (toolSentPhotoForProductId), which this check doesn't touch.
    // BUG FIX (real incident: same product card resent on every single reply
    // for the rest of a conversation, e.g. during an order flow where the
    // running order recap keeps repeating the product name every turn): this
    // used to fetch the MOST RECENT AI message merely CONTAINING the product
    // name, then separately check whether that one happened to start with
    // "[Sent". Since the AI's own plain-text replies (order recaps, "your
    // address has been saved", etc.) legitimately mention the product name
    // too and are always more recent than the last actual photo-send log
    // entry, `findFirst` kept returning that plain-text message — which
    // never starts with "[Sent" — so the guard evaluated to false and never
    // engaged. Fix: filter for a "[Sent...]" log entry AND the product name
    // in the SAME query, so only an actual prior photo/card send counts.
    let recentDuplicateSend = false;
    if ((matchedProduct?.imageUrl || matchedProduct?.retailerId) && !toolSentPhotoForProductId) {
      const recentSend = await prisma.message.findFirst({
        where: {
          conversationId: conversation.id,
          sender: "AI",
          AND: [{ content: { startsWith: "[Sent" } }, { content: { contains: matchedProduct.name } }],
          createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
        },
        orderBy: { createdAt: "desc" },
      });
      recentDuplicateSend = !!recentSend;
    }

    if ((matchedProduct?.imageUrl || matchedProduct?.retailerId) && !toolSentPhotoForProductId && !recentDuplicateSend) {
      try {
        const { sentWithCard, sentAsCarousel, sentNames } = await sendProductCardOrVariants(
          from,
          matchedProduct,
          organization.id,
          organization.metaCatalogId
        );
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            sender: "AI",
            content: sentAsCarousel
              ? `[Sent variant carousel] ${sentNames.join(", ")}`
              : `[Sent photo${sentWithCard ? " + Add to Cart" : ""}] ${matchedProduct.name}`,
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

    // Free-delivery-upsell carousel — the same 3 products the record_order
    // handler above put in the FREE DELIVERY UPSELL tool-result text (see
    // that comment), sent the same way featuredCarousel is: a native
    // swipeable Multi-Product Message when every suggested item has a
    // catalog Content ID, otherwise each product's plain photo individually.
    if (upsellCarousel.length > 0) {
      try {
        const withRetailer = upsellCarousel.filter((p) => p.retailerId);
        if (withRetailer.length === upsellCarousel.length && organization.metaCatalogId) {
          await sendWhatsAppProductListMessage(
            from,
            organization.metaCatalogId,
            "A few easy options",
            withRetailer.map((p) => p.retailerId!),
            "Add a bit more for FREE delivery",
            "Tap any to add it to your order."
          );
          await prisma.message.create({
            data: {
              conversationId: conversation.id,
              sender: "AI",
              content: `[Sent free-delivery-upsell carousel] ${withRetailer.map((p) => p.name).join(", ")}`,
            },
          });
        } else {
          for (const p of upsellCarousel) {
            if (!p.imageUrl) continue;
            await sendWhatsAppImageMessage(from, p.imageUrl, p.name);
            await prisma.message.create({
              data: { conversationId: conversation.id, sender: "AI", content: `[Sent photo] ${p.name}`, imageUrl: p.imageUrl },
            });
          }
        }
      } catch (err) {
        console.error("Free-delivery-upsell carousel send failed:", err);
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
