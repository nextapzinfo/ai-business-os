"use client";

import { signOut } from "next-auth/react";

export default function SignOutButton() {
  return (
    <button
      onClick={() => signOut({ callbackUrl: "/login" })}
      style={{
        marginTop: 24,
        background: "none",
        border: "1px solid #ddd",
        borderRadius: 6,
        padding: "6px 10px",
        cursor: "pointer",
        fontSize: 13,
      }}
    >
      Sign Out
    </button>
  );
}
