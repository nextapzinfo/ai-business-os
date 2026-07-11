import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import SignOutButton from "@/components/SignOutButton";

// `verticals: undefined` means "show for every vertical" (core engine features).
// Tag a nav item with specific verticals (e.g. ["RETAIL"]) once a feature only
// applies to that business type — the Super Admin panel (Phase 8) will manage
// which vertical each Organization is, this just reads that one field.
const navItems: { href: string; label: string; verticals?: string[] }[] = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/clients", label: "Clients" },
  { href: "/dashboard/conversations", label: "Conversations" },
  { href: "/dashboard/documents", label: "Knowledge Base" },
  { href: "/dashboard/reminders", label: "Reminders" },
  { href: "/dashboard/templates", label: "Templates" },
  { href: "/dashboard/broadcasts", label: "Broadcasts" },
  { href: "/dashboard/products", label: "Products", verticals: ["RETAIL"] },
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
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <aside
        style={{
          width: 220,
          borderRight: "1px solid #e5e5e5",
          padding: 24,
          background: "#fff",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <h2 style={{ fontSize: 18, marginBottom: 24 }}>AI Business OS</h2>
        <nav style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {visibleNavItems.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>
        <div style={{ marginTop: "auto", fontSize: 13, color: "#666" }}>
          {session?.user?.name && (
            <p>
              {session.user.name}
              <br />
              <span style={{ opacity: 0.7 }}>{session.user.role}</span>
            </p>
          )}
          <SignOutButton />
        </div>
      </aside>
      <main style={{ flex: 1, padding: 32 }}>{children}</main>
    </div>
  );
}