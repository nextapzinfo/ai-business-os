import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

// Compliance Notes requires access/action logs for Tax/Law clients from day 1.
// Call this from every server action that creates/modifies/views sensitive data.
export async function logAudit(params: {
  organizationId: string;
  userId?: string;
  action: string;
  metadata?: Record<string, unknown>;
}) {
  const data: Prisma.AuditLogUncheckedCreateInput = {
    organizationId: params.organizationId,
    userId: params.userId,
    action: params.action,
  };

  // Assign metadata only when provided — Prisma's JSON field type doesn't
  // accept an explicit `undefined` value, so the key must be left unset instead.
  if (params.metadata !== undefined) {
    data.metadata = params.metadata as Prisma.InputJsonValue;
  }

  await prisma.auditLog.create({ data });
}
