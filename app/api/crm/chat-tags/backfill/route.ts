import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { backfillChatTagsBatch, chatTagBackfillStatus } from "@/lib/chat-tags";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One-time "Read all old chats" (CRM Step 2b). The Clients page button calls
// POST repeatedly — each call reads one small batch of customers' chats and
// returns how many are still left, so no single request runs too long.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await chatTagBackfillStatus(user.organizationId));
}

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await backfillChatTagsBatch(user.organizationId, 12);
    return NextResponse.json(result);
  } catch (err) {
    console.error("chat-tag backfill batch failed", err);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
