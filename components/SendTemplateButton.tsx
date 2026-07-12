"use client";

import { useEffect, useRef, useState } from "react";
import { Zap } from "lucide-react";
import ConfirmSubmitButton from "@/components/ConfirmSubmitButton";
import { sendTemplateToClient } from "@/app/dashboard/conversations/[id]/actions";

type TemplateOption = { id: string; name: string; language: string };

// A single compact pill button (matches the minimal "Send Template" control
// in other WhatsApp tools) instead of a permanent select+button+explainer
// block taking up chat space. Click it to reveal the approved-template list;
// picking one asks for confirmation (it's a real, billed WhatsApp send)
// before actually submitting.
export default function SendTemplateButton({
  conversationId,
  templates,
}: {
  conversationId: string;
  templates: TemplateOption[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (templates.length === 0) return null;

  return (
    <div ref={ref} className="relative inline-block flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-[44px] items-center gap-1.5 rounded-full border border-primary px-3 text-xs font-medium text-primary hover:bg-primary/5"
      >
        <Zap size={13} />
        Send Template
      </button>

      {open && (
        <div className="absolute bottom-full left-1/2 z-10 mb-2 w-56 -translate-x-1/2 rounded-lg border border-gray-200 bg-white p-1.5 shadow-lg">
          {templates.map((t) => (
            <form key={t.id} action={sendTemplateToClient}>
              <input type="hidden" name="conversationId" value={conversationId} />
              <input type="hidden" name="templateId" value={t.id} />
              <ConfirmSubmitButton
                label={`${t.name} (${t.language})`}
                confirmText={`Send "${t.name}" to this customer now?`}
                className="w-full rounded-md px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50"
              />
            </form>
          ))}
        </div>
      )}
    </div>
  );
}
