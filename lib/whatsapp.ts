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

// Submits a new message template to Meta for approval. Approval usually takes
// minutes to a couple of days; status is APPROVED / PENDING / REJECTED.
export async function createMetaMessageTemplate(params: {
  metaTemplateName: string;
  category: string; // MARKETING, UTILITY, AUTHENTICATION
  language: string;
  bodyText: string;
}): Promise<{ id: string; status: string }> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!accessToken || !wabaId) {
    throw new Error("WHATSAPP_ACCESS_TOKEN or WHATSAPP_BUSINESS_ACCOUNT_ID is not set");
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
      components: [{ type: "BODY", text: params.bodyText }],
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    const errMessage = data?.error?.message || JSON.stringify(data);
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