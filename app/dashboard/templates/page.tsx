import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { createMetaMessageTemplate, getMetaTemplateStatus } from "@/lib/whatsapp";
import { revalidatePath } from "next/cache";

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

export default async function TemplatesPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const templates = await prisma.messageTemplate.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div>
      <h1>Message Templates</h1>
      <p style={{ color: "#666", fontSize: 14 }}>
        Templates must be approved by Meta before they can be used in a bulk
        broadcast (required for messaging customers outside the 24-hour
        window). Approval usually takes a few minutes to a couple of days.
        Use <code>{"{{1}}"}</code>, <code>{"{{2}}"}</code> etc. in the body
        text for variables (e.g. customer name).
      </p>

      <h3 style={{ marginTop: 24 }}>Create new template</h3>
      <form
        action={createTemplate}
        style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 600 }}
      >
        <input name="name" placeholder="Internal name (e.g. Eid Offer)" required style={inputStyle} />
        <select name="category" required style={inputStyle} defaultValue="MARKETING">
          <option value="MARKETING">Marketing</option>
          <option value="UTILITY">Utility</option>
          <option value="AUTHENTICATION">Authentication</option>
        </select>
        <select name="language" required style={inputStyle} defaultValue="bn">
          <option value="bn">Bengali</option>
          <option value="en">English</option>
          <option value="en_US">English (US)</option>
        </select>
        <textarea
          name="bodyText"
          placeholder={"e.g. Hi {{1}}, Eid Mubarak! Enjoy 20% off this week at Banglar Doi."}
          required
          rows={4}
          style={{ ...inputStyle, fontFamily: "inherit" }}
        />
        <button type="submit" style={{ ...buttonStyle, alignSelf: "flex-start" }}>
          Submit for Approval
        </button>
      </form>

      <h3 style={{ marginTop: 32 }}>Templates</h3>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          background: "#fff",
          marginTop: 8,
        }}
      >
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e5e5" }}>
            <th style={thStyle}>Name</th>
            <th style={thStyle}>Category</th>
            <th style={thStyle}>Language</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Created</th>
            <th style={thStyle}></th>
          </tr>
        </thead>
        <tbody>
          {templates.map((t) => (
            <tr key={t.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
              <td style={tdStyle}>{t.name}</td>
              <td style={tdStyle}>{t.category}</td>
              <td style={tdStyle}>{t.language}</td>
              <td style={tdStyle}>
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: 4,
                    fontSize: 12,
                    background:
                      t.status === "APPROVED"
                        ? "#dcfce7"
                        : t.status === "REJECTED"
                        ? "#fee2e2"
                        : "#fef9c3",
                    color:
                      t.status === "APPROVED"
                        ? "#166534"
                        : t.status === "REJECTED"
                        ? "#991b1b"
                        : "#854d0e",
                  }}
                >
                  {t.status}
                </span>
              </td>
              <td style={tdStyle}>{t.createdAt.toLocaleDateString()}</td>
              <td style={tdStyle}>
                {t.status === "PENDING" && t.metaTemplateId && (
                  <form action={refreshStatus}>
                    <input type="hidden" name="templateId" value={t.id} />
                    <button type="submit" style={{ ...buttonStyle, padding: "4px 10px", fontSize: 12 }}>
                      Refresh
                    </button>
                  </form>
                )}
              </td>
            </tr>
          ))}
          {templates.some((t) => t.status === "REJECTED" && t.rejectionReason) && (
            <tr>
              <td style={{ ...tdStyle, fontSize: 12, color: "#991b1b" }} colSpan={6}>
                {templates
                  .filter((t) => t.status === "REJECTED" && t.rejectionReason)
                  .map((t) => (
                    <div key={t.id} style={{ marginBottom: 4 }}>
                      <strong>{t.name}:</strong> {t.rejectionReason}
                    </div>
                  ))}
              </td>
            </tr>
          )}
          {templates.length === 0 && (
            <tr>
              <td style={tdStyle} colSpan={6}>
                No templates yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const inputStyle = {
  padding: 8,
  border: "1px solid #ccc",
  borderRadius: 6,
};
const buttonStyle = {
  padding: "8px 16px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
};
const thStyle = { padding: "10px 12px", fontSize: 13, color: "#666" };
const tdStyle = { padding: "10px 12px", fontSize: 14 };