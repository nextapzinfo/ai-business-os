"use client";

import { usePathname } from "next/navigation";
import ConversationList, { type ConversationListItem } from "@/components/ConversationList";

// On desktop this is a permanent two-column split (list + detail), same as
// before. On mobile there's no room for both at once — squeezing them
// side-by-side is what caused every word to wrap onto its own line and the
// header/buttons to get cut off at the screen edge. Below `lg`, only one
// column shows at a time based on the URL: bare /conversations shows the
// list full-width, /conversations/[id] shows the detail full-width. The
// detail page's own WhatsApp-style header (2026-08-28) now carries its own
// back arrow to return to the list — this component used to render a second,
// generic "Back to conversations" link above it, which would have doubled up.
export default function ConversationsSplitView({
  conversations,
  children,
}: {
  conversations: ConversationListItem[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isDetailView = pathname !== "/dashboard/conversations";
  // On mobile, the detail route drops DashboardShell's top bar and <main>'s
  // padding entirely (see that file) so a chat can fill the whole screen like
  // real WhatsApp — that frees up the 56px this container otherwise reserves
  // for the bar, so it needs the full viewport height there instead. The list
  // route is unaffected (still has the top bar), same calc as before. Desktop
  // always keeps the sidebar layout's fixed 64px (32px top + bottom) padding
  // regardless of which column is showing, so its calc never changes.
  const heightClass = isDetailView
    ? "h-dvh lg:h-[calc(100vh-64px)]"
    : "h-[calc(100dvh-56px)] lg:h-[calc(100vh-64px)]";

  return (
    <div className={`flex overflow-hidden ${heightClass}`}>
      <div
        className={`w-full flex-shrink-0 flex-col overflow-y-auto border-r border-gray-200 bg-white lg:flex lg:w-[260px] ${
          isDetailView ? "hidden lg:flex" : "flex"
        }`}
      >
        <div className="flex-shrink-0 border-b border-gray-100 px-3 py-2.5">
          <h2 className="text-sm font-semibold text-gray-900">Conversations</h2>
        </div>
        <ConversationList conversations={conversations} />
      </div>

      <div
        className={`min-w-0 flex-1 flex-col overflow-hidden lg:flex lg:pl-4 ${
          isDetailView ? "flex" : "hidden lg:flex"
        }`}
      >
        {children}
      </div>
    </div>
  );
}
