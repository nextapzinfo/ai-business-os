import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// Every data-fetching page/action should go through this — never trust a
// client-supplied organizationId, always derive it from the signed-in session.
export async function getCurrentUser() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;
  return session.user;
}
