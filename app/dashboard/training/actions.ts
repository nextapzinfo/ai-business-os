"use server";

import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { processKnowledgeContent } from "@/app/dashboard/agent/actions";

// Push a staff-written correction for a flagged/gap AI reply straight into the
// Knowledge Base — reuses the exact same chunk+embed pipeline as the Agent
// Studio "paste text" form, just auto-titled from the original question. This
// is what "AI Training" actually means here: not model fine-tuning, just a
// fast path to teach it the right answer via the same RAG source it already
// searches.
export async function applyCorrection(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return;

  const messageId = formData.get("messageId") as string;
  const correctionText = (formData.get("correctionText") as string)?.trim();
  if (!messageId || !correctionText) return;

  const message = await prisma.message.findFirst({
    where: { id: messageId, conversation: { organizationId: user.organizationId } },
  });
  if (!message) return;

  const question = message.answeredQuestion?.trim() || "Training correction";
  const title = question.length > 80 ? `${question.slice(0, 80)}...` : question;
  const content = `Q: ${question}\nA: ${correctionText}`;

  const document = await prisma.document.create({
    data: { organizationId: user.organizationId, title, fileUrl: "training-correction", status: "PENDING" },
  });

  await processKnowledgeContent(user.organizationId, document.id, content);

  await prisma.message.update({
    where: { id: messageId },
    data: { correctionNote: correctionText, correctionStatus: "ADDED_TO_KB" },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "TRAINING_CORRECTION_ADDED_TO_KB",
    metadata: { messageId, documentId: document.id },
  });

  revalidatePath("/dashboard/training");
}

// Staff reviewed a flagged/gap reply and decided it's not worth a Knowledge
// Base entry (one-off question, not a real gap) — clears it from the queue.
export async function dismissFlag(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return;

  const messageId = formData.get("messageId") as string;
  if (!messageId) return;

  const message = await prisma.message.findFirst({
    where: { id: messageId, conversation: { organizationId: user.organizationId } },
  });
  if (!message) return;

  await prisma.message.update({ where: { id: messageId }, data: { correctionStatus: "DISMISSED" } });
  revalidatePath("/dashboard/training");
}

// Owner reviewed a nightly self-analysis insight — marks it handled so it
// drops off the queue. Never applied automatically; this is the explicit
// human approval step.
export async function reviewInsight(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return;

  const insightId = formData.get("insightId") as string;
  if (!insightId) return;

  const insight = await prisma.conversationInsight.findFirst({
    where: { id: insightId, organizationId: user.organizationId },
  });
  if (!insight) return;

  await prisma.conversationInsight.update({ where: { id: insightId }, data: { status: "REVIEWED" } });
  revalidatePath("/dashboard/training");
}

// One-click version of applyCorrection, sourced from the self-analysis
// insight's suggestedKnowledge field instead of a staff-written correction.
export async function addInsightKnowledge(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return;

  const insightId = formData.get("insightId") as string;
  if (!insightId) return;

  const insight = await prisma.conversationInsight.findFirst({
    where: { id: insightId, organizationId: user.organizationId },
  });
  if (!insight || !insight.suggestedKnowledge?.trim()) return;

  const document = await prisma.document.create({
    data: {
      organizationId: user.organizationId,
      title: "AI Self-Review suggestion",
      fileUrl: "training-correction",
      status: "PENDING",
    },
  });

  await processKnowledgeContent(user.organizationId, document.id, insight.suggestedKnowledge.trim());

  await prisma.conversationInsight.update({ where: { id: insightId }, data: { status: "REVIEWED" } });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "INSIGHT_KNOWLEDGE_ADDED",
    metadata: { insightId, documentId: document.id },
  });

  revalidatePath("/dashboard/training");
}
