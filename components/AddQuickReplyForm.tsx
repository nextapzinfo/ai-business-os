"use client";

import { useRef } from "react";

// Wraps the "Add a Quick Reply" form so it actually clears after a
// successful add — added 2026-08-28, owner's own bug report: "Add quick
// reply korar por niche add hoe jachhe but ota refresh hoe blank hoche na.
// ota auto blank hoe jabe" (after adding a Quick Reply, it gets added below
// but the form fields don't go blank — they should auto-clear). Exact same
// root cause and fix as AddClientForm (2026-08-27): a Server Action's
// revalidatePath() re-runs the page's data fetch and re-renders, but never
// remounts a plain uncontrolled <form>, so the DOM inputs (and the file
// picker) keep whatever was last chosen. `formRef.current.reset()` needs a
// ref, which only works in a Client Component — hence pulling this form out
// of the (Server Component) page into its own file, same pattern.
export default function AddQuickReplyForm({
  action,
}: {
  action: (formData: FormData) => Promise<void>;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={async (formData) => {
        await action(formData);
        formRef.current?.reset();
      }}
      className="mt-3 flex flex-col gap-2"
    >
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
          className="flex-1 basis-48 rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>
      <textarea
        name="captionText"
        placeholder="Caption sent alongside the file — or, if you leave the file blank above, this is the whole text-only reply"
        rows={2}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
      />
      <p className="text-[11px] text-gray-400">
        A file is optional — leave it blank for a text-only Quick Reply (just fill in the text above
        instead). Photo max 5MB, video max 16MB (WhatsApp's own limits).
      </p>
      <button
        type="submit"
        className="self-start rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light"
      >
        Add Quick Reply
      </button>
    </form>
  );
}
