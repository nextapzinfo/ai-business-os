"use client";

import { useState, useTransition } from "react";
import ConfirmSubmitButton from "@/components/ConfirmSubmitButton";
import { formatDate } from "@/lib/formatDate";

type ProductInterest = { id: string; note: string | null; product: { name: string } };

export type ClientRowData = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  pinCode: string | null;
  tags: string[];
  interestedIn: string | null;
  createdAt: Date;
  productInterests: ProductInterest[];
};

function initialOf(name: string) {
  return (name?.trim()?.[0] ?? "?").toUpperCase();
}

const AVATAR_COLORS = ["bg-emerald-500", "bg-sky-500", "bg-amber-500", "bg-violet-500", "bg-rose-500"];
function avatarColor(seed: string) {
  const idx = seed.split("").reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % AVATAR_COLORS.length;
  return AVATAR_COLORS[idx];
}

const cellInputClass =
  "w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-sm text-gray-700 hover:border-gray-200 focus:border-primary focus:bg-white focus:outline-none";

// One directly-editable Clients table row — replaces the old "Edit" toggle
// + dropdown pattern. Added 2026-08-28, owner's own request: "client e Edit
// option ta tule die - okhane Save tb dao - ar each field e direct option
// dao edit korar" (remove the Edit option, put a Save [button] there
// instead, and give a direct-edit option on each field) — plus a companion
// bug report on the old pattern: "Save changes e click korle ota chole
// jache na - jotokkhon na ami edit abar click korbo.. Save changes hole ota
// auto roll up hobe" (clicking Save Changes didn't collapse the edit panel
// back — it should auto roll up). This redesign resolves both at once:
// every field is a plain always-visible input right in the table cell (no
// expand/collapse to get stuck open), and Save just submits in place with
// nothing to "roll up" afterward. Source is intentionally NOT one of these
// editable fields ("Source ta darkar nei") — it's system-detected (WhatsApp
// referral / manual / imported / website), not something staff hand-edit,
// so it stays a plain read-only badge, same as before.
//
// Calls updateClient/deleteClient directly as async server functions (same
// pattern as flagMessageWrong / saveClientGroup elsewhere in this app)
// rather than a native <form>, since a <form> can't validly wrap just part
// of a <tr> without wrapping the whole <table>.
export default function ClientRow({
  client,
  sourceLabel,
  sourceDetail,
  updateClient,
  deleteClient,
}: {
  client: ClientRowData;
  sourceLabel: { label: string; className: string };
  sourceDetail: string | null;
  updateClient: (formData: FormData) => Promise<void>;
  deleteClient: (formData: FormData) => Promise<void>;
}) {
  const [name, setName] = useState(client.name);
  const [phone, setPhone] = useState(client.phone);
  const [email, setEmail] = useState(client.email ?? "");
  const [address, setAddress] = useState(client.address ?? "");
  const [pinCode, setPinCode] = useState(client.pinCode ?? "");
  const [tags, setTags] = useState(client.tags.join(", "));
  const [interestedIn, setInterestedIn] = useState(client.interestedIn ?? "");
  const [pending, startTransition] = useTransition();
  const [justSaved, setJustSaved] = useState(false);

  function handleSave() {
    const fd = new FormData();
    fd.append("clientId", client.id);
    fd.append("name", name);
    fd.append("phone", phone);
    fd.append("email", email);
    fd.append("address", address);
    fd.append("pinCode", pinCode);
    fd.append("interestedIn", interestedIn);
    fd.append("tags", tags);
    startTransition(async () => {
      await updateClient(fd);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1500);
    });
  }

  return (
    <tr className="border-b border-gray-50 align-top last:border-0">
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <div className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${avatarColor(client.name)}`}>
            {initialOf(name)}
          </div>
          <input value={name} onChange={(e) => setName(e.target.value)} className={`${cellInputClass} min-w-[110px] font-medium text-gray-900`} />
        </div>
      </td>
      <td className="px-4 py-2">
        <input value={phone} onChange={(e) => setPhone(e.target.value)} className={`${cellInputClass} min-w-[120px]`} />
      </td>
      <td className="px-4 py-2">
        <span title={sourceDetail ?? ""} className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${sourceLabel.className}`}>
          {sourceLabel.label}
        </span>
      </td>
      <td className="px-4 py-2">
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="—" className={`${cellInputClass} min-w-[140px]`} />
      </td>
      <td className="px-4 py-2">
        <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="—" className={`${cellInputClass} min-w-[160px]`} />
      </td>
      <td className="px-4 py-2">
        <input value={pinCode} onChange={(e) => setPinCode(e.target.value)} placeholder="—" className={`${cellInputClass} min-w-[80px]`} />
      </td>
      <td className="px-4 py-2">
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="—" className={`${cellInputClass} min-w-[130px]`} />
      </td>
      <td className="px-4 py-2">
        <div className="flex flex-col gap-1">
          <input value={interestedIn} onChange={(e) => setInterestedIn(e.target.value)} placeholder="—" className={`${cellInputClass} min-w-[130px]`} />
          {client.productInterests.length > 0 && (
            <div className="flex flex-wrap gap-1 px-1.5">
              {client.productInterests.map((pi) => (
                <span key={pi.id} title={pi.note ?? ""} className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] text-sky-700">
                  {pi.product.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </td>
      <td className="whitespace-nowrap px-4 py-2 text-gray-500">{formatDate(client.createdAt)}</td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleSave}
            disabled={pending}
            className={`whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-60 ${
              justSaved ? "bg-emerald-600" : "bg-primary hover:bg-primary-light"
            }`}
          >
            {pending ? "Saving…" : justSaved ? "Saved ✓" : "Save"}
          </button>
          <form action={deleteClient}>
            <input type="hidden" name="clientId" value={client.id} />
            <ConfirmSubmitButton
              label="Delete"
              confirmText={`Delete "${client.name}"? This can't be undone. (Clients with conversation/reminder history can't be deleted.)`}
              className="whitespace-nowrap rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
            />
          </form>
        </div>
      </td>
    </tr>
  );
}
