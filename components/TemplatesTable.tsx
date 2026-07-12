"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { formatDate } from "@/lib/formatDate";
import ConfirmSubmitButton from "@/components/ConfirmSubmitButton";
import WhatsAppTemplatePreview, { type PreviewButton } from "@/components/WhatsAppTemplatePreview";
import { refreshStatus, deleteTemplate } from "@/app/dashboard/templates/actions";

export type TemplateRow = {
  id: string;
  name: string;
  category: string;
  language: string;
  status: string;
  rejectionReason: string | null;
  createdAt: string;
  metaTemplateId: string | null;
  headerType: string;
  headerText: string | null;
  headerImageUrl: string | null;
  bodyText: string;
  footerText: string | null;
  buttons: string | null;
  broadcastCount: number;
};

function statusBadgeClass(status: string) {
  if (status === "APPROVED") return "bg-emerald-100 text-emerald-700";
  if (status === "REJECTED") return "bg-red-100 text-red-700";
  return "bg-amber-100 text-amber-700";
}

function templateSummary(t: TemplateRow): string {
  const parts: string[] = [];
  if (t.headerType === "TEXT") parts.push("Text header");
  if (t.headerType === "IMAGE") parts.push("Image header");
  if (t.footerText) parts.push("Footer");
  if (t.buttons) {
    try {
      const count = (JSON.parse(t.buttons) as unknown[]).length;
      if (count > 0) parts.push(`${count} button${count > 1 ? "s" : ""}`);
    } catch {
      // ignore malformed
    }
  }
  return parts.join(" · ");
}

function parseButtons(raw: string | null): PreviewButton[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as PreviewButton[];
  } catch {
    return [];
  }
}

// Clicking any template — pending, approved, or rejected — opens a popup
// showing what it actually looks like (same renderer as the live create-form
// preview), plus the rejection reason if Meta turned it down.
export default function TemplatesTable({ templates }: { templates: TemplateRow[] }) {
  const [previewing, setPreviewing] = useState<TemplateRow | null>(null);

  return (
    <>
      <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-xs text-gray-500">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Category</th>
              <th className="px-4 py-3 font-medium">Language</th>
              <th className="px-4 py-3 font-medium">Includes</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Created</th>
              <th className="px-4 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id} className="border-b border-gray-50 last:border-0">
                <td className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() => setPreviewing(t)}
                    className="font-medium text-gray-900 hover:text-primary hover:underline"
                  >
                    {t.name}
                  </button>
                </td>
                <td className="px-4 py-3 text-gray-600">{t.category}</td>
                <td className="px-4 py-3 text-gray-600">{t.language}</td>
                <td className="px-4 py-3 text-xs text-gray-400">{templateSummary(t) || "—"}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusBadgeClass(t.status)}`}>
                    {t.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">{formatDate(new Date(t.createdAt))}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {t.status === "PENDING" && t.metaTemplateId && (
                      <form action={refreshStatus}>
                        <input type="hidden" name="templateId" value={t.id} />
                        <button type="submit" className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50">
                          Refresh
                        </button>
                      </form>
                    )}
                    {t.broadcastCount === 0 ? (
                      <form action={deleteTemplate}>
                        <input type="hidden" name="templateId" value={t.id} />
                        <ConfirmSubmitButton
                          label="Delete"
                          confirmText={`Delete "${t.name}"? This also removes it from Meta. This can't be undone.`}
                          className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                        />
                      </form>
                    ) : (
                      <span className="text-xs text-gray-400">Used in a broadcast</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {templates.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-gray-500" colSpan={7}>
                  No templates yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {previewing && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setPreviewing(null)}
        >
          <div
            className="max-h-[85vh] w-full max-w-sm overflow-y-auto rounded-xl bg-white p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold text-gray-900">{previewing.name}</p>
              <button
                type="button"
                onClick={() => setPreviewing(null)}
                className="flex-shrink-0 rounded-lg p-1 text-gray-400 hover:bg-gray-100"
              >
                <X size={16} />
              </button>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-400">
              <span className={`rounded-full px-2 py-0.5 font-semibold ${statusBadgeClass(previewing.status)}`}>
                {previewing.status}
              </span>
              <span>{previewing.category}</span>
              <span>{previewing.language}</span>
            </div>
            {previewing.status === "REJECTED" && previewing.rejectionReason && (
              <p className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-700">{previewing.rejectionReason}</p>
            )}
            <div className="mt-3">
              <WhatsAppTemplatePreview
                headerType={previewing.headerType}
                headerText={previewing.headerText}
                headerImageUrl={previewing.headerImageUrl}
                bodyText={previewing.bodyText}
                footerText={previewing.footerText}
                buttons={parseButtons(previewing.buttons)}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
