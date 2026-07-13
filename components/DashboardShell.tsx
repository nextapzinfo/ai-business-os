"use client";

import { useState } from "react";
import { Menu, X } from "lucide-react";
import SidebarNav, { type NavItem } from "@/components/SidebarNav";
import SignOutButton from "@/components/SignOutButton";

// Wraps every /dashboard/* page. The sidebar used to be a permanent 180px
// column (fine on desktop, but on a ~360-400px phone screen it ate roughly
// half the viewport and squeezed everything else). Below the `lg` breakpoint
// it's now an off-canvas drawer: hidden by default, opened via the hamburger
// button in a slim mobile top bar, closed via the X button or tapping the
// backdrop. Above `lg` it behaves exactly like before — always visible,
// sticky, no top bar. This is a client component only because the open/closed
// state needs to live somewhere; everything else about the layout is static.
export default function DashboardShell({
  navItems,
  userName,
  userRole,
  children,
}: {
  navItems: NavItem[];
  userName?: string | null;
  userRole?: string | null;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Mobile-only top bar — desktop keeps the sidebar permanently visible so this is redundant there */}
      <div className="fixed inset-x-0 top-0 z-30 flex h-12 items-center gap-2 border-b border-black/10 bg-primary-dark px-3 print:hidden lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-white hover:bg-white/10"
          aria-label="Open menu"
        >
          <Menu size={20} />
        </button>
        <div className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-md bg-accent text-[10px] font-bold text-white">
          AI
        </div>
        <span className="truncate text-sm font-semibold text-white">AI Business OS</span>
      </div>

      {/* Backdrop — mobile only, only rendered while the drawer is open */}
      {open && (
        <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setOpen(false)} />
      )}

      {/* Sidebar — fixed off-canvas drawer on mobile (slides in/out), sticky always-visible column on desktop */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex h-screen w-[220px] flex-shrink-0 flex-col overflow-y-auto bg-primary-dark p-2.5 transition-transform duration-200 ease-out print:hidden lg:sticky lg:top-0 lg:z-auto lg:w-[180px] lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between gap-1.5 px-1 py-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-md bg-accent text-[10px] font-bold text-white">
              AI
            </div>
            <span className="truncate text-xs font-semibold leading-tight text-white">AI Business OS</span>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-white/70 hover:bg-white/10 lg:hidden"
            aria-label="Close menu"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tapping a nav link closes the drawer (bubbles up from the <a> click) — on
            desktop this onClick is harmless since the drawer concept doesn't apply there. */}
        <div className="mt-3" onClick={() => setOpen(false)}>
          <SidebarNav items={navItems} />
        </div>

        <div className="mt-auto border-t border-white/10 pt-3">
          {userName && (
            <div className="px-1">
              <p className="truncate text-xs font-medium text-white">{userName}</p>
              <p className="text-[10px] uppercase tracking-wide text-white/50">{userRole}</p>
            </div>
          )}
          <SignOutButton />
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-4 pt-14 print:p-0 lg:p-8">{children}</main>
    </div>
  );
}
