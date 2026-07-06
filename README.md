# AI Business OS — Dashboard App (Phase 1 Skeleton)

**Status: Written, not yet run/tested** — Claude's code sandbox is temporarily down (disk space issue), so these files were hand-written and have not been installed or compiled yet. Once the sandbox is back, the next session will run `npm install`, fix anything that fails, and confirm it boots.

## What's in this folder so far

- `package.json` — Next.js 14 + TypeScript + Prisma + NextAuth + bcrypt + zod
- `prisma/schema.prisma` — Multi-tenant-ready database schema: `Organization`, `User` (with `Role`: OWNER/ADMIN/STAFF), `Client`, `Document`, `Conversation`, `Message`, `Reminder`, `AuditLog`. Every business table carries `organizationId`.
- `app/` — Next.js App Router pages: landing page (`/`) and a dashboard shell (`/dashboard`) with placeholder pages for Clients, Conversations, Knowledge Base, and Reminders.
- `.env.example` — the environment variables this app will need (database, auth secret, AI API key, WhatsApp Cloud API credentials).

## Auth + RBAC (added — Step 3)

- `lib/auth.ts` — NextAuth credentials provider, checks email/password against `User` table (bcrypt)
- `app/api/auth/[...nextauth]/route.ts` — NextAuth route handler
- `app/login/page.tsx` — login form
- `middleware.ts` — blocks `/dashboard/*` for anyone not signed in
- `lib/rbac.ts` — central `can(role, action)` permission map (OWNER/ADMIN/STAFF) — all future role checks should go through this, not inline `role === "..."` checks
- `components/Providers.tsx` / `SignOutButton.tsx` — session context + sign-out
- `prisma/seed.ts` — creates one demo organization + one OWNER user (`owner@demo-ca-firm.test` / `ChangeMe123!`) so there's a way to log in before a signup flow exists

## Live dashboard pages (added — Step 4)

All pages are now real Server Components reading/writing through Prisma, scoped by `organizationId` from the signed-in session (never trusted from a form):

- **Overview** — client count, open conversations, pending reminders
- **Clients** — list + "Add Client" form (server action)
- **Reminders** — list + "Add Reminder" form, checks the client belongs to the same org before attaching
- **Conversations** — list with last message (empty until Phase 3 wires WhatsApp)
- **Knowledge Base** — list of uploaded documents (upload itself comes in Phase 2)

## Security hardening (added — Step 5)

- `next.config.mjs` — HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy headers on every response (Vercel enforces HTTPS at the edge automatically; these reinforce it)
- `lib/audit.ts` + `AuditLog` model — every client/reminder create is now logged (who, what, when) — satisfies the Compliance Notes' "Access Logs" requirement
- `.gitignore` — makes sure `.env` (real secrets) never gets committed
- Passwords already hashed with bcrypt (Step 3); DB connection string uses `sslmode=require` (encrypted in transit)

## What's NOT built yet (still to do in Phase 1)

- A real signup/onboarding flow (right now only the seeded demo user can log in)
- Deployment to Vercel + Neon (this needs your accounts — see Roadmap doc Section 7 checklist)

## How this will eventually run (once sandbox/setup is ready)

```
npm install
cp .env.example .env      # fill in real values
npx prisma migrate dev    # creates tables in your Neon database
npm run prisma:seed       # creates the demo org + login user
npm run dev                # starts local dev server at http://localhost:3000
```

You (the user) won't need to type these commands yourself — Claude will run them once the sandbox is available, or guide you step by step if working from your own machine.
