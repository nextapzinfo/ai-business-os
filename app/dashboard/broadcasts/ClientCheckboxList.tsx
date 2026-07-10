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
      <label style={{ display: "block", marginBottom: 8, fontSize: 14 }}>
        <input
          type="checkbox"
          checked={allSelected}
          onChange={(e) => toggleAll(e.target.checked)}
        />{" "}
        Select all ({clients.length} customers)
      </label>
      <div
        style={{
          maxHeight: 240,
          overflowY: "auto",
          border: "1px solid #e5e5e5",
          borderRadius: 6,
          padding: 8,
          background: "#fff",
        }}
      >
        {clients.map((c) => (
          <label key={c.id} style={{ display: "block", fontSize: 14, padding: "4px 0" }}>
            <input
              type="checkbox"
              name="clientIds"
              value={c.id}
              checked={selected.has(c.id)}
              onChange={(e) => toggleOne(c.id, e.target.checked)}
            />{" "}
            {c.name} ({c.phone})
          </label>
        ))}
        {clients.length === 0 && <p style={{ fontSize: 14, color: "#666" }}>No customers yet.</p>}
      </div>
    </div>
  );
}