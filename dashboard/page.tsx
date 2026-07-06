import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const [clientCount, openConversations, pendingReminders] = await Promise.all([
    prisma.client.count({ where: { organizationId: user.organizationId } }),
    prisma.conversation.count({
      where: { organizationId: user.organizationId, status: "OPEN" },
    }),
    prisma.reminder.count({
      where: { organizationId: user.organizationId, status: "PENDING" },
    }),
  ]);

  return (
    <div>
      <h1>Overview</h1>
      <div style={{ display: "flex", gap: 16, marginTop: 20, flexWrap: "wrap" }}>
        <StatCard label="Clients" value={clientCount} />
        <StatCard label="Open Conversations" value={openConversations} />
        <StatCard label="Pending Reminders" value={pendingReminders} />
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        border: "1px solid #e5e5e5",
        borderRadius: 8,
        padding: 20,
        minWidth: 160,
        background: "#fff",
      }}
    >
      <div style={{ fontSize: 28, fontWeight: 600 }}>{value}</div>
      <div style={{ fontSize: 13, color: "#666" }}>{label}</div>
    </div>
  );
}
