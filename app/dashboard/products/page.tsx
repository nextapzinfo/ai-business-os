import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { readSheetRange } from "@/lib/googleSheets";
import { chunkText } from "@/lib/chunk";
import { embedText, toVectorLiteral } from "@/lib/embeddings";
import { revalidatePath } from "next/cache";
import { put } from "@vercel/blob";

// Vercel: importing many product rows (chunk + embed each) can take a while.
export const maxDuration = 60;

function buildProductText(name: string, price: string, description: string): string {
  const parts = [name];
  if (price) parts.push(`Price: ${price}`);
  if (description) parts.push(description);
  return parts.join(". ");
}

async function importFromSheet(formData: FormData) {
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
    console.error("Product Sheet import failed:", err);
    return;
  }

  // Expected columns: Name | Price | Description | Image URL
  let imported = 0;
  for (const row of rows) {
    const [name, price, description, imageUrl] = row;
    if (!name || !name.trim()) continue;

    const existing = await prisma.product.findFirst({
      where: { organizationId: user.organizationId, name: name.trim() },
    });
    if (existing) continue; // V1: skip products already imported by name

    const productText = buildProductText(name.trim(), (price || "").trim(), (description || "").trim());

    const document = await prisma.document.create({
      data: {
        organizationId: user.organizationId,
        title: name.trim(),
        fileUrl: "google-sheet-import",
        status: "PENDING",
      },
    });

    try {
      const pieces = chunkText(productText);
      for (let i = 0; i < pieces.length; i++) {
        const chunk = await prisma.documentChunk.create({
          data: {
            organizationId: user.organizationId,
            documentId: document.id,
            content: pieces[i],
            chunkIndex: i,
          },
        });
        const embedding = await embedText(pieces[i], "document");
        const vectorLiteral = toVectorLiteral(embedding);
        await prisma.$executeRaw`
          UPDATE "DocumentChunk" SET embedding = ${vectorLiteral}::vector WHERE id = ${chunk.id}
        `;
      }
      await prisma.document.update({ where: { id: document.id }, data: { status: "PROCESSED" } });
    } catch (err) {
      await prisma.document.update({ where: { id: document.id }, data: { status: "FAILED" } });
      console.error("Product document embedding failed:", err);
    }

    await prisma.product.create({
      data: {
        organizationId: user.organizationId,
        documentId: document.id,
        name: name.trim(),
        price: (price || "").trim() || null,
        description: (description || "").trim() || null,
        imageUrl: (imageUrl || "").trim() || null,
      },
    });

    imported++;
  }

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "PRODUCT_SHEET_IMPORTED",
    metadata: { spreadsheetId, range, imported, totalRows: rows.length },
  });

  revalidatePath("/dashboard/products");
}

// Uploads a photo straight from the dashboard (no external image host needed).
// Stored in Vercel Blob; only the resulting public URL is saved on the Product row.
async function uploadProductPhoto(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const productId = formData.get("productId") as string;
  const file = formData.get("photo") as File | null;
  if (!productId || !file || file.size === 0) return;

  // Make sure this product actually belongs to the logged-in user's org.
  const product = await prisma.product.findFirst({
    where: { id: productId, organizationId: user.organizationId },
  });
  if (!product) return;

  let blobUrl: string;
  try {
    const blob = await put(`products/${user.organizationId}/${productId}-${file.name}`, file, {
      access: "public",
      addRandomSuffix: true,
    });
    blobUrl = blob.url;
  } catch (err) {
    console.error("Product photo upload failed:", err);
    return;
  }

  await prisma.product.update({
    where: { id: productId },
    data: { imageUrl: blobUrl },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "PRODUCT_PHOTO_UPLOADED",
    metadata: { productId },
  });

  revalidatePath("/dashboard/products");
}

export default async function ProductsPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const products = await prisma.product.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div>
      <h1>Products</h1>
      <p style={{ color: "#666", fontSize: 14 }}>
        Import your product list directly from a Google Sheet. Expected column order:{" "}
        <strong>Name | Price | Description | Image URL</strong> (Image URL is optional — you can
        also upload a photo directly below for each product). Sharing the Sheet with the service
        account email is required first. Imported products are added to the Knowledge Base so the
        AI can answer questions about them, and their photo is sent automatically when relevant.
      </p>

      <h3 style={{ marginTop: 24 }}>Import from Google Sheet</h3>
      <form
        action={importFromSheet}
        style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 600 }}
      >
        <input
          name="spreadsheetId"
          placeholder="Spreadsheet ID (from the Sheet's URL, between /d/ and /edit)"
          required
          style={inputStyle}
        />
        <input
          name="range"
          placeholder="Range, e.g. Sheet1!A2:D100 (skip header row)"
          required
          style={inputStyle}
        />
        <button type="submit" style={{ ...buttonStyle, alignSelf: "flex-start" }}>
          Import Products
        </button>
      </form>

      <h3 style={{ marginTop: 32 }}>Imported products</h3>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          background: "#fff",
          marginTop: 8,
        }}
      >
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e5e5" }}>
            <th style={thStyle}>Photo</th>
            <th style={thStyle}>Name</th>
            <th style={thStyle}>Price</th>
            <th style={thStyle}>Description</th>
            <th style={thStyle}>Imported</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
              <td style={tdStyle}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                  {p.imageUrl ? (
                    <img
                      src={p.imageUrl}
                      alt={p.name}
                      style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 4 }}
                    />
                  ) : (
                    <span>—</span>
                  )}
                  <form action={uploadProductPhoto} style={{ display: "flex", gap: 4 }}>
                    <input type="hidden" name="productId" value={p.id} />
                    <input
                      type="file"
                      name="photo"
                      accept="image/*"
                      required
                      style={{ fontSize: 11, width: 120 }}
                    />
                    <button type="submit" style={{ ...buttonStyle, padding: "4px 8px", fontSize: 11 }}>
                      {p.imageUrl ? "Change" : "Upload"}
                    </button>
                  </form>
                </div>
              </td>
              <td style={tdStyle}>{p.name}</td>
              <td style={tdStyle}>{p.price || "—"}</td>
              <td style={{ ...tdStyle, maxWidth: 300 }}>{p.description || "—"}</td>
              <td style={tdStyle}>{p.createdAt.toLocaleDateString()}</td>
            </tr>
          ))}
          {products.length === 0 && (
            <tr>
              <td style={tdStyle} colSpan={5}>
                No products imported yet.
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