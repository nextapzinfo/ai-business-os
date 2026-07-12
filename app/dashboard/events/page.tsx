import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { chunkText } from "@/lib/chunk";
import { embedText, toVectorLiteral } from "@/lib/embeddings";
import { revalidatePath } from "next/cache";
import { put, del } from "@vercel/blob";
import { formatDate } from "@/lib/formatDate";
import ConfirmSubmitButton from "@/components/ConfirmSubmitButton";

// Chunking + embedding on add/edit can take a moment for longer descriptions.
export const maxDuration = 60;

function buildEventText(title: string, description: string, eventDateText: string): string {
  const parts = [title];
  if (eventDateText) parts.push(`Date: ${eventDateText}`);
  if (description) parts.push(description);
  return parts.join(". ");
}

// Rebuilds the DocumentChunk(s) + embeddings for an event's linked Document —
// used on both create and edit, so the AI's WhatsApp answers never quote a
// stale date/description. Same pattern as reembedProduct on the Products page.
async function reembedEvent(
  organizationId: string,
  documentId: string,
  title: string,
  description: string,
  eventDateText: string
) {
  await prisma.documentChunk.deleteMany({ where: { documentId } });
  const eventText = buildEventText(title, description, eventDateText);
  try {
    const pieces = chunkText(eventText);
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
    await prisma.document.update({ where: { id: documentId }, data: { title, status: "PROCESSED" } });
  } catch (err) {
    await prisma.document.update({ where: { id: documentId }, data: { status: "FAILED" } });
    console.error("Event re-embedding failed:", err);
  }
}

async function addEvent(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const eventDateRaw = (formData.get("eventDate") as string) || "";
  if (!title) return;

  const eventDate = eventDateRaw ? new Date(eventDateRaw) : undefined;

  const document = await prisma.document.create({
    data: {
      organizationId: user.organizationId,
      title,
      fileUrl: "event-entry",
      status: "PENDING",
    },
  });

  await reembedEvent(user.organizationId, document.id, title, description || "", eventDateRaw);

  const event = await prisma.event.create({
    data: {
      organizationId: user.organizationId,
      documentId: document.id,
      title,
      description: description || null,
      eventDate: eventDate && !isNaN(eventDate.getTime()) ? eventDate : null,
    },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "EVENT_CREATED",
    metadata: { eventId: event.id, title },
  });

  revalidatePath("/dashboard/events");
}

async function uploadEventPhoto(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const eventId = formData.get("eventId") as string;
  const file = formData.get("photo") as File | null;
  if (!eventId || !file || file.size === 0) return;

  const event = await prisma.event.findFirst({
    where: { id: eventId, organizationId: user.organizationId },
  });
  if (!event) return;

  let blobUrl: string;
  try {
    const blob = await put(`events/${user.organizationId}/${eventId}-${file.name}`, file, {
      access: "public",
      addRandomSuffix: true,
    });
    blobUrl = blob.url;
  } catch (err) {
    console.error("Event photo upload failed:", err);
    return;
  }

  await prisma.event.update({ where: { id: eventId }, data: { imageUrl: blobUrl } });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "EVENT_PHOTO_UPLOADED",
    metadata: { eventId },
  });

  revalidatePath("/dashboard/events");
}

async function updateEvent(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const eventId = formData.get("eventId") as string;
  const title = (formData.get("title") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const eventDateRaw = (formData.get("eventDate") as string) || "";
  if (!eventId || !title) return;

  const event = await prisma.event.findFirst({
    where: { id: eventId, organizationId: user.organizationId },
  });
  if (!event) return;

  const eventDate = eventDateRaw ? new Date(eventDateRaw) : null;

  await prisma.event.update({
    where: { id: eventId },
    data: {
      title,
      description: description || null,
      eventDate: eventDate && !isNaN(eventDate.getTime()) ? eventDate : null,
    },
  });

  await reembedEvent(user.organizationId, event.documentId, title, description || "", eventDateRaw);

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "EVENT_UPDATED",
    metadata: { eventId, title },
  });

  revalidatePath("/dashboard/events");
}

async function deleteEvent(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const eventId = formData.get("eventId") as string;
  const event = await prisma.event.findFirst({
    where: { id: eventId, organizationId: user.organizationId },
  });
  if (!event) return;

  if (event.imageUrl) {
    try {
      await del(event.imageUrl);
    } catch (err) {
      console.error("Event photo blob delete failed:", err);
    }
  }

  // Deleting the linked Document cascades to remove the Event row and its
  // DocumentChunks too — same one-call cleanup pattern as Products.
  await prisma.document.delete({ where: { id: event.documentId } });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "EVENT_DELETED",
    metadata: { eventId, title: event.title },
  });

  revalidatePath("/dashboard/events");
}

export default async function EventsPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const events = await prisma.event.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">Events</h1>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">
        Festival specials, sales, or announcements. Each event feeds the AI knowledge base, and its photo is
        sent automatically on WhatsApp when a customer's question matches closely — turn this on in Agent
        Studio &rarr; Skills &rarr; "Send event photos".
      </p>

      <div className="mt-5 rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Add an event</h3>
        <form action={addEvent} className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <input
              name="title"
              placeholder="Title (e.g. Eid Special Offer)"
              required
              className="flex-1 basis-48 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <input
              name="eventDate"
              type="date"
              title="Event date (optional)"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-600"
            />
          </div>
          <textarea
            name="description"
            placeholder="What's the event/offer about? (optional, but helps the AI answer questions about it)"
            rows={2}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="self-start rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light"
          >
            Add Event
          </button>
        </form>
      </div>

      <h3 className="mt-6 text-sm font-semibold text-gray-900">Events ({events.length})</h3>
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {events.map((e) => (
          <div key={e.id} className="flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="flex h-36 items-center justify-center bg-gray-50">
              {e.imageUrl ? (
                <img src={e.imageUrl} alt={e.title} className="h-full w-full object-cover" />
              ) : (
                <span className="text-xs text-gray-400">No photo yet</span>
              )}
            </div>
            <div className="flex flex-1 flex-col gap-1 p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium text-gray-900">{e.title}</span>
                {e.eventDate && (
                  <span className="flex-shrink-0 rounded-full bg-accent-light px-2 py-0.5 text-xs font-semibold text-accent">
                    {formatDate(e.eventDate)}
                  </span>
                )}
              </div>
              <p className="line-clamp-2 text-xs text-gray-500">{e.description || "No description"}</p>
              <p className="mt-auto pt-1 text-[11px] text-gray-400">Added {formatDate(e.createdAt)}</p>

              <form action={uploadEventPhoto} className="mt-2 flex items-center gap-1.5">
                <input type="hidden" name="eventId" value={e.id} />
                <input type="file" name="photo" accept="image/*" required className="w-full text-[11px]" />
                <button type="submit" className="flex-shrink-0 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-white hover:bg-primary-light">
                  {e.imageUrl ? "Change" : "Upload"}
                </button>
              </form>

              <details className="mt-2 rounded-lg border border-gray-200">
                <summary className="cursor-pointer select-none px-2.5 py-1.5 text-xs font-medium text-gray-600">
                  Edit details
                </summary>
                <form action={updateEvent} className="flex flex-col gap-1.5 p-2.5 pt-0">
                  <input type="hidden" name="eventId" value={e.id} />
                  <input name="title" defaultValue={e.title} required placeholder="Title" className="rounded border border-gray-300 px-2 py-1 text-xs" />
                  <input
                    name="eventDate"
                    type="date"
                    defaultValue={e.eventDate ? e.eventDate.toISOString().slice(0, 10) : ""}
                    className="rounded border border-gray-300 px-2 py-1 text-xs"
                  />
                  <textarea name="description" defaultValue={e.description ?? ""} placeholder="Description" rows={2} className="rounded border border-gray-300 px-2 py-1 text-xs" />
                  <button type="submit" className="mt-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-white hover:bg-primary-light">
                    Save Changes
                  </button>
                </form>
              </details>

              <form action={deleteEvent} className="mt-1.5">
                <input type="hidden" name="eventId" value={e.id} />
                <ConfirmSubmitButton
                  label="Delete"
                  confirmText={`Delete "${e.title}"? This also removes it from the AI knowledge base. This can't be undone.`}
                  className="w-full rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                />
              </form>
            </div>
          </div>
        ))}
        {events.length === 0 && (
          <p className="col-span-full rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
            No events yet — add your first one above.
          </p>
        )}
      </div>
    </div>
  );
}
