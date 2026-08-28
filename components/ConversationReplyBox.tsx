"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, ImageIcon, Loader2, Paperclip, Send, Smile, X, Zap } from "lucide-react";

type QuickReplyOption = {
  id: string;
  title: string;
  mediaUrl: string | null; // null for a text-only Quick Reply (2026-08-28)
  mediaType: string | null; // IMAGE or VIDEO — null exactly when mediaUrl is null
  captionText: string | null;
};

// The Conversations reply box — text, a one-off PC/mobile photo/video upload,
// or a saved Quick Reply, all through the one form/send button. Added
// 2026-08-28, owner's own request: "Conversation e ami Pic / video from my
// pc/mob .. or some pre attachment thakbe quick reply hisebe -- send korte
// chai". Restyled 2026-08-28 (same day) into a genuine WhatsApp-look input
// bar, then refined again the same day per the owner's own follow-up
// corrections after seeing it live: no separate mic icon (this app has no
// voice-message feature — the send button is now always a plain send/paper-
// plane icon, just grayed out with nothing to send), no separate camera icon
// sitting in the pill (folded into the paperclip's own attach-type menu
// instead, "when click on attachment then attachment type option will be
// there"), and Quick Reply + Send Template are now compact icon "signs" *in*
// this one WhatsApp-style row rather than a second, separate slim row above
// it ("Quick Reply and Template sign only there- so that part will more
// thin"). Pulled into its own Client Component (same reasoning as
// AddClientForm, 2026-08-27) because a Server Action form's plain
// uncontrolled inputs don't remount/reset on their own — this one
// additionally needs local state for the file preview, the attach menu, and
// the Quick Reply picker, which a Server Component can't hold at all.
export default function ConversationReplyBox({
  action,
  conversationId,
  quickReplies,
  extraToolbar,
}: {
  action: (formData: FormData) => Promise<void>;
  conversationId: string;
  quickReplies: QuickReplyOption[];
  extraToolbar?: React.ReactNode; // e.g. a compact SendTemplateButton — app-specific, not part of stock WhatsApp UI, rendered as one more small icon inside the input pill alongside Quick Reply
}) {
  const formRef = useRef<HTMLFormElement>(null);
  // The canonical field actually submitted as "file" — never clicked directly.
  // Both the gallery (file picker) and camera (direct capture on mobile)
  // inputs below are separate, unnamed "trigger" inputs, now only ever opened
  // from the attach-type menu rather than their own dedicated icons; whichever
  // one is used copies its chosen File into this one via the DataTransfer
  // trick, so the server action only ever sees a single "file" field no
  // matter which control was used to pick it.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const quickReplyMenuRef = useRef<HTMLDivElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const [filePreview, setFilePreview] = useState<{ name: string; kind: "IMAGE" | "VIDEO" } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [selectedQuickReply, setSelectedQuickReply] = useState<QuickReplyOption | null>(null);
  const [sending, setSending] = useState(false);
  const [hasText, setHasText] = useState(false); // tracked separately from the uncontrolled textarea so the send button's enabled/disabled look can react live without controlling (and risking cursor jumps in) the field itself
  // WhatsApp-style "/" slash-command Quick Reply lookup — added 2026-08-28,
  // owner's own request: "Quick reply add korarjonno Wts app r moto - "/"
  // diye Lebel r 1st letter type korlei oi message gulo cholo asbe - like
  // "/V" dile V die ja ja quick reply ami add kore rekhechi seta dakhabe, r
  // ota send kora jabe" (typing "/" then a letter should show matching
  // Quick Replies by their label, pickable and sendable). null = the
  // message doesn't currently start with "/"; "" = just "/" was typed (show
  // every Quick Reply); anything else = the text typed after the "/".
  const [slashQuery, setSlashQuery] = useState<string | null>(null);

  // Close whichever small popup (attach-type menu, Quick Reply list) is open
  // when the owner taps anywhere else — same pattern SendTemplateButton
  // already used for its own dropdown.
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) setAttachOpen(false);
      if (quickReplyMenuRef.current && !quickReplyMenuRef.current.contains(e.target as Node)) setPickerOpen(false);
      if (slashMenuRef.current && !slashMenuRef.current.contains(e.target as Node)) setSlashQuery(null);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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

  // Selecting a Quick Reply from the "/" slash menu always overwrites
  // whatever "/query" text is currently typed with the Quick Reply's own
  // caption (unlike the Zap-icon pickQuickReply above, which only fills the
  // caption in if the box was already empty) — the "/query" text was never
  // meant to be sent as-is, it was just how the customer typed to search.
  function pickQuickReplyFromSlash(qr: QuickReplyOption) {
    clearFile();
    setSelectedQuickReply(qr);
    setSlashQuery(null);
    if (textRef.current) {
      textRef.current.value = qr.captionText ?? "";
      setHasText(!!qr.captionText?.trim());
    }
  }

  function handleTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setHasText(val.trim().length > 0);
    setSlashQuery(val.startsWith("/") ? val.slice(1) : null);
  }

  const slashMatches =
    slashQuery !== null
      ? quickReplies.filter((qr) => qr.title.toLowerCase().startsWith(slashQuery.toLowerCase()))
      : [];

  const hasContent = hasText || !!filePreview || !!selectedQuickReply;

  return (
    <div className="flex-shrink-0 bg-[#f0f2f5] px-2.5 py-2">
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
              <span>{selectedQuickReply.mediaType === "VIDEO" ? "🎬" : selectedQuickReply.mediaType === "IMAGE" ? "📎" : "💬"}</span>
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
            setSlashQuery(null);
          }
        }}
        className="flex items-end gap-2"
      >
        <input type="hidden" name="conversationId" value={conversationId} />
        {selectedQuickReply && <input type="hidden" name="quickReplyId" value={selectedQuickReply.id} />}
        <input ref={fileInputRef} type="file" name="file" className="hidden" />

        {/* The pill-shaped field — matches the real WhatsApp input bar: emoji
            icon on the left, everything else (Quick Reply, Send Template,
            Attach) as small icon "signs" on the right, in one row. */}
        <div className="flex flex-1 items-center gap-1 rounded-3xl bg-white px-2 py-1.5 shadow-sm">
          <button
            type="button"
            onClick={() => textRef.current?.focus()}
            title="Emoji"
            className="flex-shrink-0 p-1 text-gray-400 hover:text-gray-600"
          >
            <Smile size={20} />
          </button>
          <div ref={slashMenuRef} className="relative min-w-0 flex-1">
            <textarea
              ref={textRef}
              name="text"
              placeholder='Message, or type "/" for a Quick Reply'
              rows={1}
              onChange={handleTextChange}
              className="max-h-24 w-full resize-none bg-transparent py-1 text-[14.5px] leading-snug text-gray-900 outline-none placeholder:text-gray-400"
            />
            {/* "/" slash-command Quick Reply lookup, WhatsApp-style — added
                2026-08-28, see the slashQuery state comment above. */}
            {slashQuery !== null && quickReplies.length > 0 && (
              <div className="absolute bottom-full left-0 z-10 mb-2 max-h-56 w-72 overflow-y-auto rounded-lg border border-gray-200 bg-white p-1.5 shadow-lg">
                {slashMatches.length > 0 ? (
                  slashMatches.map((qr) => (
                    <button
                      key={qr.id}
                      type="button"
                      onClick={() => pickQuickReplyFromSlash(qr)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-gray-50"
                    >
                      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded bg-gray-100">
                        {qr.mediaType === "VIDEO" ? (
                          <span className="text-sm">🎬</span>
                        ) : qr.mediaUrl ? (
                          <img src={qr.mediaUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <span className="text-sm">💬</span>
                        )}
                      </span>
                      <span className="truncate font-medium text-gray-800">/{qr.title}</span>
                    </button>
                  ))
                ) : (
                  <p className="px-2 py-1.5 text-xs text-gray-400">No Quick Reply starts with "{slashQuery}"</p>
                )}
              </div>
            )}
          </div>

          {quickReplies.length > 0 && (
            <div ref={quickReplyMenuRef} className="relative flex-shrink-0">
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                title="Quick Reply"
                className="flex-shrink-0 p-1 text-gray-400 hover:text-gray-600"
              >
                <Zap size={19} />
              </button>
              {pickerOpen && (
                <div className="absolute bottom-full right-0 z-10 mb-2 max-h-64 w-64 overflow-y-auto rounded-lg border border-gray-200 bg-white p-1.5 shadow-lg">
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
                        ) : qr.mediaUrl ? (
                          <img src={qr.mediaUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <span className="text-sm">💬</span>
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

          {/* Attach — a single paperclip that opens an attachment-type menu
              (Photo/Video from gallery, or Camera) instead of a separate
              dedicated camera icon sitting in the pill. Added 2026-08-28,
              owner's own request after seeing the camera icon live: "no need
              camera Icon there... when click on attachment then attachment
              type option will be there." */}
          <div ref={attachMenuRef} className="relative flex-shrink-0">
            <button
              type="button"
              onClick={() => setAttachOpen((v) => !v)}
              title="Attach a photo or video (photo max 5MB, video max 16MB)"
              className="flex-shrink-0 p-1 text-gray-400 hover:text-gray-600"
            >
              <Paperclip size={19} />
            </button>
            {attachOpen && (
              <div className="absolute bottom-full right-0 z-10 mb-2 w-44 rounded-lg border border-gray-200 bg-white p-1.5 shadow-lg">
                <button
                  type="button"
                  onClick={() => {
                    galleryInputRef.current?.click();
                    setAttachOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50"
                >
                  <ImageIcon size={15} className="text-purple-500" /> Photo / Video
                </button>
                <button
                  type="button"
                  onClick={() => {
                    cameraInputRef.current?.click();
                    setAttachOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-gray-700 hover:bg-gray-50"
                >
                  <Camera size={15} className="text-pink-500" /> Camera
                </button>
              </div>
            )}
            <input
              ref={galleryInputRef}
              type="file"
              accept="image/*,video/*"
              onChange={handleGalleryChange}
              className="hidden"
            />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*,video/*"
              capture="environment"
              onChange={handleCameraChange}
              className="hidden"
            />
          </div>
        </div>

        {/* Always a plain send icon — no mic. This app has no voice-message
            feature, so a mic control (even a purely visual/disabled one)
            would be misleading. Added 2026-08-28, owner's own request: "Voice
            icon no need, bcoz, amader ei feature ta akhono nei". */}
        <button
          type="submit"
          disabled={sending || !hasContent}
          title={hasContent ? "Send" : "Type a message, or attach/pick something to send"}
          className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-white transition-colors disabled:cursor-not-allowed ${
            hasContent ? "bg-accent hover:bg-emerald-600" : "bg-gray-300"
          }`}
        >
          {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
        </button>
      </form>
    </div>
  );
}
