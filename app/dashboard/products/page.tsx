import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { readSheetRange } from "@/lib/googleSheets";
import { chunkText } from "@/lib/chunk";
import { embedText, toVectorLiteral } from "@/lib/embeddings";
import { revalidatePath } from "next/cache";
import { put } from "@vercel/blob";
import { formatDate } from "@/lib/formatDate";

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
      <h1 className="text-xl font-semibold text-gray-900">Products</h1>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">
        Import your product list from a Google Sheet. Column order: <strong>Name | Price | Description | Image URL</strong>{" "}
        (Image URL optional — you can upload a photo per product below). Imported products feed the AI knowledge base,
        and their photo is sent automatically on WhatsApp when relevant.
      </p>

      <div className="mt-5 rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Import from Google Sheet</h3>
        <form action={importFromSheet} className="mt-3 flex flex-wrap gap-2">
          <input
            name="spreadsheetId"
            placeholder="Spreadsheet ID (from the Sheet's URL, between /d/ and /edit)"
            required
            className="flex-1 basis-64 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <input
            name="range"
            placeholder="Range, e.g. Sheet1!A2:D100 (skip header row)"
            required
            className="flex-1 basis-56 rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light">
            Import Products
          </button>
        </form>
      </div>

      <h3 className="mt-6 text-sm font-semibold text-gray-900">Imported products ({products.length})</h3>
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {products.map((p) => (
          <div key={p.id} className="flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="flex h-36 items-center justify-center bg-gray-50">
              {p.imageUrl ? (
                <img src={p.imageUrl} alt={p.name} className="h-full w-full object-cover" />
              ) : (
                <span className="text-xs text-gray-400">No photo yet</span>
              )}
            </div>
            <div className="flex flex-1 flex-col gap-1 p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium text-gray-900">{p.name}</span>
                {p.price && (
                  <span className="flex-shrink-0 rounded-full bg-accent-light px-2 py-0.5 text-xs font-semibold text-accent">
                    {p.price}
                  </span>
                )}
              </div>
              <p className="line-clamp-2 text-xs text-gray-500">{p.description || "No description"}</p>
              <p className="mt-auto pt-1 text-[11px] text-gray-400">Added {formatDate(p.createdAt)}</p>

              <form action={uploadProductPhoto} className="mt-2 flex items-center gap-1.5">
                <input type="hidden" name="productId" value={p.id} />
                <input type="file" name="photo" accept="image/*" required className="w-full text-[11px]" />
                <button type="submit" className="flex-shrink-0 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-white hover:bg-primary-light">
                  {p.imageUrl ? "Change" : "Upload"}
                </button>
              </form>
            </div>
          </div>
        ))}
        {products.length === 0 && (
          <p className="col-span-full rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
            No products imported yet.
          </p>
        )}
      </div>
    </div>
  );
}
