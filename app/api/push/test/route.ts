import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { sendPushToOrg } from "@/lib/owner-notify";

export const dynamic = "force-dynamic";

// "Send a test" on the Notifications page.
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const sent = await sendPushToOrg(user.organizationId, {
    title: "✅ Notifications are on",
    body: "New customer messages will show here — tap to open the chat.",
    url: "/dashboard/conversations",
    tag: "test",
  });
  return NextResponse.json({ sent });
}
