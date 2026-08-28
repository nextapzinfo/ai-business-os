import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { sendWhatsAppMessage, sendWhatsAppImageMessage, sendWhatsAppVideoMessage } from "@/lib/whatsapp";
import { put } from "@vercel/blob";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Bot, Headphones, RotateCcw, X } from "lucide-react";
import { formatDateTime } from "@/lib/formatDate";
import MessageThread from "@/components/MessageThread";
import SendTemplateButton from "@/components/SendTemplateButton";
import ConversationReplyBox from "@/components/ConversationReplyBox";

export const dynamic = "force-dynamic";

function initialOf(name: string) {
  return (name?.trim()?.[0] ?? "?").toUpperCase();
}

// WhatsApp Cloud API's own per-media-type caps — reject oversized files before
// spending a Blob upload on something Meta would just refuse anyway.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_VIDEO_BYTES = 16 * 1024 * 1024; // 16MB

// Handles all 3 manual-reply shapes from ConversationReplyBox: plain text,
// a fresh PC/mobile upload (with optional caption), or a saved Quick Reply
// (with its caption pre-filled but still editable before sending). Added
// 2026-08-28, owner's own request: "Conversation e pic/video pathate chai,
// or some pre attachment quick reply hisebe".
async function sendManualReply(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const conversationId = formData.get("conversationId") as string;
  const text = ((formData.get("text") as string) || "").trim();
  const file = formData.get("file") as File | null;
  const quickReplyId = ((formData.get("quickReplyId") as string) || "").trim();
  if (!conversationId) return;

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, organizationId: user.organizationId },
    include: { client: true },
  });
  if (!conversation) return;

  let mediaUrl: string | null = null;
  let mediaType: "IMAGE" | "VIDEO" | null = null;
  let caption = text;

  if (file && file.size > 0) {
    const isVideo = file.type.startsWith("video/");
    const cap = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (file.size > cap) {
      console.error(`Manual reply attachment too large: ${file.size} bytes (cap ${cap})`);
      return; // silently no-op, same convention as other forms in this app — the UI shows the size limit up front
    }
    try {
      const blob = await put(
        `conversations/${user.organizationId}/${conversationId}-${Date.now()}-${file.name}`,
        file,
        { access: "public", addRandomSuffix: true }
      );
      mediaUrl = blob.url;
      mediaType = isVideo ? "VIDEO" : "IMAGE";
    } catch (err) {
      console.error("Manual reply media upload failed:", err);
      if (!text) return;
    }
  } else if (quickReplyId) {
    const qr = await prisma.quickReply.findFirst({
      where: { id: quickReplyId, organizationId: user.organizationId },
    });
    if (qr) {
      // qr.mediaUrl/mediaType can both be null now — a text-only Quick Reply
      // (2026-08-28). mediaUrl staying null naturally skips the IMAGE/VIDEO
      // send branches below and falls through to the plain-text send instead.
      mediaUrl = qr.mediaUrl;
      mediaType = qr.mediaType as "IMAGE" | "VIDEO" | null;
      if (!caption) caption = qr.captionText ?? "";
    }
  }

  if (!mediaUrl && !caption) return; // nothing to actually send — `caption` (not raw `text`) so a text-only Quick Reply whose text came from captionText, not the textarea, still counts

  let sendError: string | null = null;
  try {
    if (mediaUrl && mediaType === "VIDEO") {
      await sendWhatsAppVideoMessage(conversation.client.phone, mediaUrl, caption || undefined);
    } else if (mediaUrl) {
      await sendWhatsAppImageMessage(conversation.client.phone, mediaUrl, caption || undefined);
    } else {
      await sendWhatsAppMessage(conversation.client.phone, caption);
    }
  } catch (err) {
    sendError = err instanceof Error ? err.message : "Unknown error";
    console.error("Manual WhatsApp reply failed:", err);
  }

  const displayContent =
    caption || (mediaType === "VIDEO" ? "[Video]" : mediaType === "IMAGE" ? "[Photo]" : text);

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      sender: "STAFF",
      content: sendError ? `${displayContent}\n\n[NOT DELIVERED: ${sendError}]` : displayContent,
      imageUrl: mediaUrl,
      mediaType,
    },
  });

  // Sending a manual reply counts as "taking over" the conversation — pause the
  // AI so it doesn't also reply to the customer's next message and talk over
  // staff. Also clears handoffReason, if the AI had flagged one: staff replying
  // IS the response to that handoff, so the "needs you" badge should clear.
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { aiPaused: true, handoffReason: null },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "MANUAL_REPLY_SENT",
    metadata: { conversationId: conversation.id, delivered: !sendError, error: sendError, mediaType, viaQuickReply: !!quickReplyId },
  });

  revalidatePath(`/dashboard/conversations/${conversationId}`);
}

async function closeConversation(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const conversationId = formData.get("conversationId") as string;
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, organizationId: user.organizationId },
  });
  if (!conversation) return;

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { status: conversation.status === "CLOSED" ? "OPEN" : "CLOSED" },
  });

  revalidatePath(`/dashboard/conversations/${conversationId}`);
}

async function toggleAiPaused(formData: FormData) {
  "use server";
  const user = await getCurrentUser();
  if (!user) return;

  const conversationId = formData.get("conversationId") as string;
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, organizationId: user.organizationId },
  });
  if (!conversation) return;

  const resuming = conversation.aiPaused; // currently paused → this click resumes it
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { aiPaused: !conversation.aiPaused, ...(resuming ? { handoffReason: null } : {}) },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: resuming ? "AI_RESUMED" : "AI_INTERVENED",
    metadata: { conversationId: conversation.id },
  });

  revalidatePath(`/dashboard/conversations/${conversationId}`);
}

export default async function ConversationDetailPage({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) return null;

  const [conversation, approvedTemplates, quickReplies] = await Promise.all([
    prisma.conversation.findFirst({
      where: { id: params.id, organizationId: user.organizationId },
      include: { client: true },
    }),
    prisma.messageTemplate.findMany({
      where: { organizationId: user.organizationId, status: "APPROVED" },
      orderBy: { name: "asc" },
    }),
    prisma.quickReply.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { title: "asc" },
    }),
  ]);

  if (!conversation) redirect("/dashboard/conversations");

  // Full WhatsApp-style history: pull every message from EVERY conversation
  // this client has ever had on this channel, not just the single
  // Conversation row `params.id` points at. Before the webhook's "reopen
  // the previous conversation instead of creating a new one" fix
  // (2026-08-24), closing a conversation and then getting a new message
  // from the same customer always spawned a brand-new, separate
  // Conversation row — so a client can have several historical rows behind
  // the scenes even though staff experience it as one ongoing relationship.
  // That fix stops NEW splits, but doesn't retroactively merge OLD ones, so
  // the message list here is assembled across every conversation tied to
  // this client instead of just this one row. Nothing is deleted or merged
  // in the database — only what's displayed changes; each Conversation row
  // keeps its own status/handoff/pause state for the action buttons above,
  // which still operate on this specific conversation (`conversation.id`).
  const allMessages = await prisma.message.findMany({
    where: {
      conversation: {
        organizationId: user.organizationId,
        clientId: conversation.clientId,
        channel: conversation.channel,
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const threadMessages = allMessages.map((m) => ({
    id: m.id,
    sender: m.sender,
    content: m.content,
    imageUrl: m.imageUrl,
    mediaType: m.mediaType,
    flaggedWrong: m.flaggedWrong,
    createdAt: formatDateTime(m.createdAt),
  }));

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Everything below — header, handoff banner, thread, reply bar — is one
          continuous rounded/overflow-hidden card, so it reads as a single
          WhatsApp-style chat window instead of three separate dashboard
          panels. Added 2026-08-28, owner's own request: "same exact same wts
          app type chai". */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-gray-200 shadow-sm">
        <div className="flex flex-shrink-0 items-center gap-2.5 bg-primary px-3 py-2.5 text-white">
          <Link
            href="/dashboard/conversations"
            className="-ml-1 flex-shrink-0 rounded-full p-1.5 hover:bg-white/10 lg:hidden"
          >
            <ArrowLeft size={20} />
          </Link>
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-white/15 text-sm font-semibold">
            {initialOf(conversation.client.name)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold leading-tight">{conversation.client.name}</p>
            <p className="truncate text-[12px] text-white/70">
              {conversation.client.phone} · {conversation.aiPaused ? "Staff Handling" : "AI Active"}
              {conversation.status !== "OPEN" ? ` · ${conversation.status === "CLOSED" ? "Closed" : "Escalated"}` : ""}
            </p>
          </div>
          {/* Labeled, not just an icon — the plain Play/Pause + Check/Reopen icon
              pair (2026-08-28) read as unrecognizable to the owner ("I cant
              understand 2 icon on top... Play button and write sign)"). Each
              button now names what it actually does: this one is the AI
              handoff toggle — "AI" (AI is replying, tap to take the chat over
              yourself) or "Me" (you're handling it, tap to hand back to AI). */}
          <form action={toggleAiPaused}>
            <input type="hidden" name="conversationId" value={conversation.id} />
            <button
              type="submit"
              title={conversation.aiPaused ? "You're handling this chat — tap to hand it back to the AI" : "AI is replying — tap to take over and hand it off to yourself"}
              className="flex flex-shrink-0 items-center gap-1 rounded-full bg-white/10 px-2.5 py-1.5 text-[11px] font-medium hover:bg-white/20"
            >
              {conversation.aiPaused ? <Headphones size={14} /> : <Bot size={14} />}
              {conversation.aiPaused ? "Me" : "AI"}
            </button>
          </form>
          <form action={closeConversation}>
            <input type="hidden" name="conversationId" value={conversation.id} />
            <button
              type="submit"
              title={conversation.status === "CLOSED" ? "Reopen conversation" : "Close conversation"}
              className="flex flex-shrink-0 items-center gap-1 rounded-full bg-white/10 px-2.5 py-1.5 text-[11px] font-medium hover:bg-white/20"
            >
              {conversation.status === "CLOSED" ? <RotateCcw size={14} /> : <X size={14} />}
              {conversation.status === "CLOSED" ? "Reopen" : "Close"}
            </button>
          </form>
        </div>

        {conversation.handoffReason && (
          <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-red-100 bg-red-50 px-3 py-1.5 text-[12px] font-medium text-red-700">
            ⚠️ AI handed off: {conversation.handoffReason}
          </div>
        )}

        <MessageThread messages={threadMessages} />

        <ConversationReplyBox
          action={sendManualReply}
          conversationId={conversation.id}
          quickReplies={quickReplies.map((q) => ({
            id: q.id,
            title: q.title,
            mediaUrl: q.mediaUrl,
            mediaType: q.mediaType,
            captionText: q.captionText,
          }))}
          extraToolbar={
            approvedTemplates.length > 0 ? (
              <SendTemplateButton
                compact
                conversationId={conversation.id}
                templates={approvedTemplates.map((t) => ({ id: t.id, name: t.name, language: t.language }))}
              />
            ) : undefined
          }
        />
      </div>
    </div>
  );
}
