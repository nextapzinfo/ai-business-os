"use client";

import { useRef, useState } from "react";
import { Paperclip, X, Zap } from "lucide-react";

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
// chai". Pulled into its own Client Component (same reasoning as
// AddClientForm, 2026-08-27) because a Server Action form's plain
// uncontrolled inputs don't remount/reset on their own — this one additionally
// needs local state for the file preview and the Quick Reply picker, which a
// Server Component can't hold at all.
export default function ConversationReplyBox({
  action,
  conversationId,
  quickReplies,
}: {
  action: (formData: FormData) => Promise<void>;
  conversationId: string;
  quickReplies: QuickReplyOption[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [filePreview, setFilePreview] = useState<{ name: string; kind: "IMAGE" | "VIDEO" } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedQuickReply, setSelectedQuickReply] = useState<QuickReplyOption | null>(null);
  const [sending, setSending] = useState(false);

  function handleFileChange() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setFilePreview(null);
      return;
    }
    // A file and a Quick Reply are mutually exclusive — WhatsApp only sends
    // one attachment per message, so picking one clears the other rather
    // than leaving an ambiguous combination sitting in the form.
    setSelectedQuickReply(null);
    setFilePreview({ name: file.name, kind: file.type.startsWith("video/") ? "VIDEO" : "IMAGE" });
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
    }
  }

  function clearQuickReply() {
    setSelectedQuickReply(null);
  }

  return (
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
        }
      }}
      className="flex flex-1 flex-col gap-1.5"
    >
      <input type="hidden" name="conversationId" value={conversationId} />
      {selectedQuickReply && <input type="hidden" name="quickReplyId" value={selectedQuickReply.id} />}

      {(filePreview || selectedQuickReply) && (
        <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-600">
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

      <div className="flex items-center gap-2">
        <label
          title="Attach a photo or video from this device"
          className="flex h-[44px] w-[44px] flex-shrink-0 cursor-pointer items-center justify-center rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50"
        >
          <Paperclip size={17} />
          <input
            ref={fileInputRef}
            type="file"
            name="file"
            accept="image/*,video/*"
            onChange={handleFileChange}
            className="hidden"
          />
        </label>

        {quickReplies.length > 0 && (
          <div className="relative flex-shrink-0">
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              title="Send a saved Quick Reply"
              className="flex h-[44px] w-[44px] items-center justify-center rounded-lg border border-gray-300 text-gray-500 hover:bg-gray-50"
            >
              <Zap size={17} />
            </button>
            {pickerOpen && (
              <div className="absolute bottom-[50px] left-0 z-10 max-h-64 w-64 overflow-y-auto rounded-lg border border-gray-200 bg-white p-1.5 shadow-lg">
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

        <textarea
          ref={textRef}
          name="text"
          placeholder="Type a reply, or attach/pick a Quick Reply..."
          rows={1}
          className="h-[44px] flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2.5 text-sm leading-tight"
        />
        <button
          type="submit"
          disabled={sending}
          className="h-[44px] flex-shrink-0 rounded-lg bg-primary px-4 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-60"
        >
          {sending ? "Sending..." : "Send"}
        </button>
      </div>
    </form>
  );
}
