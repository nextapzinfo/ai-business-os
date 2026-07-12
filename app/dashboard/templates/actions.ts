"use server";

import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import {
  createMetaMessageTemplate,
  getMetaTemplateStatus,
  deleteMetaMessageTemplate,
  type TemplateButtonInput,
} from "@/lib/whatsapp";
import { revalidatePath } from "next/cache";
import { put } from "@vercel/blob";

function toMetaTemplateName(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 512);
}

export async function createTemplate(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return;

  const name = formData.get("name") as string;
  const category = formData.get("category") as string;
  const language = formData.get("language") as string;
  const bodyText = formData.get("bodyText") as string;
  if (!name || !category || !language || !bodyText) return;

  const headerType = (formData.get("headerType") as string) || "NONE";
  const headerText = (formData.get("headerText") as string)?.trim() || undefined;
  const footerText = (formData.get("footerText") as string)?.trim() || undefined;

  let headerImageUrl: string | undefined;
  const headerImageFile = formData.get("headerImage") as File | null;
  if (headerType === "IMAGE" && headerImageFile && headerImageFile.size > 0) {
    try {
      const blob = await put(`template-headers/${user.organizationId}-${headerImageFile.name}`, headerImageFile, {
        access: "public",
        addRandomSuffix: true,
      });
      headerImageUrl = blob.url;
    } catch (err) {
      console.error("Template header image upload failed:", err);
    }
  }

  let buttons: TemplateButtonInput[] = [];
  try {
    buttons = JSON.parse((formData.get("buttonsJson") as string) || "[]");
  } catch {
    buttons = [];
  }

  const metaTemplateName = toMetaTemplateName(name);

  const template = await prisma.messageTemplate.create({
    data: {
      organizationId: user.organizationId,
      name,
      metaTemplateName,
      category,
      language,
      bodyText,
      headerType,
      headerText,
      headerImageUrl,
      footerText,
      buttons: buttons.length > 0 ? JSON.stringify(buttons) : null,
      status: "PENDING",
    },
  });

  try {
    const result = await createMetaMessageTemplate({
      metaTemplateName,
      category,
      language,
      bodyText,
      headerType,
      headerText,
      headerImageUrl,
      footerText,
      buttons,
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

export async function refreshStatus(formData: FormData) {
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

// A template that's already been used in a Broadcast can't be deleted — the
// Broadcast row references it (Prisma's default onDelete: Restrict), and
// keeping that history intact matters more than tidying the list. The UI
// hides the Delete button in that case; this is the server-side backstop.
export async function deleteTemplate(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return;

  const templateId = formData.get("templateId") as string;
  if (!templateId) return;

  const template = await prisma.messageTemplate.findFirst({
    where: { id: templateId, organizationId: user.organizationId },
    include: { _count: { select: { broadcasts: true } } },
  });
  if (!template || template._count.broadcasts > 0) return;

  if (template.metaTemplateId) {
    try {
      await deleteMetaMessageTemplate(template.metaTemplateName);
    } catch (err) {
      // Still remove it from our list even if Meta's side fails (e.g. it was
      // already deleted there, or never made it past PENDING) — don't let a
      // stale Meta template block cleaning up the dashboard.
      console.error("Meta template deletion failed:", err);
    }
  }

  await prisma.messageTemplate.delete({ where: { id: templateId } });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "TEMPLATE_DELETED",
    metadata: { templateId, name: template.name },
  });

  revalidatePath("/dashboard/templates");
}
