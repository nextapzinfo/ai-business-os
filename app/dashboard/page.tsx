import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { Users, MessageSquare, Bell, UserCog } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const [clientCount, openConversations, pendingReminders, needsAttention] = await Promise.all([
    prisma.client.count({ where: { organizationId: user.organizationId } }),
    prisma.conversation.count({
      where: { organizationId: user.organizationId, status: "OPEN" },
    }),
    prisma.reminder.count({
      where: { organizationId: user.organizationId, status: "PENDING" },
    }),
    prisma.conversation.count({
      where: { organizationId: user.organizationId, status: "OPEN", aiPaused: true },
    }),
  ]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">Overview</h1>
      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Users} label="Clients" value={clientCount} accent="bg-sky-100 text-sky-600" />
        <StatCard icon={MessageSquare} label="Open Conversations" value={openConversations} accent="bg-emerald-100 text-emerald-600" />
        <StatCard icon={UserCog} label="Needs Staff Attention" value={needsAttention} accent="bg-amber-100 text-amber-600" href="/dashboard/conversations" />
        <StatCard icon={Bell} label="Pending Reminders" value={pendingReminders} accent="bg-violet-100 text-violet-600" />
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
  href,
}: {
  icon: typeof Users;
  label: string;
  value: number;
  accent: string;
  href?: string;
}) {
  const content = (
    <div className="rounded-xl border border-gray-200 bg-white p-5 transition-shadow hover:shadow-sm">
      <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${accent}`}>
        <Icon size={18} />
      </div>
      <div className="mt-3 text-2xl font-semibold text-gray-900">{value}</div>
      <div className="text-sm text-gray-500">{label}</div>
    </div>
  );

  return href ? <a href={href}>{content}</a> : content;
}
