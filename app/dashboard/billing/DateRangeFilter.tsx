// Plain HTML links + a GET form — no client JS needed. Presets navigate
// straight to a new query string; the browser's own date pickers handle the
// custom range, submitted via a normal form GET so the URL stays shareable
// and the CSV export / print button can read the exact same params.
export default function DateRangeFilter({
  currentRange,
  from,
  to,
}: {
  currentRange: string;
  from?: string;
  to?: string;
}) {
  const presets = [
    { key: "today", label: "Today" },
    { key: "yesterday", label: "Yesterday" },
    { key: "week", label: "This Week" },
    { key: "month", label: "This Month" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white p-3">
      <span className="text-xs font-medium text-gray-500">Range:</span>
      {presets.map((p) => (
        <a
          key={p.key}
          href={`/dashboard/billing?range=${p.key}`}
          className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
            currentRange === p.key
              ? "bg-primary text-white"
              : "border border-gray-300 text-gray-600 hover:bg-gray-50"
          }`}
        >
          {p.label}
        </a>
      ))}
      <form method="get" action="/dashboard/billing" className="flex flex-wrap items-center gap-1.5">
        <input type="hidden" name="range" value="custom" />
        <input
          type="date"
          name="from"
          defaultValue={from}
          required
          className="rounded-lg border border-gray-300 px-2 py-1 text-xs"
        />
        <span className="text-xs text-gray-400">to</span>
        <input
          type="date"
          name="to"
          defaultValue={to}
          required
          className="rounded-lg border border-gray-300 px-2 py-1 text-xs"
        />
        <button
          type="submit"
          className={`rounded-lg px-2.5 py-1 text-xs font-medium ${
            currentRange === "custom"
              ? "bg-primary text-white"
              : "border border-gray-300 text-gray-600 hover:bg-gray-50"
          }`}
        >
          Custom
        </button>
      </form>
    </div>
  );
}
