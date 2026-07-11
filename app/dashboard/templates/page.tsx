import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { createMetaMessageTemplate, getMetaTemplateStatus } from "@/lib/whatsapp";
import { revalidatePath } from "next/cache";
import { formatDate } from "@/lib/formatDate";

function toMetaTemplateName(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 512);
}

async function createTemplate(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const name = formData.get("name") as string;
  const category = formData.get("category") as string;
  const language = formData.get("language") as string;
  const bodyText = formData.get("bodyText") as string;
  if (!name || !category || !language || !bodyText) return;

  const metaTemplateName = toMetaTemplateName(name);

  const template = await prisma.messageTemplate.create({
    data: {
      organizationId: user.organizationId,
      name,
      metaTemplateName,
      category,
      language,
      bodyText,
      status: "PENDING",
    },
  });

  try {
    const result = await createMetaMessageTemplate({
      metaTemplateName,
      category,
      language,
      bodyText,
    });

    await prisma.messageTemplate.update({
      where: { id: template.id },
      data: { metaTemplateId: result.id, status: result.status },
    });
  } catch (err) {
    await prisma.messageTemplate.update({
      where: { id: template.id },
      data: { status: "REJECTED", rejectionReason: String(err) },
    });
    console.error("Meta template creation failed:", err);
  }

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "TEMPLATE_CREATED",
    metadata: { templateId: template.id, name, metaTemplateName },
  });

  revalidatePath("/dashboard/templates");
}

async function refreshStatus(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const templateId = formData.get("templateId") as string;
  const template = await prisma.messageTemplate.findFirst({
    where: { id: templateId, organizationId: user.organizationId },
  });
  if (!template || !template.metaTemplateId) return;

  try {
    const status = await getMetaTemplateStatus(template.metaTemplateId);
    await prisma.messageTemplate.update({
      where: { id: template.id },
      data: { status },
    });
  } catch (err) {
    console.error("Template status refresh failed:", err);
  }

  revalidatePath("/dashboard/templates");
}

function statusBadgeClass(status: string) {
  if (status === "APPROVED") return "bg-emerald-100 text-emerald-700";
  if (status === "REJECTED") return "bg-red-100 text-red-700";
  return "bg-amber-100 text-amber-700";
}

export default async function TemplatesPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const templates = await prisma.messageTemplate.findMany({
    where: { organizationId: user.organizationId },
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
        variables (e.g. customer name).
      </p>

      <div className="mt-5 rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Create new template</h3>
        <form action={createTemplate} className="mt-3 flex max-w-xl flex-col gap-2">
          <input name="name" placeholder="Internal name (e.g. Eid Offer)" required className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          <select name="category" required defaultValue="MARKETING" className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="MARKETING">Marketing</option>
            <option value="UTILITY">Utility</option>
            <option value="AUTHENTICATION">Authentication</option>
          </select>
          <select name="language" required defaultValue="bn" className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="bn">Bengali</option>
            <option value="en">English</option>
            <option value="en_US">English (US)</option>
          </select>
          <textarea
            name="bodyText"
            placeholder={"e.g. Hi {{1}}, Eid Mubarak! Enjoy 20% off this week at Banglar Doi."}
            required
            rows={4}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <button type="submit" className="self-start rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light">
            Submit for Approval
          </button>
        </form>
      </div>

      <h3 className="mt-6 text-sm font-semibold text-gray-900">Templates</h3>
      <div className="mt-3 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-xs text-gray-500">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Category</th>
              <th className="px-4 py-3 font-medium">Language</th>
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
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusBadgeClass(t.status)}`}>{t.status}</span>
                </td>
                <td className="px-4 py-3 text-gray-500">{formatDate(t.createdAt)}</td>
                <td className="px-4 py-3">
                  {t.status === "PENDING" && t.metaTemplateId && (
                    <form action={refreshStatus}>
                      <input type="hidden" name="templateId" value={t.id} />
                      <button type="submit" className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50">
                        Refresh
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
            {templates.some((t) => t.status === "REJECTED" && t.rejectionReason) && (
              <tr>
                <td className="px-4 py-3 text-xs text-red-700" colSpan={6}>
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
                <td className="px-4 py-6 text-gray-500" colSpan={6}>
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
