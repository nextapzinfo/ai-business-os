import { Role } from "@prisma/client";

// Central permission map — this is the ONLY place role rules should live.
// Add new actions here as features are built; never check role.name === "..." inline elsewhere.
const permissions = {
  "clients:view": ["OWNER", "ADMIN", "STAFF"],
  "clients:edit": ["OWNER", "ADMIN"],
  "documents:upload": ["OWNER", "ADMIN"],
  "reminders:manage": ["OWNER", "ADMIN", "STAFF"],
  "users:manage": ["OWNER", "ADMIN"],
  "organization:settings": ["OWNER"],
} as const satisfies Record<string, Role[]>;

export type Permission = keyof typeof permissions;

export function can(role: Role, action: Permission): boolean {
  return (permissions[action] as readonly Role[]).includes(role);
}
