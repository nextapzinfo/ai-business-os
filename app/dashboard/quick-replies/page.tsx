import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { put, del } from "@vercel/blob";
import { formatDate } from "@/lib/formatDate";
import ConfirmSubmitButton from "@/components/ConfirmSubmitButton";

// A small library of reusable photo/video attachments (with an optional
// ready-made caption) staff can send from Conversations with one click,
// instead of re-uploading the same file from their PC/phone every time.
// Added 2026-08-28, owner's own request: "Conversation e ami Pic / video
// from my pc/mob .. or some pre attachment thakbe quick reply hisebe --
// send korte chai". Same @vercel/blob upload pattern already used for
// Products/Events/Templates in this app.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB — WhatsApp Cloud API's own image cap
const MAX_VIDEO_BYTES = 16 * 1024 * 1024; // 16MB — WhatsApp Cloud API's own video cap

async function addQuickReply(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const title = (formData.get("title") as string)?.trim();
  const captionText = ((formData.get("captionText") as string) || "").trim();
  const file = formData.get("file") as File | null;
  if (!title || !file || file.size === 0) return;

  const isVideo = file.type.startsWith("video/");
  const cap = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (file.size > cap) {
    console.error(`Quick Reply upload too large: ${file.size} bytes (cap ${cap})`);
    return;
  }

  let blobUrl: string;
  try {
    const blob = await put(`quick-replies/${user.organizationId}-${file.name}`, file, {
      access: "public",
      addRandomSuffix: true,
    });
    blobUrl = blob.url;
  } catch (err) {
    console.error("Quick Reply media upload failed:", err);
    return;
  }

  const quickReply = await prisma.quickReply.create({
    data: {
      organizationId: user.organizationId,
      title,
      mediaUrl: blobUrl,
      mediaType: isVideo ? "VIDEO" : "IMAGE",
      captionText: captionText || null,
    },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "QUICK_REPLY_CREATED",
    metadata: { quickReplyId: quickReply.id, title },
  });

  revalidatePath("/dashboard/quick-replies");
}

async function updateQuickReplyText(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const quickReplyId = formData.get("quickReplyId") as string;
  const title = (formData.get("title") as string)?.trim();
  const captionText = ((formData.get("captionText") as string) || "").trim();
  if (!quickReplyId || !title) return;

  const existing = await prisma.quickReply.findFirst({
    where: { id: quickReplyId, organizationId: user.organizationId },
  });
  if (!existing) return;

  await prisma.quickReply.update({
    where: { id: quickReplyId },
    data: { title, captionText: captionText || null },
  });

  revalidatePath("/dashboard/quick-replies");
}

async function deleteQuickReply(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const quickReplyId = formData.get("quickReplyId") as string;
  const quickReply = await prisma.quickReply.findFirst({
    where: { id: quickReplyId, organizationId: user.organizationId },
  });
  if (!quickReply) return;

  try {
    await del(quickReply.mediaUrl);
  } catch (err) {
    console.error("Quick Reply blob delete failed:", err);
  }

  await prisma.quickReply.delete({ where: { id: quickReplyId } });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "QUICK_REPLY_DELETED",
    metadata: { quickReplyId, title: quickReply.title },
  });

  revalidatePath("/dashboard/quick-replies");
}

export default async function QuickRepliesPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const quickReplies = await prisma.quickReply.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { title: "asc" },
  });

  return (
    <div>
      <h1 className="text-xl font-semibold text-gray-900">Quick Replies</h1>
      <p className="mt-1 max-w-2xl text-sm text-gray-500">
        Save photos/videos you send often (price list, catalog, intro video) with a ready-made caption —
        pick one from a Conversation to send it in one tap, instead of uploading the same file again every
        time. These are only used from the Conversations reply box; the AI does not use them.
      </p>

      <div className="mt-5 rounded-xl border border-gray-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-gray-900">Add a Quick Reply</h3>
        <form action={addQuickReply} className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <input
              name="title"
              placeholder="Label (e.g. Price List) — only staff see this"
              required
              className="flex-1 basis-48 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <input
              type="file"
              name="file"
              accept="image/*,video/*"
              required
              className="flex-1 basis-48 rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <textarea
            name="captionText"
            placeholder="Ready-made caption sent alongside it (optional, editable per-send)"
            rows={2}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
          <p className="text-[11px] text-gray-400">Photo max 5MB, video max 16MB (WhatsApp's own limits).</p>
          <button
            type="submit"
            className="self-start rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light"
          >
            Add Quick Reply
          </button>
        </form>
      </div>

      <h3 className="mt-6 text-sm font-semibold text-gray-900">Saved Quick Replies ({quickReplies.length})</h3>
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {quickReplies.map((q) => (
          <div key={q.id} className="flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="flex h-36 items-center justify-center bg-gray-50">
              {q.mediaType === "VIDEO" ? (
                <video src={q.mediaUrl} controls className="h-full w-full object-cover" />
              ) : (
                <img src={q.mediaUrl} alt={q.title} className="h-full w-full object-cover" />
              )}
            </div>
            <div className="flex flex-1 flex-col gap-1 p-3">
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium text-gray-900">{q.title}</span>
                <span className="flex-shrink-0 rounded-full bg-accent-light px-2 py-0.5 text-xs font-semibold text-accent">
                  {q.mediaType === "VIDEO" ? "Video" : "Photo"}
                </span>
              </div>
              <p className="line-clamp-2 text-xs text-gray-500">{q.captionText || "No caption"}</p>
              <p className="mt-auto pt-1 text-[11px] text-gray-400">Added {formatDate(q.createdAt)}</p>

              <details className="mt-2 rounded-lg border border-gray-200">
                <summary className="cursor-pointer select-none px-2.5 py-1.5 text-xs font-medium text-gray-600">
                  Edit title/caption
                </summary>
                <form action={updateQuickReplyText} className="flex flex-col gap-1.5 p-2.5 pt-0">
                  <input type="hidden" name="quickReplyId" value={q.id} />
                  <input name="title" defaultValue={q.title} required placeholder="Label" className="rounded border border-gray-300 px-2 py-1 text-xs" />
                  <textarea name="captionText" defaultValue={q.captionText ?? ""} placeholder="Caption" rows={2} className="rounded border border-gray-300 px-2 py-1 text-xs" />
                  <button type="submit" className="mt-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-white hover:bg-primary-light">
                    Save Changes
                  </button>
                </form>
              </details>

              <form action={deleteQuickReply} className="mt-1.5">
                <input type="hidden" name="quickReplyId" value={q.id} />
                <ConfirmSubmitButton
                  label="Delete"
                  confirmText={`Delete "${q.title}"? This can't be undone.`}
                  className="w-full rounded-lg border border-red-200 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                />
              </form>
            </div>
          </div>
        ))}
        {quickReplies.length === 0 && (
          <p className="col-span-full rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
            No Quick Replies yet — add your first one above.
          </p>
        )}
      </div>
    </div>
  );
}
