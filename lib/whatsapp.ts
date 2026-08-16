const WHATSAPP_API_BASE = "https://graph.facebook.com/v21.0";

export async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) {
    throw new Error("WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not set");
  }

  const res = await fetch(`${WHATSAPP_API_BASE}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WhatsApp send failed: ${res.status} ${errText}`);
  }
}

// Sends a product photo (by public image URL) with an optional caption.
// Used when a RAG-matched answer traces back to a Product with an imageUrl.
export async function sendWhatsAppImageMessage(
  to: string,
  imageUrl: string,
  caption?: string
): Promise<void> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) {
    throw new Error("WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not set");
  }

  const res = await fetch(`${WHATSAPP_API_BASE}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: {
        link: imageUrl,
        ...(caption ? { caption } : {}),
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WhatsApp image send failed: ${res.status} ${errText}`);
  }
}

// Sends a native WhatsApp Catalog "Interactive Product Message" — shows the
// product's image/price/name straight from the connected Commerce Manager
// catalog, plus (since "Add to cart" is turned on for the account in
// WhatsApp Manager) a native Add to Cart affordance under it. This is what
// lets a customer build a cart across several products and hit "Send order"
// to check out — that checkout arrives back at our webhook as a
// message.type === "order" event. Requires both the org's metaCatalogId and
// the specific Product's retailerId (its Commerce Manager Content ID) to be
// set; falls back to a plain image (sendWhatsAppImageMessage) elsewhere in
// the app when either is missing.
export async function sendWhatsAppProductMessage(
  to: string,
  catalogId: string,
  retailerId: string,
  bodyText: string
): Promise<void> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) {
    throw new Error("WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not set");
  }

  const res = await fetch(`${WHATSAPP_API_BASE}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "product",
        body: { text: bodyText },
        action: { catalog_id: catalogId, product_retailer_id: retailerId },
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WhatsApp product message send failed: ${res.status} ${errText}`);
  }
}

// Sends a native WhatsApp "Multi-Product Message" — a swipeable carousel of
// several catalog products in one message (image/name/price pulled straight
// from the connected catalog, same as the single-product card), used when a
// customer asks about products generally rather than naming one. Meta caps
// this at 30 products across sections; we only ever send a handful (featured
// items) so a single section is enough. Requires every retailerId passed in
// to exist in the connected catalog — same real-catalog dependency as the
// single Interactive Product Message.
export async function sendWhatsAppProductListMessage(
  to: string,
  catalogId: string,
  sectionTitle: string,
  retailerIds: string[],
  headerText: string,
  bodyText: string
): Promise<void> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) {
    throw new Error("WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not set");
  }
  if (retailerIds.length === 0) {
    throw new Error("sendWhatsAppProductListMessage called with no retailerIds");
  }

  const res = await fetch(`${WHATSAPP_API_BASE}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "product_list",
        header: { type: "text", text: headerText },
        body: { text: bodyText },
        action: {
          catalog_id: catalogId,
          sections: [
            {
              title: sectionTitle,
              product_items: retailerIds.map((id) => ({ product_retailer_id: id })),
            },
          ],
        },
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WhatsApp product list message send failed: ${res.status} ${errText}`);
  }
}

export type MetaCatalogProduct = {
  id: string; // Meta's internal catalog item id
  retailerId: string; // the Content ID — what our Product.retailerId stores, links the two systems
  name: string;
  description: string | null;
  price: string | null; // Meta returns e.g. "250.00 INR" — caller decides how to reformat
  salePrice: string | null; // discounted price, if the owner set one in Commerce Manager — this is what customers should actually be quoted when present
  imageUrl: string | null;
  availability: string | null; // "in stock" / "out of stock" etc
};

// Pulls every product from a connected Meta Commerce Manager catalog, so the
// dashboard can sync them into our own Products table instead of requiring
// everything to be typed in twice (once in Commerce Manager, once here).
// Skips any catalog item with no Content ID set — nothing to link it to on
// our side. Paginates automatically; capped at 10 pages (1000 items) as a
// safety limit, well above Meta's own 500-product-per-catalog cap.
export async function fetchMetaCatalogProducts(catalogId: string): Promise<MetaCatalogProduct[]> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error("WHATSAPP_ACCESS_TOKEN is not set");
  }

  const results: MetaCatalogProduct[] = [];
  let url: string | null =
    `${WHATSAPP_API_BASE}/${catalogId}/products?fields=id,retailer_id,name,description,price,sale_price,image_url,availability&limit=100`;

  let pages = 0;
  while (url && pages < 10) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data: any = await res.json();
    if (!res.ok) {
      throw new Error(`Meta catalog fetch failed: ${res.status} ${JSON.stringify(data)}`);
    }

    for (const item of data.data ?? []) {
      if (!item.retailer_id) continue;
      results.push({
        id: item.id,
        retailerId: item.retailer_id,
        name: item.name ?? "Unnamed product",
        description: item.description ?? null,
        price: item.price ?? null,
        salePrice: item.sale_price ?? null,
        imageUrl: item.image_url ?? null,
        availability: item.availability ?? null,
      });
    }

    url = data.paging?.next ?? null;
    pages++;
  }

  return results;
}

// Downloads an incoming media attachment (e.g. a customer's payment screenshot)
// by its WhatsApp media id. Two-step Graph API dance: first resolve the id to
// a short-lived download URL, then fetch that URL — both calls need the same
// access token, the second one is NOT a public link on its own.
export async function downloadWhatsAppMedia(mediaId: string): Promise<{ buffer: Buffer; contentType: string }> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error("WHATSAPP_ACCESS_TOKEN is not set");
  }

  const metaRes = await fetch(`${WHATSAPP_API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const meta = await metaRes.json();
  if (!metaRes.ok || !meta.url) {
    throw new Error(`WhatsApp media lookup failed: ${metaRes.status} ${JSON.stringify(meta)}`);
  }

  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!fileRes.ok) {
    throw new Error(`WhatsApp media download failed: ${fileRes.status}`);
  }

  const buffer = Buffer.from(await fileRes.arrayBuffer());
  const contentType = (meta.mime_type as string) || fileRes.headers.get("content-type") || "image/jpeg";
  return { buffer, contentType };
}

// Sends an already-Meta-approved template message. Required for messaging a
// customer outside the 24-hour service window (e.g. bulk broadcasts).
//
// A static (no-variable) TEXT header is baked into the approved template, so
// it needs nothing at send time — but an IMAGE header is NOT baked in; Meta
// only stored the *format*, and expects the actual image supplied on every
// single send via a header component, or it rejects the send with error
// 132012 ("expected IMAGE, received UNKNOWN"). headerImageUrl only needs to
// be passed when the template's header format is IMAGE.
export async function sendWhatsAppTemplateMessage(
  to: string,
  metaTemplateName: string,
  languageCode: string,
  bodyVariables: string[] = [],
  headerImageUrl?: string
): Promise<void> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) {
    throw new Error("WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not set");
  }

  const components: Record<string, unknown>[] = [];

  if (headerImageUrl) {
    components.push({
      type: "header",
      parameters: [{ type: "image", image: { link: headerImageUrl } }],
    });
  }

  if (bodyVariables.length > 0) {
    components.push({
      type: "body",
      parameters: bodyVariables.map((v) => ({ type: "text", text: v })),
    });
  }

  const res = await fetch(`${WHATSAPP_API_BASE}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: metaTemplateName,
        language: { code: languageCode },
        ...(components.length > 0 ? { components } : {}),
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WhatsApp template send failed: ${res.status} ${errText}`);
  }
}

// Counts {{1}}, {{2}}, ... placeholders in a template body and builds the
// generic example values Meta requires alongside any templated body text.
function buildBodyExample(bodyText: string): string[] | null {
  const matches = [...bodyText.matchAll(/\{\{(\d+)\}\}/g)];
  if (matches.length === 0) return null;
  const maxIndex = Math.max(...matches.map((m) => parseInt(m[1], 10)));
  const sampleWords = ["Karim", "Rahim", "Dhaka", "50", "Monday"];
  return Array.from({ length: maxIndex }, (_, i) => sampleWords[i % sampleWords.length]);
}

// Uploads an already-hosted image (e.g. a Vercel Blob URL) to Meta's Resumable
// Upload API and returns a media handle that a template's IMAGE header can
// reference. Handles are single-use for template creation. Requires the app
// (not WABA) id — WHATSAPP_APP_ID — alongside the usual access token.
async function uploadMediaHandleForTemplate(imageUrl: string): Promise<string> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const appId = process.env.WHATSAPP_APP_ID;
  if (!accessToken || !appId) {
    throw new Error("WHATSAPP_ACCESS_TOKEN or WHATSAPP_APP_ID is not set");
  }

  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) throw new Error(`Failed to fetch header image: ${imageRes.status}`);
  const buffer = Buffer.from(await imageRes.arrayBuffer());
  const contentType = imageRes.headers.get("content-type") || "image/jpeg";

  const sessionRes = await fetch(
    `${WHATSAPP_API_BASE}/${appId}/uploads?file_length=${buffer.length}&file_type=${encodeURIComponent(
      contentType
    )}&access_token=${accessToken}`,
    { method: "POST" }
  );
  const sessionData = await sessionRes.json();
  if (!sessionRes.ok || !sessionData.id) {
    throw new Error(`Meta upload session failed: ${sessionRes.status} ${JSON.stringify(sessionData)}`);
  }

  const uploadRes = await fetch(`${WHATSAPP_API_BASE}/${sessionData.id}`, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${accessToken}`,
      file_offset: "0",
    },
    body: buffer,
  });
  const uploadData = await uploadRes.json();
  if (!uploadRes.ok || !uploadData.h) {
    throw new Error(`Meta media upload failed: ${uploadRes.status} ${JSON.stringify(uploadData)}`);
  }

  return uploadData.h as string;
}

export type TemplateButtonInput = {
  type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER" | "COPY_CODE";
  text?: string;
  url?: string;
  phoneNumber?: string;
  example?: string;
};

// Buttons must be grouped correctly for Meta to accept them: all QUICK_REPLY
// buttons together, then all non-quick-reply (URL/PHONE_NUMBER/COPY_CODE)
// buttons together — never interleaved. Building the order here means the
// UI doesn't have to worry about it. Caps match Meta's per-type limits.
function buildButtonsComponent(buttons: TemplateButtonInput[] | undefined): Record<string, unknown> | null {
  if (!buttons || buttons.length === 0) return null;

  const quickReplies = buttons.filter((b) => b.type === "QUICK_REPLY" && b.text?.trim()).slice(0, 3);
  const urls = buttons.filter((b) => b.type === "URL" && b.text?.trim() && b.url?.trim()).slice(0, 2);
  const phones = buttons.filter((b) => b.type === "PHONE_NUMBER" && b.text?.trim() && b.phoneNumber?.trim()).slice(0, 1);
  const copyCodes = buttons.filter((b) => b.type === "COPY_CODE" && b.example?.trim()).slice(0, 1);

  const ordered = [
    ...quickReplies.map((b) => ({ type: "QUICK_REPLY", text: b.text!.trim() })),
    ...urls.map((b) => ({ type: "URL", text: b.text!.trim(), url: b.url!.trim() })),
    ...phones.map((b) => ({
      type: "PHONE_NUMBER",
      text: b.text!.trim(),
      phone_number: b.phoneNumber!.replace(/[^\d+]/g, ""),
    })),
    ...copyCodes.map((b) => ({ type: "COPY_CODE", example: b.example!.trim().slice(0, 20) })),
  ];

  if (ordered.length === 0) return null;
  return { type: "BUTTONS", buttons: ordered };
}

// Submits a new message template to Meta for approval. Approval usually takes
// minutes to a couple of days; status is APPROVED / PENDING / REJECTED.
export async function createMetaMessageTemplate(params: {
  metaTemplateName: string;
  category: string; // MARKETING, UTILITY, AUTHENTICATION
  language: string;
  bodyText: string;
  headerType?: string; // NONE, TEXT, IMAGE
  headerText?: string;
  headerImageUrl?: string;
  footerText?: string;
  buttons?: TemplateButtonInput[];
}): Promise<{ id: string; status: string }> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!accessToken || !wabaId) {
    throw new Error("WHATSAPP_ACCESS_TOKEN or WHATSAPP_BUSINESS_ACCOUNT_ID is not set");
  }

  const components: Record<string, unknown>[] = [];

  if (params.category === "AUTHENTICATION") {
    // Meta's Authentication category has a fixed, Meta-written body ("<code>
    // is your verification code.") — it does NOT accept custom header/body/
    // footer text at all; submitting one (as this form used to, for every
    // category) gets silently rejected on review. The only things a
    // business can configure here are the two toggles below and an optional
    // OTP button, so any header/body/footer text typed into the form is
    // intentionally ignored for this one category and Meta's required shape
    // is built directly instead.
    components.push({ type: "BODY", add_security_recommendation: true });
    components.push({ type: "FOOTER", code_expiration_minutes: 10 });
    components.push({ type: "BUTTONS", buttons: [{ type: "OTP", otp_type: "COPY_CODE" }] });
  } else {
    if (params.headerType === "TEXT" && params.headerText?.trim()) {
      components.push({ type: "HEADER", format: "TEXT", text: params.headerText.trim().slice(0, 60) });
    } else if (params.headerType === "IMAGE" && params.headerImageUrl) {
      const handle = await uploadMediaHandleForTemplate(params.headerImageUrl);
      components.push({ type: "HEADER", format: "IMAGE", example: { header_handle: [handle] } });
    }

    const example = buildBodyExample(params.bodyText);
    const bodyComponent: Record<string, unknown> = { type: "BODY", text: params.bodyText };
    if (example) {
      bodyComponent.example = { body_text: [example] };
    }
    components.push(bodyComponent);

    if (params.footerText?.trim()) {
      components.push({ type: "FOOTER", text: params.footerText.trim().slice(0, 60) });
    }

    const buttonsComponent = buildButtonsComponent(params.buttons);
    if (buttonsComponent) {
      components.push(buttonsComponent);
    }
  }

  const res = await fetch(`${WHATSAPP_API_BASE}/${wabaId}/message_templates`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: params.metaTemplateName,
      category: params.category,
      language: params.language,
      components,
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    const e = data?.error;
    const errMessage = e
      ? `${e.message || ""} ${e.error_user_title || ""} ${e.error_user_msg || ""} (subcode ${e.error_subcode ?? "n/a"}, fbtrace_id ${e.fbtrace_id ?? "n/a"})`.trim()
      : JSON.stringify(data);
    throw new Error(`Meta template creation failed: ${res.status} ${errMessage}`);
  }

  // Meta returns { id, status, category } — status is usually "PENDING" right after creation.
  return { id: data.id as string, status: (data.status as string) || "PENDING" };
}

// Polls Meta for the current approval status of a template by its Meta-assigned id.
export async function getMetaTemplateStatus(metaTemplateId: string): Promise<string> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error("WHATSAPP_ACCESS_TOKEN is not set");
  }

  const res = await fetch(`${WHATSAPP_API_BASE}/${metaTemplateId}?fields=status`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = await res.json();
  if (!res.ok) {
    const errMessage = data?.error?.message || JSON.stringify(data);
    throw new Error(`Meta template status check failed: ${res.status} ${errMessage}`);
  }

  return (data.status as string) || "PENDING";
}

// Looks up what Meta ACTUALLY has on file for a template name — every
// language variant, each with its own status. This exists because the
// status/language shown in our own dashboard is a snapshot from when the
// template was created/last refreshed; it can drift from what Meta's
// sending infrastructure has live, which is what actually matters when a
// send fails with "template name does not exist in <language>". Debug tool,
// not used in the normal create/send flow.
export async function debugLookupMetaTemplate(name: string): Promise<Array<Record<string, unknown>>> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!accessToken || !wabaId) {
    throw new Error("WHATSAPP_ACCESS_TOKEN or WHATSAPP_BUSINESS_ACCOUNT_ID is not set");
  }

  const res = await fetch(
    `${WHATSAPP_API_BASE}/${wabaId}/message_templates?name=${encodeURIComponent(name)}&fields=name,language,status,category,id,rejected_reason`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!res.ok) {
    const errMessage = data?.error?.message || JSON.stringify(data);
    throw new Error(`Meta template lookup failed: ${res.status} ${errMessage}`);
  }
  return (data.data as Array<Record<string, unknown>>) || [];
}

// Deletes a template from Meta by name (removes all language variants of that
// name). Safe to call on a PENDING or REJECTED template too, not just APPROVED.
export async function deleteMetaMessageTemplate(metaTemplateName: string): Promise<void> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!accessToken || !wabaId) {
    throw new Error("WHATSAPP_ACCESS_TOKEN or WHATSAPP_BUSINESS_ACCOUNT_ID is not set");
  }

  const res = await fetch(
    `${WHATSAPP_API_BASE}/${wabaId}/message_templates?name=${encodeURIComponent(metaTemplateName)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  const data = await res.json();
  if (!res.ok) {
    const errMessage = data?.error?.message || JSON.stringify(data);
    throw new Error(`Meta template deletion failed: ${res.status} ${errMessage}`);
  }
}
