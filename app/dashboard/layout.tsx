import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import DashboardShell from "@/components/DashboardShell";
import { type NavItem } from "@/components/SidebarNav";

// `verticals: undefined` means "show for every vertical" (core engine features).
// Tag a nav item with specific verticals (e.g. ["RETAIL"]) once a feature only
// applies to that business type — the Super Admin panel (Phase 8) will manage
// which vertical each Organization is, this just reads that one field.
const navItems: (NavItem & { verticals?: string[] })[] = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/agent", label: "Agent Studio" },
  { href: "/dashboard/clients", label: "Clients" },
  { href: "/dashboard/conversations", label: "Conversations" },
  { href: "/dashboard/reminders", label: "Reminders" },
  { href: "/dashboard/templates", label: "Templates" },
  { href: "/dashboard/broadcasts", label: "Broadcasts" },
  { href: "/dashboard/products", label: "Products", verticals: ["RETAIL"] },
  { href: "/dashboard/delivery-rules", label: "Delivery Rules", verticals: ["RETAIL"] },
  { href: "/dashboard/events", label: "Events" },
  { href: "/dashboard/orders", label: "Orders", verticals: ["RETAIL"] },
  { href: "/dashboard/visitors", label: "Website Visitors", verticals: ["RETAIL"] },
  { href: "/dashboard/usage", label: "Hosting Usage", verticals: ["RETAIL"] },
  { href: "/dashboard/analytics", label: "Analytics" },
  { href: "/dashboard/training", label: "Training" },
  { href: "/dashboard/billing", label: "Billing" },
];

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);

  let vertical = "RETAIL";
  const organizationId = (session?.user as { organizationId?: string } | undefined)?.organizationId;
  if (organizationId) {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { vertical: true },
    });
    if (org?.vertical) vertical = org.vertical;
  }

  const visibleNavItems = navItems.filter(
    (item) => !item.verticals || item.verticals.includes(vertical)
  );

  return (
    <DashboardShell
      navItems={visibleNavItems}
      userName={session?.user?.name}
      userRole={session?.user?.role as string | undefined}
    >
      {children}
    </DashboardShell>
  );
}
