"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
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

// Handles the whole "Create new template" form, including the parts that need
// client-side state — conditional header fields and the dynamic buttons list
// (max counts match Meta's real per-type template limits: 3 quick reply,
// 2 URL, 1 phone, 1 copy code). Submits as a normal server-action form; the
// buttons list is serialized into a hidden JSON field right before submit.
export default function TemplateForm() {
  const [headerType, setHeaderType] = useState("NONE");
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

  return (
    <form action={createTemplate} className="mt-3 flex max-w-xl flex-col gap-2">
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
          placeholder="Header text (max 60 characters, no variables)"
          maxLength={60}
          className={inputClass}
        />
      )}
      {headerType === "IMAGE" && (
        <input type="file" name="headerImage" accept="image/*" className="text-sm" />
      )}

      <textarea
        name="bodyText"
        placeholder={"e.g. Hi {{1}}, Eid Mubarak! Enjoy 20% off this week at Banglar Doi."}
        required
        rows={4}
        className={inputClass}
      />

      <input
        name="footerText"
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
  );
}
