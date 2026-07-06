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
      metadata: params.metadata,
    },
  });
}
