import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import SignOutButton from "@/components/SignOutButton";

const navItems = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/clients", label: "Clients" },
  { href: "/dashboard/conversations", label: "Conversations" },
  { href: "/dashboard/documents", label: "Knowledge Base" },
  { href: "/dashboard/reminders", label: "Reminders" },
];

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);

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
          {navItems.map((item) => (
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
