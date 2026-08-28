"use client";

import { useRef, useState } from "react";
import { Camera, Loader2, Mic, Paperclip, Send, Smile, X, Zap } from "lucide-react";

type QuickReplyOption = {
  id: string;
  title: string;
  mediaUrl: string;
  mediaType: string; // IMAGE or VIDEO
  captionText: string | null;
};

// The Conversations reply box — text, a one-off PC/mobile photo/video upload,
// or a saved Quick Reply, all through the one form/send button. Added
// 2026-08-28, owner's own request: "Conversation e ami Pic / video from my
// pc/mob .. or some pre attachment thakbe quick reply hisebe -- send korte
// chai". Restyled 2026-08-28 (same day, owner's follow-up request: "same
// exact same wts app type chai") into a genuine WhatsApp-look input bar —
// pill-shaped text field with an emoji icon, paperclip + camera to its
// right, and a round send button that swaps to a (visual-only, no voice
// message support) mic icon when there's nothing to send yet. Pulled into
// its own Client Component (same reasoning as AddClientForm, 2026-08-27)
// because a Server Action form's plain uncontrolled inputs don't
// remount/reset on their own — this one additionally needs local state for
// the file preview and the Quick Reply picker, which a Server Component
// can't hold at all.
export default function ConversationReplyBox({
  action,
  conversationId,
  quickReplies,
  extraToolbar,
}: {
  action: (formData: FormData) => Promise<void>;
  conversationId: string;
  quickReplies: QuickReplyOption[];
  extraToolbar?: React.ReactNode; // e.g. SendTemplateButton — app-specific, not part of stock WhatsApp UI, so it's rendered in its own slim utility row above the WhatsApp-authentic input row instead of inside it
}) {
  const formRef = useRef<HTMLFormElement>(null);
  // The canonical field actually submitted as "file" — never clicked directly.
  // Both the paperclip (gallery/file picker) and camera (direct capture on
  // mobile) inputs below are separate, unnamed "trigger" inputs; whichever one
  // the customer uses copies its chosen File into this one via the
  // DataTransfer trick, so the server action only ever sees a single "file"
  // field no matter which control was used to pick it.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [filePreview, setFilePreview] = useState<{ name: string; kind: "IMAGE" | "VIDEO" } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedQuickReply, setSelectedQuickReply] = useState<QuickReplyOption | null>(null);
  const [sending, setSending] = useState(false);
  const [hasText, setHasText] = useState(false); // tracked separately from the uncontrolled textarea so the send/mic icon can react live without controlling (and risking cursor jumps in) the field itself

  function setFileFromPicker(file: File | undefined) {
    if (!file) return;
    const dt = new DataTransfer();
    dt.items.add(file);
    if (fileInputRef.current) fileInputRef.current.files = dt.files;
    // A file and a Quick Reply are mutually exclusive — WhatsApp only sends
    // one attachment per message, so picking one clears the other rather
    // than leaving an ambiguous combination sitting in the form.
    setSelectedQuickReply(null);
    setFilePreview({ name: file.name, kind: file.type.startsWith("video/") ? "VIDEO" : "IMAGE" });
  }

  function handleGalleryChange() {
    setFileFromPicker(galleryInputRef.current?.files?.[0]);
    if (galleryInputRef.current) galleryInputRef.current.value = "";
  }

  function handleCameraChange() {
    setFileFromPicker(cameraInputRef.current?.files?.[0]);
    if (cameraInputRef.current) cameraInputRef.current.value = "";
  }

  function clearFile() {
    if (fileInputRef.current) fileInputRef.current.value = "";
    setFilePreview(null);
  }

  function pickQuickReply(qr: QuickReplyOption) {
    clearFile();
    setSelectedQuickReply(qr);
    setPickerOpen(false);
    if (textRef.current && !textRef.current.value.trim()) {
      textRef.current.value = qr.captionText ?? "";
      setHasText(!!qr.captionText?.trim());
    }
  }

  function clearQuickReply() {
    setSelectedQuickReply(null);
  }

  const hasContent = hasText || !!filePreview || !!selectedQuickReply;

  return (
    <div className="flex-shrink-0 bg-[#f0f2f5] px-2.5 py-2">
      {/* Slim utility row for this app's own extras (Quick Reply picker, Send
          Template) — kept visually separate from the WhatsApp-authentic input
          row below so that row can look/feel exactly like the real app. */}
      {(quickReplies.length > 0 || extraToolbar) && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5 px-0.5">
          {quickReplies.length > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                className="flex h-7 items-center gap-1 rounded-full border border-gray-300 bg-white px-2.5 text-[11px] font-medium text-gray-600 hover:bg-gray-50"
              >
                <Zap size={12} /> Quick Reply
              </button>
              {pickerOpen && (
                <div className="absolute bottom-full left-0 z-10 mb-2 max-h-64 w-64 overflow-y-auto rounded-lg border border-gray-200 bg-white p-1.5 shadow-lg">
                  {quickReplies.map((qr) => (
                    <button
                      key={qr.id}
                      type="button"
                      onClick={() => pickQuickReply(qr)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-gray-50"
                    >
                      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded bg-gray-100">
                        {qr.mediaType === "VIDEO" ? (
                          <span className="text-sm">🎬</span>
                        ) : (
                          <img src={qr.mediaUrl} alt="" className="h-full w-full object-cover" />
                        )}
                      </span>
                      <span className="truncate font-medium text-gray-800">{qr.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {extraToolbar}
        </div>
      )}

      {(filePreview || selectedQuickReply) && (
        <div className="mb-1.5 flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-600">
          {filePreview && (
            <>
              <span>{filePreview.kind === "VIDEO" ? "🎬" : "📎"}</span>
              <span className="flex-1 truncate">{filePreview.name}</span>
              <button type="button" onClick={clearFile} className="text-gray-400 hover:text-red-500">
                <X size={13} />
              </button>
            </>
          )}
          {selectedQuickReply && (
            <>
              <span>{selectedQuickReply.mediaType === "VIDEO" ? "🎬" : "📎"}</span>
              <span className="flex-1 truncate">Quick Reply: {selectedQuickReply.title}</span>
              <button type="button" onClick={clearQuickReply} className="text-gray-400 hover:text-red-500">
                <X size={13} />
              </button>
            </>
          )}
        </div>
      )}

      <form
        ref={formRef}
        action={async (formData) => {
          setSending(true);
          try {
            await action(formData);
          } finally {
            setSending(false);
            formRef.current?.reset();
            clearFile();
            clearQuickReply();
            setHasText(false);
          }
        }}
        className="flex items-end gap-2"
      >
        <input type="hidden" name="conversationId" value={conversationId} />
        {selectedQuickReply && <input type="hidden" name="quickReplyId" value={selectedQuickReply.id} />}
        <input ref={fileInputRef} type="file" name="file" className="hidden" />

        {/* The pill-shaped field — matches the real WhatsApp input bar: emoji
            icon inside on the left, paperclip + camera inside on the right. */}
        <div className="flex flex-1 items-center gap-1 rounded-3xl bg-white px-2 py-1.5 shadow-sm">
          <button
            type="button"
            onClick={() => textRef.current?.focus()}
            title="Emoji"
            className="flex-shrink-0 p-1 text-gray-400 hover:text-gray-600"
          >
            <Smile size={20} />
          </button>
          <textarea
            ref={textRef}
            name="text"
            placeholder="Message"
            rows={1}
            onChange={(e) => setHasText(e.target.value.trim().length > 0)}
            className="max-h-24 flex-1 resize-none bg-transparent py-1 text-[14.5px] leading-snug text-gray-900 outline-none placeholder:text-gray-400"
          />
          <label title="Attach a photo or video" className="flex-shrink-0 cursor-pointer p-1 text-gray-400 hover:text-gray-600">
            <Paperclip size={19} />
            <input
              ref={galleryInputRef}
              type="file"
              accept="image/*,video/*"
              onChange={handleGalleryChange}
              className="hidden"
            />
          </label>
          <label title="Take a photo now" className="flex-shrink-0 cursor-pointer p-1 text-gray-400 hover:text-gray-600">
            <Camera size={19} />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*,video/*"
              capture="environment"
              onChange={handleCameraChange}
              className="hidden"
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={sending || !hasContent}
          title={hasContent ? "Send" : "Type a message or attach a photo/video to send — voice messages aren't supported"}
          className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-white transition-colors disabled:cursor-not-allowed ${
            hasContent ? "bg-accent hover:bg-emerald-600" : "bg-gray-300"
          }`}
        >
          {sending ? <Loader2 size={18} className="animate-spin" /> : hasContent ? <Send size={18} /> : <Mic size={18} />}
        </button>
      </form>
    </div>
  );
}
