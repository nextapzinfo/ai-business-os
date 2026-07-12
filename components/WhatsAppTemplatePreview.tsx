"use client";

import { Image as ImageIcon, ExternalLink, Phone, Copy, CornerUpLeft } from "lucide-react";

export type PreviewButtonType = "QUICK_REPLY" | "URL" | "PHONE_NUMBER" | "COPY_CODE";
export type PreviewButton = {
  type: PreviewButtonType;
  text?: string;
  url?: string;
  phoneNumber?: string;
  example?: string;
};

const BUTTON_LABEL: Record<PreviewButtonType, string> = {
  QUICK_REPLY: "Quick Reply",
  URL: "URL",
  PHONE_NUMBER: "Phone",
  COPY_CODE: "Copy Code",
};

const BUTTON_ICON: Record<PreviewButtonType, typeof ExternalLink> = {
  QUICK_REPLY: CornerUpLeft,
  URL: ExternalLink,
  PHONE_NUMBER: Phone,
  COPY_CODE: Copy,
};

function buttonPreviewLabel(b: PreviewButton): string {
  if (b.type === "COPY_CODE") return b.example ? `Copy code: ${b.example}` : "Copy code";
  return b.text || BUTTON_LABEL[b.type];
}

// Shared WhatsApp-bubble-style renderer, styled as a mini phone screen (header
// bar + wallpaper + a real-looking sent bubble) — used both for the live
// preview while creating a template (TemplateForm.tsx, fed from in-progress
// form state) and for the read-only popup when clicking an existing template
// (TemplatesTable.tsx, fed from saved DB data). One renderer means both
// always look the same. No timestamp/checkmark shown here on purpose — this
// is a preview, not a real sent message, so faking a "sent" status would be
// misleading.
export default function WhatsAppTemplatePreview({
  headerType,
  headerText,
  headerImageUrl,
  bodyText,
  footerText,
  buttons,
}: {
  headerType: string;
  headerText?: string | null;
  headerImageUrl?: string | null;
  bodyText: string;
  footerText?: string | null;
  buttons: PreviewButton[];
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-300 shadow-sm">
      <div className="flex items-center gap-2 bg-[#075e54] px-3 py-2">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-white/20 text-white">
          <ImageIcon size={14} />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">Business Account</p>
          <p className="truncate text-[11px] text-white/70">Template preview</p>
        </div>
      </div>

      <div className="bg-[#e5ddd5] p-3">
        <div className="ml-auto max-w-[85%] overflow-hidden rounded-2xl rounded-tr-none bg-[#d9fdd3] shadow-sm">
          {headerType === "IMAGE" && (
            <div className="flex h-32 w-full items-center justify-center bg-gray-100 text-gray-300">
              {headerImageUrl ? (
                <img src={headerImageUrl} alt="Header preview" className="h-full w-full object-cover" />
              ) : (
                <ImageIcon size={28} />
              )}
            </div>
          )}
          <div className="px-2.5 py-1.5">
            {headerType === "TEXT" && headerText && (
              <p className="text-[13px] font-semibold text-gray-900">{headerText}</p>
            )}
            <p className="whitespace-pre-wrap text-[13px] text-gray-900">
              {bodyText || <span className="text-gray-400">Body text will appear here...</span>}
            </p>
            {footerText && <p className="mt-1 text-[11px] text-gray-500">{footerText}</p>}
          </div>
          {buttons.length > 0 && (
            <div className="flex flex-col divide-y divide-black/10 border-t border-black/10">
              {buttons.map((b, i) => {
                const Icon = BUTTON_ICON[b.type];
                return (
                  <div
                    key={i}
                    className="flex items-center justify-center gap-1.5 py-2 text-[13px] font-medium text-[#00a5f4]"
                  >
                    <Icon size={13} />
                    {buttonPreviewLabel(b)}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
