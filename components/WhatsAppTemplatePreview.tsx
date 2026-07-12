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

// Shared WhatsApp-bubble-style renderer — used both for the live preview while
// creating a template (TemplateForm.tsx, fed from in-progress form state) and
// for the read-only popup when clicking an existing template (TemplatesTable.tsx,
// fed from saved DB data). Keeping one renderer means both always look the same.
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
    <div className="rounded-xl bg-[#e5ddd5] p-3">
      <div className="overflow-hidden rounded-lg bg-white shadow-sm">
        {headerType === "IMAGE" && (
          <div className="flex h-32 w-full items-center justify-center bg-gray-100 text-gray-300">
            {headerImageUrl ? (
              <img src={headerImageUrl} alt="Header preview" className="h-full w-full object-cover" />
            ) : (
              <ImageIcon size={28} />
            )}
          </div>
        )}
        <div className="p-3">
          {headerType === "TEXT" && headerText && (
            <p className="text-sm font-semibold text-gray-900">{headerText}</p>
          )}
          <p className="mt-1 whitespace-pre-wrap text-sm text-gray-800">
            {bodyText || <span className="text-gray-300">Body text will appear here...</span>}
          </p>
          {footerText && <p className="mt-1.5 text-xs text-gray-400">{footerText}</p>}
        </div>
        {buttons.length > 0 && (
          <div className="flex flex-col divide-y divide-gray-100 border-t border-gray-100">
            {buttons.map((b, i) => {
              const Icon = BUTTON_ICON[b.type];
              return (
                <div
                  key={i}
                  className="flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-primary"
                >
                  <Icon size={12} />
                  {buttonPreviewLabel(b)}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
