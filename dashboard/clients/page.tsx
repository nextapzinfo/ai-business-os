import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

async function addClient(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const name = formData.get("name") as string;
  const phone = formData.get("phone") as string;
  const email = (formData.get("email") as string) || undefined;

  if (!name || !phone) return;

  const client = await prisma.client.create({
    data: {
      organizationId: user.organizationId, // always from session, never from form input
      name,
      phone,
      email,
    },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "CLIENT_CREATED",
    metadata: { clientId: client.id, name, phone },
  });

  revalidatePath("/dashboard/clients");
}

export default async function ClientsPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const clients = await prisma.client.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div>
      <h1>Clients</h1>

      <form
        action={addClient}
        style={{ display: "flex", gap: 8, margin: "16px 0", flexWrap: "wrap" }}
      >
        <input name="name" placeholder="Name" required style={inputStyle} />
        <input
          name="phone"
          placeholder="Phone (with country code)"
          required
          style={inputStyle}
        />
        <input name="email" placeholder="Email (optional)" style={inputStyle} />
        <button type="submit" style={buttonStyle}>
          Add Client
        </button>
      </form>

      <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e5e5" }}>
            <th style={thStyle}>Name</th>
            <th style={thStyle}>Phone</th>
            <th style={thStyle}>Email</th>
            <th style={thStyle}>Added</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr key={c.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
              <td style={tdStyle}>{c.name}</td>
              <td style={tdStyle}>{c.phone}</td>
              <td style={tdStyle}>{c.email || "-"}</td>
              <td style={tdStyle}>{c.createdAt.toLocaleDateString()}</td>
            </tr>
          ))}
          {clients.length === 0 && (
            <tr>
              <td style={tdStyle} colSpan={4}>
                No clients yet — add your first one above.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const inputStyle = {
  padding: 8,
  border: "1px solid #ccc",
  borderRadius: 6,
  flex: "1 1 160px",
};
const buttonStyle = {
  padding: "8px 16px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
};
const thStyle = { padding: "10px 12px", fontSize: 13, color: "#666" };
const tdStyle = { padding: "10px 12px", fontSize: 14 };
