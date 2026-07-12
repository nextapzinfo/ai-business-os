"use client";

import { useState } from "react";

type ClientOption = { id: string; name: string; phone: string };

export default function ClientCheckboxList({ clients }: { clients: ClientOption[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

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

  return (
    <div>
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
    </div>
  );
}
