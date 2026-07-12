import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import SignOutButton from "@/components/SignOutButton";
import SidebarNav, { type NavItem } from "@/components/SidebarNav";

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
  { href: "/dashboard/events", label: "Events" },
  { href: "/dashboard/orders", label: "Orders", verticals: ["RETAIL"] },
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
    <div className="flex min-h-screen bg-gray-50">
      <aside className="sticky top-0 flex h-screen w-[180px] flex-shrink-0 flex-col overflow-y-auto bg-primary-dark p-2.5">
        <div className="flex items-center gap-1.5 px-1 py-2">
          <div className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-md bg-accent text-[10px] font-bold text-white">
            AI
          </div>
          <span className="truncate text-xs font-semibold leading-tight text-white">AI Business OS</span>
        </div>

        <div className="mt-3">
          <SidebarNav items={visibleNavItems} />
        </div>

        <div className="mt-auto border-t border-white/10 pt-3">
          {session?.user?.name && (
            <div className="px-1">
              <p className="truncate text-xs font-medium text-white">{session.user.name}</p>
              <p className="text-[10px] uppercase tracking-wide text-white/50">{session.user.role}</p>
            </div>
          )}
          <SignOutButton />
        </div>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
