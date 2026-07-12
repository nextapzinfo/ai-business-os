"use server";

import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { chunkText } from "@/lib/chunk";
import { embedText, toVectorLiteral } from "@/lib/embeddings";
import { revalidatePath } from "next/cache";
import { put, del } from "@vercel/blob";

export type AgentProfileData = {
  businessName: string;
  greetingMessage: string;
  businessDescription: string;
  tone: string;
  languageStyle: string;
  skillOrderConfirm: boolean;
  skillReminders: boolean;
  skillSendQr: boolean;
  skillSaveAddress: boolean;
  skillTrackInterest: boolean;
  skillSendEventPhotos: boolean;
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
      data: { status: "PROCESSED", content: trimmed },
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
    const { default: pdfParse } = await import("pdf-parse");
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

// Fetches a public webpage and strips it down to readable text — scripts,
// styles, nav/header/footer chrome all removed, so only the actual page
// content reaches the knowledge base. Doesn't work for pages that require
// login or heavy client-side rendering (e.g. Facebook) — those need to be
// copy-pasted into the "paste text" form instead.
async function fetchPageText(pageUrl: string): Promise<{ text: string; pageTitle: string }> {
  const res = await fetch(pageUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; AIBusinessOSBot/1.0; +https://vercel.app)" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Failed to fetch page: ${res.status}`);

  const html = await res.text();
  const cheerio = await import("cheerio");
  const $ = cheerio.load(html);

  const pageTitle = $("title").first().text().trim();
  $("script, style, nav, footer, header, noscript, svg, iframe, form").remove();
  const text = $("body").text().replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

  // Cap length so one giant page doesn't blow up chunking/embedding time/cost.
  return { text: text.slice(0, 20000), pageTitle };
}

export async function crawlWebsite(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return;

  const urlInput = (formData.get("url") as string)?.trim();
  const titleInput = (formData.get("title") as string)?.trim();
  if (!urlInput) return;

  let pageUrl: URL;
  try {
    pageUrl = new URL(urlInput);
  } catch {
    return; // not a valid URL — nothing to crawl
  }
  if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") return;

  const document = await prisma.document.create({
    data: {
      organizationId: user.organizationId,
      title: titleInput || pageUrl.hostname,
      fileUrl: `crawled:${pageUrl.toString()}`,
      status: "PENDING",
    },
  });

  try {
    const { text, pageTitle } = await fetchPageText(pageUrl.toString());
    if (!titleInput && pageTitle) {
      await prisma.document.update({ where: { id: document.id }, data: { title: pageTitle } });
    }
    await processKnowledgeContent(user.organizationId, document.id, text);
  } catch (err) {
    await prisma.document.update({ where: { id: document.id }, data: { status: "FAILED" } });
    console.error("Website crawl failed:", err);
  }

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "DOCUMENT_CRAWLED",
    metadata: { documentId: document.id, url: pageUrl.toString() },
  });

  revalidatePath("/dashboard/agent");
}

// Lets staff fix a knowledge source's text directly instead of delete+recreate —
// re-chunks and re-embeds from scratch so the AI's answers reflect the edit.
export async function updateKnowledgeDocument(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return;

  const documentId = formData.get("documentId") as string;
  const title = (formData.get("title") as string)?.trim();
  const content = (formData.get("content") as string)?.trim();
  if (!documentId || !title || !content) return;

  const document = await prisma.document.findFirst({
    where: { id: documentId, organizationId: user.organizationId },
    include: { product: true },
  });
  if (!document) return;

  // Product-linked documents are managed from the Products page (their text is
  // built from name/price/description) — editing raw text here would drift out
  // of sync with that, so refuse it here.
  if (document.product) return;

  await prisma.document.update({ where: { id: documentId }, data: { title } });
  await prisma.documentChunk.deleteMany({ where: { documentId } });
  await processKnowledgeContent(user.organizationId, documentId, content);

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "DOCUMENT_UPDATED",
    metadata: { documentId, title },
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

export async function deleteQrCode() {
  const user = await getCurrentUser();
  if (!user) return;

  const profile = await prisma.agentProfile.findUnique({
    where: { organizationId: user.organizationId },
  });
  if (!profile?.qrCodeUrl) return;

  try {
    await del(profile.qrCodeUrl);
  } catch (err) {
    console.error("QR code blob delete failed:", err);
  }

  // Also turn the skill off — no point leaving it enabled with nothing to send.
  await prisma.agentProfile.update({
    where: { organizationId: user.organizationId },
    data: { qrCodeUrl: null, skillSendQr: false },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "QR_CODE_DELETED",
  });

  revalidatePath("/dashboard/agent");
}
