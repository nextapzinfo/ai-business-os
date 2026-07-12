import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import TemplateForm from "@/components/TemplateForm";
import TemplatesTable, { type TemplateRow } from "@/components/TemplatesTable";

export default async function TemplatesPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const templates = await prisma.messageTemplate.findMany({
    where: { organizationId: user.organizationId },
    include: { _count: { select: { broadcasts: true } } },
    orderBy: { createdAt: "desc" },
  });

  const templateRows: TemplateRow[] = templates.map((t) => ({
    id: t.id,
    name: t.name,
    category: t.category,
    language: t.language,
    status: t.status,
    rejectionReason: t.rejectionReason,
    createdAt: t.createdAt.toISOString(),
    metaTemplateId: t.metaTemplateId,
    headerType: t.headerType,
    headerText: t.headerText,
    headerImageUrl: t.headerImageUrl,
    bodyText: t.bodyText,
    footerText: t.footerText,
    buttons: t.buttons,
    broadcastCount: t._count.broadcasts,
  }));

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">Message Templates</h1>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">
        Templates must be approved by Meta before use in a bulk broadcast (required outside the
        24-hour customer window). Approval usually takes a few minutes to a couple of days. Use{" "}
        <code className="rounded bg-gray-100 px-1">{"{{1}}"}</code>,{" "}
        <code className="rounded bg-gray-100 px-1">{"{{2}}"}</code> etc. in the body text for
        variables (e.g. customer name). Header, footer, and buttons are optional — header/footer
        text and button URLs/numbers must be static (no variables) for now. Click any template
        below to preview it.
      </p>

      <div className="mt-5 rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Create new template</h3>
        <TemplateForm />
      </div>

      <h3 className="mt-6 text-sm font-semibold text-gray-900">Templates</h3>
      <TemplatesTable templates={templateRows} />
    </div>
  );
}
