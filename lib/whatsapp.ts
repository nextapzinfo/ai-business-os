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

// Sends an already-Meta-approved template message. Required for messaging a
// customer outside the 24-hour service window (e.g. bulk broadcasts).
export async function sendWhatsAppTemplateMessage(
  to: string,
  metaTemplateName: string,
  languageCode: string,
  bodyVariables: string[] = []
): Promise<void> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) {
    throw new Error("WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID is not set");
  }

  const components =
    bodyVariables.length > 0
      ? [
          {
            type: "body",
            parameters: bodyVariables.map((v) => ({ type: "text", text: v })),
          },
        ]
      : undefined;

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
        ...(components ? { components } : {}),
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
