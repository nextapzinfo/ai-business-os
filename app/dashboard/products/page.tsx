import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { readSheetRange } from "@/lib/googleSheets";
import { chunkText } from "@/lib/chunk";
import { embedText, toVectorLiteral } from "@/lib/embeddings";
import { revalidatePath } from "next/cache";
import { put, del } from "@vercel/blob";
import { formatDate } from "@/lib/formatDate";
import ConfirmSubmitButton from "@/components/ConfirmSubmitButton";

// Vercel: importing many product rows (chunk + embed each) can take a while.
export const maxDuration = 60;

function buildProductText(name: string, price: string, description: string): string {
  const parts = [name];
  if (price) parts.push(`Price: ${price}`);
  if (description) parts.push(description);
  return parts.join(". ");
}

// Rebuilds the DocumentChunk(s) + embeddings for a product's linked Document —
// used both on first import and whenever the product is edited, so the AI's
// WhatsApp answers never quote a stale price/description.
async function reembedProduct(organizationId: string, documentId: string, name: string, price: string, description: string) {
  await prisma.documentChunk.deleteMany({ where: { documentId } });
  const productText = buildProductText(name, price, description);
  try {
    const pieces = chunkText(productText);
    for (let i = 0; i < pieces.length; i++) {
      const chunk = await prisma.documentChunk.create({
        data: { organizationId, documentId, content: pieces[i], chunkIndex: i },
      });
      const embedding = await embedText(pieces[i], "document");
      const vectorLiteral = toVectorLiteral(embedding);
      await prisma.$executeRaw`
        UPDATE "DocumentChunk" SET embedding = ${vectorLiteral}::vector WHERE id = ${chunk.id}
      `;
    }
    await prisma.document.update({ where: { id: documentId }, data: { title: name, status: "PROCESSED" } });
  } catch (err) {
    await prisma.document.update({ where: { id: documentId }, data: { status: "FAILED" } });
    console.error("Product re-embedding failed:", err);
  }
}

// One catalog ID per organization — connects our Products to the Meta
// Commerce Manager catalog linked to this WABA, so native Catalog/Cart
// messages know which catalog to reference. Shipping charge is a flat rate
// added to every WhatsApp Catalog cart checkout bill (see the webhook's
// message.type === "order" handling) — kept simple, no distance/weight math.
async function updateCheckoutSettings(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const metaCatalogId = (formData.get("metaCatalogId") as string)?.trim();
  const shippingChargeRaw = (formData.get("shippingCharge") as string)?.trim();
  const shippingCharge = shippingChargeRaw ? parseFloat(shippingChargeRaw) : 0;

  await prisma.organization.update({
    where: { id: user.organizationId },
    data: {
      metaCatalogId: metaCatalogId || null,
      shippingCharge: isNaN(shippingCharge) ? 0 : shippingCharge,
    },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "CHECKOUT_SETTINGS_UPDATED",
    metadata: { metaCatalogId, shippingCharge },
  });

  revalidatePath("/dashboard/products");
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

    const document = await prisma.document.create({
      data: {
        organizationId: user.organizationId,
        title: name.trim(),
        fileUrl: "google-sheet-import",
        status: "PENDING",
      },
    });

    await reembedProduct(user.organizationId, document.id, name.trim(), (price || "").trim(), (description || "").trim());

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

async function updateProduct(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const productId = formData.get("productId") as string;
  const name = (formData.get("name") as string)?.trim();
  const price = (formData.get("price") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const retailerId = (formData.get("retailerId") as string)?.trim();
  const featured = formData.get("featured") === "on";
  if (!productId || !name) return;

  const product = await prisma.product.findFirst({
    where: { id: productId, organizationId: user.organizationId },
  });
  if (!product) return;

  await prisma.product.update({
    where: { id: productId },
    data: { name, price: price || null, description: description || null, retailerId: retailerId || null, featured },
  });

  await reembedProduct(user.organizationId, product.documentId, name, price || "", description || "");

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "PRODUCT_UPDATED",
    metadata: { productId, name },
  });

  revalidatePath("/dashboard/products");
}

async function deleteProduct(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const productId = formData.get("productId") as string;
  const product = await prisma.product.findFirst({
    where: { id: productId, organizationId: user.organizationId },
  });
  if (!product) return;

  if (product.imageUrl) {
    try {
      await del(product.imageUrl);
    } catch (err) {
      console.error("Product photo blob delete failed:", err);
    }
  }

  // Deleting the linked Document cascades to remove the Product row and its
  // DocumentChunks too — this is the one call that fully cleans everything up.
  await prisma.document.delete({ where: { id: product.documentId } });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "PRODUCT_DELETED",
    metadata: { productId, name: product.name },
  });

  revalidatePath("/dashboard/products");
}

export default async function ProductsPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const [products, org] = await Promise.all([
    prisma.product.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { metaCatalogId: true, shippingCharge: true },
    }),
  ]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">Products</h1>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">
        Import your product list from a Google Sheet. Column order: <strong>Name | Price | Description | Image URL</strong>{" "}
        (Image URL optional — you can upload a photo per product below). Imported products feed the AI knowledge base,
        and their photo is sent automatically on WhatsApp when relevant.
      </p>

      <div className="mt-5 rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">WhatsApp Catalog &amp; checkout</h3>
        <p className="mt-1 text-xs text-gray-500">
          The Meta Commerce Manager catalog ID connected to your WhatsApp number — needed for native product
          cards with an Add to Cart button. Find it in the catalog's Settings → Catalog page (Catalog ID field).
          Shipping charge is a flat amount added to every cart checkout bill.
        </p>
        <form action={updateCheckoutSettings} className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex flex-1 basis-64 flex-col gap-1">
            <span className="text-[11px] text-gray-500">Catalog ID</span>
            <input
              name="metaCatalogId"
              defaultValue={org?.metaCatalogId ?? ""}
              placeholder="e.g. 1598918611911177"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="flex basis-32 flex-col gap-1">
            <span className="text-[11px] text-gray-500">Shipping charge (৳)</span>
            <input
              name="shippingCharge"
              type="number"
              step="0.01"
              min="0"
              defaultValue={org?.shippingCharge ?? 0}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light">
            Save Settings
          </button>
        </form>
      </div>

      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
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
              {p.retailerId && <p className="text-[10px] text-gray-400">Catalog ID: {p.retailerId}</p>}
              {p.featured && (
                <span className="w-fit rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                  ★ Featured
                </span>
              )}
              <p className="mt-auto pt-1 text-[11px] text-gray-400">Added {formatDate(p.createdAt)}</p>

              <form action={uploadProductPhoto} className="mt-2 flex items-center gap-1.5">
                <input type="hidden" name="productId" value={p.id} />
                <input type="file" name="photo" accept="image/*" required className="w-full text-[11px]" />
                <button type="submit" className="flex-shrink-0 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-white hover:bg-primary-light">
                  {p.imageUrl ? "Change" : "Upload"}
                </button>
              </form>

              <details className="mt-2 rounded-lg border border-gray-200">
                <summary className="cursor-pointer select-none px-2.5 py-1.5 text-xs font-medium text-gray-600">
                  Edit details
                </summary>
                <form action={updateProduct} className="flex flex-col gap-1.5 p-2.5 pt-0">
                  <input type="hidden" name="productId" value={p.id} />
                  <input name="name" defaultValue={p.name} required placeholder="Name" className="rounded border border-gray-300 px-2 py-1 text-xs" />
                  <input name="price" defaultValue={p.price ?? ""} placeholder="Price" className="rounded border border-gray-300 px-2 py-1 text-xs" />
                  <textarea name="description" defaultValue={p.description ?? ""} placeholder="Description" rows={2} className="rounded border border-gray-300 px-2 py-1 text-xs" />
                  <input
                    name="retailerId"
                    defaultValue={p.retailerId ?? ""}
                    placeholder="Meta Catalog Content ID (e.g. k4c1walsjc)"
                    className="rounded border border-gray-300 px-2 py-1 text-xs"
                  />
                  <label className="flex items-center gap-1.5 text-xs text-gray-600">
                    <input type="checkbox" name="featured" defaultChecked={p.featured} className="h-3.5 w-3.5" />
                    ★ Featured (shown when a customer asks about products generally)
                  </label>
                  <button type="submit" className="mt-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-white hover:bg-primary-light">
                    Save Changes
                  </button>
                </form>
              </details>

              <form action={deleteProduct} className="mt-1.5">
                <input type="hidden" name="productId" value={p.id} />
                <ConfirmSubmitButton
                  label="Delete"
                  confirmText={`Delete "${p.name}"? This also removes it from the AI knowledge base. This can't be undone.`}
                  className="w-full rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                />
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
