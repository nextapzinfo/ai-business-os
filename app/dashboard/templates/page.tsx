import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { formatDate } from "@/lib/formatDate";
import { refreshStatus, deleteTemplate } from "./actions";
import TemplateForm from "@/components/TemplateForm";
import ConfirmSubmitButton from "@/components/ConfirmSubmitButton";

function statusBadgeClass(status: string) {
  if (status === "APPROVED") return "bg-emerald-100 text-emerald-700";
  if (status === "REJECTED") return "bg-red-100 text-red-700";
  return "bg-amber-100 text-amber-700";
}

function templateSummary(t: { headerType: string; footerText: string | null; buttons: string | null }): string {
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

export default async function TemplatesPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const templates = await prisma.messageTemplate.findMany({
    where: { organizationId: user.organizationId },
    include: { _count: { select: { broadcasts: true } } },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">Message Templates</h1>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">
        Templates must be approved by Meta before use in a bulk broadcast (required outside the
        24-hour customer window). Approval usually takes a few minutes to a couple of days. Use{" "}
        <code className="rounded bg-gray-100 px-1">{"{{1}}"}</code>,{" "}
        <code className="rounded bg-gray-100 px-1">{"{{2}}"}</code> etc. in the body text for
        variables (e.g. customer name). Header, footer, and buttons are optional — header/footer
        text and button URLs/numbers must be static (no variables) for now.
      </p>

      <div className="mt-5 rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Create new template</h3>
        <TemplateForm />
      </div>

      <h3 className="mt-6 text-sm font-semibold text-gray-900">Templates</h3>
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
                <td className="px-4 py-3 font-medium text-gray-900">{t.name}</td>
                <td className="px-4 py-3 text-gray-600">{t.category}</td>
                <td className="px-4 py-3 text-gray-600">{t.language}</td>
                <td className="px-4 py-3 text-xs text-gray-400">{templateSummary(t) || "—"}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusBadgeClass(t.status)}`}>{t.status}</span>
                </td>
                <td className="px-4 py-3 text-gray-500">{formatDate(t.createdAt)}</td>
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
                    {t._count.broadcasts === 0 ? (
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
            {templates.some((t) => t.status === "REJECTED" && t.rejectionReason) && (
              <tr>
                <td className="px-4 py-3 text-xs text-red-700" colSpan={7}>
                  {templates
                    .filter((t) => t.status === "REJECTED" && t.rejectionReason)
                    .map((t) => (
                      <div key={t.id} className="mb-1">
                        <strong>{t.name}:</strong> {t.rejectionReason}
                      </div>
                    ))}
                </td>
              </tr>
            )}
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
    </div>
  );
}
