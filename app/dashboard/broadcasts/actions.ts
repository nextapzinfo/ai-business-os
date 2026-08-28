"use server";

import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/getCurrentUser";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

// Reusable customer segments for Broadcasts — added 2026-08-28, owner's own
// request: "ar akbar select kore ami jdi group banie rakhi then next time
// taderke abar select korte hobe na" (once I've selected and saved a group,
// I shouldn't have to select them again next time). Deliberately separate
// from Client.tags (used as the dynamic "category/interest" quick-filter on
// the same page, see ClientCheckboxList) — a saved group is a fixed,
// hand-picked list of specific clients from the moment it was saved, while a
// tag filter always reflects whoever currently has that tag. Neither of
// these touches the Broadcast/BroadcastRecipient models at all — both are
// purely ways to fill in the same existing `clientIds` checkbox list faster.
//
// Called directly from ClientCheckboxList (a Client Component) as a plain
// async function — same pattern already used for flagMessageWrong in
// app/dashboard/conversations/[id]/actions.ts — rather than through a
// nested <form>, since ClientCheckboxList itself already lives inside the
// Broadcasts page's own <form action={createBroadcast}> and HTML forms
// can't nest.
export async function saveClientGroup(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return;

  const name = (formData.get("name") as string)?.trim();
  const clientIds = formData.getAll("clientIds") as string[];
  if (!name || clientIds.length === 0) return;

  // Re-verify every id actually belongs to this org before saving — clientIds
  // arrives from the browser, so this is the real access-control boundary,
  // not just a UI nicety.
  const clients = await prisma.client.findMany({
    where: { id: { in: clientIds }, organizationId: user.organizationId },
    select: { id: true },
  });
  if (clients.length === 0) return;

  const group = await prisma.clientGroup.create({
    data: {
      organizationId: user.organizationId,
      name,
      members: { create: clients.map((c) => ({ clientId: c.id })) },
    },
  });

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "CLIENT_GROUP_SAVED",
    metadata: { groupId: group.id, name, memberCount: clients.length },
  });

  revalidatePath("/dashboard/broadcasts");
}

export async function deleteClientGroup(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return;

  const groupId = formData.get("groupId") as string;
  const group = await prisma.clientGroup.findFirst({
    where: { id: groupId, organizationId: user.organizationId },
  });
  if (!group) return;

  await prisma.clientGroup.delete({ where: { id: groupId } }); // cascades to ClientGroupMember rows

  await logAudit({
    organizationId: user.organizationId,
    userId: user.id,
    action: "CLIENT_GROUP_DELETED",
    metadata: { groupId, name: group.name },
  });

  revalidatePath("/dashboard/broadcasts");
}
