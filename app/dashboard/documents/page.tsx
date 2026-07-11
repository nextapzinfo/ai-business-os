import { redirect } from "next/navigation";

// The Knowledge Base moved into Agent Studio's "Knowledge" tab (matches AiSensy's
// Chat Agent > Knowledge tab layout) — this route stays only to redirect any old
// bookmarks/links so nothing 404s.
export default function DocumentsPage() {
  redirect("/dashboard/agent");
}
