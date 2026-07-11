"use server";

import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { chunkText } from "@/lib/chunk";
import { embedText, toVectorLiteral } from "@/lib/embeddings";
import { revalidatePath } from "next/cache";
import { put } from "@vercel/blob";

export type AgentProfileData = {
  businessName: string;
  greetingMessage: string;
  businessDescription: string;
  tone: string;
  languageStyle: string;
  skillOrderConfirm: boolean;
  skillReminders: boolean;
  skillSendQr: boolean;
};

export async function saveAgentProfile(data: AgentProfileData) {
  const user = await getCurrentUser();
  if (!user) return;

  await prisma.agentProfile.upsert({
    where: { organizationId: user.organizationId },
    update: { ...data },
    create: { organizationId: user.organizationId, ...data },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "AGENT_PROFILE_UPDATED",
  });

  revalidatePath("/dashboard/agent");
}

// Shared by both the "paste text" and "upload file" Knowledge tab forms — chunks
// the raw text, embeds each chunk, and marks the Document PROCESSED/FAILED.
async function processKnowledgeContent(organizationId: string, documentId: string, content: string) {
  try {
    const trimmed = content.trim();
    if (!trimmed) throw new Error("No readable text found.");

    const pieces = chunkText(trimmed);

    for (let i = 0; i < pieces.length; i++) {
      const chunk = await prisma.documentChunk.create({
        data: {
          organizationId,
          documentId,
          content: pieces[i],
          chunkIndex: i,
        },
      });

      const embedding = await embedText(pieces[i], "document");
      const vectorLiteral = toVectorLiteral(embedding);

      await prisma.$executeRaw`
        UPDATE "DocumentChunk" SET embedding = ${vectorLiteral}::vector WHERE id = ${chunk.id}
      `;
    }

    await prisma.document.update({
      where: { id: documentId },
      data: { status: "PROCESSED" },
    });
  } catch (err) {
    await prisma.document.update({
      where: { id: documentId },
      data: { status: "FAILED" },
    });
    console.error("Knowledge content processing failed:", err);
  }
}

// Extracts plain text from an uploaded Knowledge file. PDF/DOCX use small
// dedicated parser libraries; everything else (txt, csv, md) is read as-is.
async function extractTextFromFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  const buffer = Buffer.from(await file.arrayBuffer());

  if (name.endsWith(".pdf")) {
    const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default as (
      data: Buffer
    ) => Promise<{ text: string }>;
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (name.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (name.endsWith(".doc")) {
    throw new Error("Old .doc format isn't supported — save as .docx or .pdf and try again.");
  }

  // txt, csv, md, and anything else plain-text
  return buffer.toString("utf-8");
}

// Knowledge tab (Agent Studio) — this is the same underlying Document/DocumentChunk
// pipeline that used to live on its own "/dashboard/documents" page; it now lives
// inside Agent Studio since the knowledge base is really just part of configuring
// the agent (matches AiSensy's "Knowledge" tab under Chat agent).
export async function addKnowledgeDocument(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return;

  const title = (formData.get("title") as string)?.trim();
  const content = (formData.get("content") as string)?.trim();
  if (!title || !content) return;

  const document = await prisma.document.create({
    data: {
      organizationId: user.organizationId,
      title,
      fileUrl: "pasted-text",
      status: "PENDING",
    },
  });

  await processKnowledgeContent(user.organizationId, document.id, content);

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "DOCUMENT_UPLOADED",
    metadata: { documentId: document.id, title },
  });

  revalidatePath("/dashboard/agent");
}

// File version of the above — accepts PDF/DOCX/TXT/CSV, extracts the text, then
// runs it through the same chunk+embed pipeline.
export async function uploadKnowledgeFile(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return;

  const file = formData.get("file") as File | null;
  const titleInput = (formData.get("title") as string)?.trim();
  if (!file || file.size === 0) return;

  const title = titleInput || file.name.replace(/\.[^/.]+$/, "");

  const document = await prisma.document.create({
    data: {
      organizationId: user.organizationId,
      title,
      fileUrl: `uploaded-file:${file.name}`,
      status: "PENDING",
    },
  });

  try {
    const content = await extractTextFromFile(file);
    await processKnowledgeContent(user.organizationId, document.id, content);
  } catch (err) {
    await prisma.document.update({ where: { id: document.id }, data: { status: "FAILED" } });
    console.error("Knowledge file text extraction failed:", err);
  }

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "DOCUMENT_FILE_UPLOADED",
    metadata: { documentId: document.id, title, fileName: file.name },
  });

  revalidatePath("/dashboard/agent");
}

export async function deleteKnowledgeDocument(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return;

  const documentId = formData.get("documentId") as string;
  if (!documentId) return;

  const document = await prisma.document.findFirst({
    where: { id: documentId, organizationId: user.organizationId },
    include: { product: true },
  });
  if (!document) return;

  // A Document linked to a Product cascades to delete the Product too if removed
  // here — that should only happen from the Products page, so refuse it here.
  if (document.product) return;

  await prisma.document.delete({ where: { id: documentId } });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "DOCUMENT_DELETED",
    metadata: { documentId, title: document.title },
  });

  revalidatePath("/dashboard/agent");
}

// Payment QR — this is a fixed image the owner uploads once (their real UPI/payment
// QR); the AI never generates one, it just re-sends this exact image when a
// customer asks about payment (see the skillSendQr check in the WhatsApp webhook).
export async function uploadQrCode(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return;

  const file = formData.get("qr") as File | null;
  if (!file || file.size === 0) return;

  let blobUrl: string;
  try {
    const blob = await put(`qr/${user.organizationId}-${file.name}`, file, {
      access: "public",
      addRandomSuffix: true,
    });
    blobUrl = blob.url;
  } catch (err) {
    console.error("QR code upload failed:", err);
    return;
  }

  await prisma.agentProfile.upsert({
    where: { organizationId: user.organizationId },
    update: { qrCodeUrl: blobUrl },
    create: { organizationId: user.organizationId, qrCodeUrl: blobUrl },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "QR_CODE_UPLOADED",
  });

  revalidatePath("/dashboard/agent");
}
