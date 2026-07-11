import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { readSheetRange } from "@/lib/googleSheets";
import { revalidatePath } from "next/cache";

// Vercel: importing many customer rows can take a moment.
export const maxDuration = 60;

async function importClientsFromSheet(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const spreadsheetId = formData.get("spreadsheetId") as string;
  const range = formData.get("range") as string;
  if (!spreadsheetId || !range) return;

  let rows: string[][] = [];
  try {
    rows = await readSheetRange(spreadsheetId, range);
  } catch (err) {
    console.error("Customer Sheet import failed:", err);
    return;
  }

  // Expected columns: Name | Phone | Email (optional)
  let imported = 0;
  for (const row of rows) {
    const [name, phone, email] = row;
    if (!name?.trim() || !phone?.trim()) continue;

    const existing = await prisma.client.findFirst({
      where: { organizationId: user.organizationId, phone: phone.trim() },
    });
    if (existing) continue; // skip duplicates by phone

    await prisma.client.create({
      data: {
        organizationId: user.organizationId,
        name: name.trim(),
        phone: phone.trim(),
        email: email?.trim() || undefined,
      },
    });
    imported++;
  }

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "CUSTOMER_SHEET_IMPORTED",
    metadata: { spreadsheetId, range, imported, totalRows: rows.length },
  });

  revalidatePath("/dashboard/clients");
}

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

      <h3 style={{ marginTop: 8, marginBottom: 8 }}>Bulk import from Google Sheet</h3>
      <form
        action={importClientsFromSheet}
        style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}
      >
        <input
          name="spreadsheetId"
          placeholder="Spreadsheet ID (from the Sheet's URL)"
          required
          style={inputStyle}
        />
        <input
          name="range"
          placeholder="Range, e.g. Sheet1!A2:C200 (skip header row)"
          required
          style={inputStyle}
        />
        <button type="submit" style={buttonStyle}>
          Import Customers
        </button>
      </form>
      <p style={{ color: "#666", fontSize: 13, marginTop: -16, marginBottom: 16 }}>
        Expected column order: Name | Phone | Email (optional). Existing phone numbers are
        skipped automatically.
      </p>

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