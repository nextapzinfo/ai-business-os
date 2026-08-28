"use client";

import { useState, useTransition } from "react";
import { Tag, Users, X } from "lucide-react";
import { saveClientGroup, deleteClientGroup } from "./actions";

type ClientOption = { id: string; name: string; phone: string; tags: string[] };
type GroupOption = { id: string; name: string; clientIds: string[] };

// Recipient picker for the Broadcasts form. Beyond the plain checkbox list
// (unchanged), this now also supports two faster ways to build a selection —
// both added 2026-08-28, owner's own request: "Broadcase e r somoy Customer
// der sudhu select r option ache but ami jdi chai catagory hisebe or Interest
// hisebe boradcast korbo - seta korte parchi na - ar akbar select kore ami
// jdi group banie rakhi then next time taderke abar select korte hobe na."
//
// 1) Category/interest chips — reuses Client.tags (already set on the
//    Clients page's Add/Edit forms, e.g. "VIP", "Janmashtami", "Kolkata") as
//    a dynamic filter: tapping a tag adds every customer currently carrying
//    it to the selection. Dynamic on purpose — it always reflects whoever
//    has that tag right now, not a frozen snapshot.
// 2) Saved Groups — the opposite: a frozen, hand-picked list of specific
//    customers, saved once (via the "Save selection as a group" row below)
//    and reusable in any future broadcast with one click, so the same
//    customers never need reselecting by hand again.
//
// Both add to (never replace) the current selection, so they can be
// combined — e.g. a tag chip plus a couple of individually-checked extras —
// before sending.
export default function ClientCheckboxList({
  clients,
  tags,
  groups,
}: {
  clients: ClientOption[];
  tags: string[];
  groups: GroupOption[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState("");
  const [pending, startTransition] = useTransition();

  const allSelected = clients.length > 0 && selected.size === clients.length;

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(clients.map((c) => c.id)) : new Set());
  }

  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function selectByTag(tag: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      clients.filter((c) => c.tags.includes(tag)).forEach((c) => next.add(c.id));
      return next;
    });
  }

  function selectGroup(group: GroupOption) {
    setSelected((prev) => {
      const next = new Set(prev);
      group.clientIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function handleSaveGroup() {
    const name = groupName.trim();
    if (!name || selected.size === 0) return;
    const fd = new FormData();
    fd.append("name", name);
    selected.forEach((id) => fd.append("clientIds", id));
    startTransition(async () => {
      await saveClientGroup(fd);
      setGroupName("");
    });
  }

  function handleDeleteGroup(groupId: string) {
    const fd = new FormData();
    fd.append("groupId", groupId);
    startTransition(async () => {
      await deleteClientGroup(fd);
    });
  }

  return (
    <div>
      {tags.length > 0 && (
        <div className="mb-2">
          <p className="mb-1 flex items-center gap-1 text-[11px] font-medium text-gray-500">
            <Tag size={11} /> Select by category/interest
          </p>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => selectByTag(tag)}
                title={`Add everyone tagged "${tag}" to the selection below`}
                className="rounded-full border border-gray-300 bg-white px-2 py-0.5 text-[11px] text-gray-600 hover:bg-gray-50"
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
      )}

      {groups.length > 0 && (
        <div className="mb-2">
          <p className="mb-1 flex items-center gap-1 text-[11px] font-medium text-gray-500">
            <Users size={11} /> Saved groups
          </p>
          <div className="flex flex-wrap gap-1.5">
            {groups.map((g) => (
              <span
                key={g.id}
                className="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 py-0.5 pl-2 pr-1 text-[11px] text-primary"
              >
                <button
                  type="button"
                  onClick={() => selectGroup(g)}
                  title={`Add all ${g.clientIds.length} customers in "${g.name}" to the selection below`}
                >
                  {g.name} ({g.clientIds.length})
                </button>
                <button
                  type="button"
                  onClick={() => handleDeleteGroup(g.id)}
                  title={`Delete saved group "${g.name}"`}
                  className="rounded-full p-0.5 text-primary/60 hover:bg-primary/10 hover:text-primary"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <label className="mb-1.5 flex items-center gap-2 text-xs text-gray-700">
        <input type="checkbox" checked={allSelected} onChange={(e) => toggleAll(e.target.checked)} />
        Select all ({clients.length} customers)
      </label>
      <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-white p-1.5">
        {clients.map((c) => (
          <label key={c.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-xs text-gray-700 hover:bg-gray-50">
            <input
              type="checkbox"
              name="clientIds"
              value={c.id}
              checked={selected.has(c.id)}
              onChange={(e) => toggleOne(c.id, e.target.checked)}
            />
            {c.name} ({c.phone})
          </label>
        ))}
        {clients.length === 0 && <p className="p-1.5 text-xs text-gray-500">No customers yet.</p>}
      </div>

      {selected.size > 0 && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            type="text"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder={`Save these ${selected.size} as a group for next time (e.g. "VIP customers")`}
            className="flex-1 rounded-lg border border-gray-300 px-2 py-1 text-[11px]"
          />
          <button
            type="button"
            onClick={handleSaveGroup}
            disabled={pending || !groupName.trim()}
            className="flex-shrink-0 rounded-lg border border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save as Group
          </button>
        </div>
      )}
    </div>
  );
}
