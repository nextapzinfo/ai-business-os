"use client";

import { useState } from "react";
import { Plus, X, Image as ImageIcon, ExternalLink, Phone, Copy, CornerUpLeft } from "lucide-react";
import { createTemplate } from "@/app/dashboard/templates/actions";

type ButtonType = "QUICK_REPLY" | "URL" | "PHONE_NUMBER" | "COPY_CODE";
type ButtonRow = { type: ButtonType; text: string; url: string; phoneNumber: string; example: string };

const inputClass = "rounded-lg border border-gray-300 px-3 py-2 text-sm";

const BUTTON_LABEL: Record<ButtonType, string> = {
  QUICK_REPLY: "Quick Reply",
  URL: "URL",
  PHONE_NUMBER: "Phone",
  COPY_CODE: "Copy Code",
};

const BUTTON_ICON: Record<ButtonType, typeof ExternalLink> = {
  QUICK_REPLY: CornerUpLeft,
  URL: ExternalLink,
  PHONE_NUMBER: Phone,
  COPY_CODE: Copy,
};

// Handles the whole "Create new template" form, including the parts that need
// client-side state — conditional header fields and the dynamic buttons list
// (max counts match Meta's real per-type template limits: 3 quick reply,
// 2 URL, 1 phone, 1 copy code). Submits as a normal server-action form; the
// buttons list is serialized into a hidden JSON field right before submit.
// Everything that affects how the message actually looks (header/body/footer/
// buttons) is kept in state so the live preview on the right can mirror it.
export default function TemplateForm() {
  const [headerType, setHeaderType] = useState("NONE");
  const [headerText, setHeaderText] = useState("");
  const [headerImagePreview, setHeaderImagePreview] = useState<string | null>(null);
  const [bodyText, setBodyText] = useState("");
  const [footerText, setFooterText] = useState("");
  const [buttons, setButtons] = useState<ButtonRow[]>([]);

  function addButton(type: ButtonType) {
    setButtons((prev) => [...prev, { type, text: "", url: "", phoneNumber: "", example: "" }]);
  }
  function updateButton(i: number, patch: Partial<ButtonRow>) {
    setButtons((prev) => prev.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  }
  function removeButton(i: number) {
    setButtons((prev) => prev.filter((_, idx) => idx !== i));
  }

  function handleHeaderImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setHeaderImagePreview(file ? URL.createObjectURL(file) : null);
  }

  const quickReplyCount = buttons.filter((b) => b.type === "QUICK_REPLY").length;
  const urlCount = buttons.filter((b) => b.type === "URL").length;
  const phoneCount = buttons.filter((b) => b.type === "PHONE_NUMBER").length;
  const copyCodeCount = buttons.filter((b) => b.type === "COPY_CODE").length;

  const buttonsPayload = buttons.map((b) => {
    if (b.type === "QUICK_REPLY") return { type: b.type, text: b.text };
    if (b.type === "URL") return { type: b.type, text: b.text, url: b.url };
    if (b.type === "PHONE_NUMBER") return { type: b.type, text: b.text, phoneNumber: b.phoneNumber };
    return { type: b.type, example: b.example };
  });

  // Renders each button's label the same way it'll show in the preview and
  // (roughly) how WhatsApp renders it — falls back to a placeholder so an
  // empty row still shows something rather than a blank pill.
  function buttonPreviewLabel(b: ButtonRow): string {
    if (b.type === "COPY_CODE") return b.example ? `Copy code: ${b.example}` : "Copy code";
    return b.text || BUTTON_LABEL[b.type];
  }

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_300px]">
      <form action={createTemplate} className="flex flex-col gap-2">
        <input name="name" placeholder="Internal name (e.g. Eid Offer)" required className={inputClass} />
        <select name="category" required defaultValue="MARKETING" className={inputClass}>
          <option value="MARKETING">Marketing</option>
          <option value="UTILITY">Utility</option>
          <option value="AUTHENTICATION">Authentication</option>
        </select>
        <select name="language" required defaultValue="bn" className={inputClass}>
          <option value="bn">Bengali</option>
          <option value="en">English</option>
          <option value="en_US">English (US)</option>
        </select>

        <label className="text-xs font-medium text-gray-600">
          Header (optional)
          <select
            name="headerType"
            value={headerType}
            onChange={(e) => setHeaderType(e.target.value)}
            className={`${inputClass} mt-1 w-full`}
          >
            <option value="NONE">None</option>
            <option value="TEXT">Text</option>
            <option value="IMAGE">Image</option>
          </select>
        </label>
        {headerType === "TEXT" && (
          <input
            name="headerText"
            value={headerText}
            onChange={(e) => setHeaderText(e.target.value)}
            placeholder="Header text (max 60 characters, no variables)"
            maxLength={60}
            className={inputClass}
          />
        )}
        {headerType === "IMAGE" && (
          <input
            type="file"
            name="headerImage"
            accept="image/*"
            onChange={handleHeaderImageChange}
            className="text-sm"
          />
        )}

        <textarea
          name="bodyText"
          value={bodyText}
          onChange={(e) => setBodyText(e.target.value)}
          placeholder={"e.g. Hi {{1}}, Eid Mubarak! Enjoy 20% off this week at Banglar Doi."}
          required
          rows={4}
          className={inputClass}
        />

        <input
          name="footerText"
          value={footerText}
          onChange={(e) => setFooterText(e.target.value)}
          placeholder="Footer text (optional, max 60 characters)"
          maxLength={60}
          className={inputClass}
        />

        <div className="rounded-lg border border-gray-200 p-2.5">
          <p className="text-xs font-medium text-gray-600">Buttons (optional)</p>
          {buttons.length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              {buttons.map((b, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-20 flex-shrink-0 text-[11px] font-medium text-gray-500">
                    {BUTTON_LABEL[b.type]}
                  </span>
                  {b.type === "QUICK_REPLY" && (
                    <input
                      value={b.text}
                      onChange={(e) => updateButton(i, { text: e.target.value })}
                      placeholder="Button text"
                      maxLength={25}
                      className="w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
                    />
                  )}
                  {b.type === "URL" && (
                    <>
                      <input
                        value={b.text}
                        onChange={(e) => updateButton(i, { text: e.target.value })}
                        placeholder="Button text"
                        maxLength={25}
                        className="w-1/3 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
                      />
                      <input
                        value={b.url}
                        onChange={(e) => updateButton(i, { url: e.target.value })}
                        placeholder="https://..."
                        className="w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
                      />
                    </>
                  )}
                  {b.type === "PHONE_NUMBER" && (
                    <>
                      <input
                        value={b.text}
                        onChange={(e) => updateButton(i, { text: e.target.value })}
                        placeholder="Button text"
                        maxLength={25}
                        className="w-1/3 rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
                      />
                      <input
                        value={b.phoneNumber}
                        onChange={(e) => updateButton(i, { phoneNumber: e.target.value })}
                        placeholder="+8801XXXXXXXXX"
                        className="w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
                      />
                    </>
                  )}
                  {b.type === "COPY_CODE" && (
                    <input
                      value={b.example}
                      onChange={(e) => updateButton(i, { example: e.target.value })}
                      placeholder="Offer code, e.g. EID20"
                      maxLength={20}
                      className="w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => removeButton(i)}
                    className="flex-shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={quickReplyCount >= 3}
              onClick={() => addButton("QUICK_REPLY")}
              className="flex items-center gap-1 rounded-lg border border-dashed border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-500 hover:border-primary hover:text-primary disabled:opacity-40"
            >
              <Plus size={12} /> Quick Reply ({quickReplyCount}/3)
            </button>
            <button
              type="button"
              disabled={urlCount >= 2}
              onClick={() => addButton("URL")}
              className="flex items-center gap-1 rounded-lg border border-dashed border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-500 hover:border-primary hover:text-primary disabled:opacity-40"
            >
              <Plus size={12} /> URL ({urlCount}/2)
            </button>
            <button
              type="button"
              disabled={phoneCount >= 1}
              onClick={() => addButton("PHONE_NUMBER")}
              className="flex items-center gap-1 rounded-lg border border-dashed border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-500 hover:border-primary hover:text-primary disabled:opacity-40"
            >
              <Plus size={12} /> Phone ({phoneCount}/1)
            </button>
            <button
              type="button"
              disabled={copyCodeCount >= 1}
              onClick={() => addButton("COPY_CODE")}
              className="flex items-center gap-1 rounded-lg border border-dashed border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-500 hover:border-primary hover:text-primary disabled:opacity-40"
            >
              <Plus size={12} /> Copy Code ({copyCodeCount}/1)
            </button>
          </div>
        </div>

        <input type="hidden" name="buttonsJson" value={JSON.stringify(buttonsPayload)} readOnly />

        <button
          type="submit"
          className="self-start rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light"
        >
          Submit for Approval
        </button>
      </form>

      {/* Live preview — approximate, not pixel-perfect to WhatsApp, but shows
          header/body/footer/buttons updating together as you type. */}
      <div className="lg:sticky lg:top-4 lg:self-start">
        <p className="text-xs font-medium text-gray-500">Preview</p>
        <div className="mt-2 rounded-xl bg-[#e5ddd5] p-3">
          <div className="overflow-hidden rounded-lg bg-white shadow-sm">
            {headerType === "IMAGE" && (
              <div className="flex h-32 w-full items-center justify-center bg-gray-100 text-gray-300">
                {headerImagePreview ? (
                  <img src={headerImagePreview} alt="Header preview" className="h-full w-full object-cover" />
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
        <p className="mt-2 text-[11px] text-gray-400">
          Approximate preview only — actual WhatsApp rendering may differ slightly.
        </p>
      </div>
    </div>
  );
}
