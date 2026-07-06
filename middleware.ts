export { default } from "next-auth/middleware";

// Everything under /dashboard requires a signed-in user.
// Role-specific checks (RBAC) happen per-page/per-action via lib/rbac.ts,
// this middleware only enforces "must be logged in".
export const config = {
  matcher: ["/dashboard/:path*"],
};
