"use client";

import { useRef } from "react";

// Wraps the "Add a client" form so it actually clears after a successful
// add — added 2026-08-27, owner's own bug report: "add hochhe but entry
// place e ph no, name sob theke jachhe. ota blank hochhe na" (the client
// gets added, but Name/Phone/etc. stay filled in afterward instead of going
// blank). Root cause: the form used to live directly in the Server
// Component page with plain uncontrolled <input>s and
// `<form action={addClient}>` — a Server Action's revalidatePath() re-runs
// the page's data fetch and re-renders, but it does NOT remount the <form>,
// so React never touches the DOM input elements' values and they just sit
// there with whatever the owner last typed. `formRef.current.reset()` is
// the standard fix, but that needs a ref/hook, which only works in a
// Client Component — hence pulling the form out into its own file here
// rather than fixing this inline in the (Server Component) page.
export default function AddClientForm({
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
      className="mt-3 flex flex-wrap gap-2"
    >
      <input name="name" placeholder="Name" required className="flex-1 basis-40 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      <input name="phone" placeholder="Phone (with country code)" required className="flex-1 basis-40 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      <input name="email" placeholder="Email (optional)" className="flex-1 basis-40 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      <input name="address" placeholder="Address (optional)" className="flex-1 basis-48 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      <input name="pinCode" placeholder="Pin Code (optional)" className="flex-1 basis-28 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      <input name="interestedIn" placeholder="Interested In (optional)" className="flex-1 basis-40 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      <input name="tags" placeholder="Tags, comma separated (optional)" className="flex-1 basis-40 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light">
        Add Client
      </button>
    </form>
  );
}
