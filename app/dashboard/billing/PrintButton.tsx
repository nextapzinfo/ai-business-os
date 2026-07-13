"use client";

// window.print() renders the current page via the browser's print dialog —
// "Save as PDF" is a built-in destination on every OS, so this covers the
// "Export to PDF" requirement with zero new dependencies. The filter bar,
// rate-settings form, and sidebar are hidden via the `print:hidden` Tailwind
// variant (see DashboardShell + billing page) so the printed sheet is just
// the numbers, not the app chrome.
export default function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
    >
      Print / Save PDF
    </button>
  );
}
