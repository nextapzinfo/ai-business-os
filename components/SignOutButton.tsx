"use client";

import { signOut } from "next-auth/react";
import { LogOut } from "lucide-react";

export default function SignOutButton() {
  return (
    <button
      onClick={() => signOut({ callbackUrl: "/login" })}
      className="mt-3 flex w-full items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-xs text-white/70 transition-colors hover:bg-white/10 hover:text-white"
    >
      <LogOut size={14} />
      Sign Out
    </button>
  );
}
