"use client";

import { useEffect, useRef, useState } from "react";
import { Zap } from "lucide-react";
import ConfirmSubmitButton from "@/components/ConfirmSubmitButton";
import { sendTemplateToClient } from "@/app/dashboard/conversations/[id]/actions";

type TemplateOption = { id: string; name: string; language: string };

// A single compact control (matches the minimal "Send Template" pattern in
// other WhatsApp tools) instead of a permanent select+button+explainer block
// taking up chat space. Click it to reveal the approved-template list;
// picking one asks for confirmation (it's a real, billed WhatsApp send)
// before actually submitting.
//
// `compact` (2026-08-28, owner's own request: put this "only there" as a sign
// alongside Quick Reply, right in the WhatsApp-style input row, instead of a
// separate wide pill in its own row above it) renders it as a small icon-only
// button matching the other in-pill icons (Quick Reply, Attach) — same
// dropdown behavior, just a lot narrower on screen. The default (non-compact)
// full pill is kept for any future spot that has room to spare.
export default function SendTemplateButton({
  conversationId,
  templates,
  compact = false,
}: {
  conversationId: string;
  templates: TemplateOption[];
  compact?: boolean;
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
        title="Send Template"
        className={
          compact
            ? "flex-shrink-0 p-1 text-gray-400 hover:text-gray-600"
            : "flex h-[44px] items-center gap-1.5 rounded-full border border-primary px-3 text-xs font-medium text-primary hover:bg-primary/5"
        }
      >
        <Zap size={compact ? 19 : 13} />
        {!compact && "Send Template"}
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-10 mb-2 w-56 rounded-lg border border-gray-200 bg-white p-1.5 shadow-lg">
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
