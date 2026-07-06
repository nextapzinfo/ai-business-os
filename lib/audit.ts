import { prisma } from "@/lib/prisma";

// Compliance Notes requires access/action logs for Tax/Law clients from day 1.
// Call this from every server action that creates/modifies/views sensitive data.
export async function logAudit(params: {
  organizationId: string;
  userId?: string;
  action: string;
  metadata?: Record<string, unknown>;
}) {
  await prisma.auditLog.create({
    data: {
      organizationId: params.organizationId,
      userId: params.userId,
      action: params.action,
      // Prisma's JSON field type doesn't accept an explicit `undefined` value —
      // omit the key entirely when no metadata was passed, instead of setting it to undefined.
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    },
  });
}
