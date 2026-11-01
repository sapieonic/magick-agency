# apps/super-admin

Vite + React SPA for platform operators: tenants, users, admins, phone numbers, telephony
credentials (Plivo on tenants' own accounts), limits, feature flags, usage and audit.

- Dev: `pnpm dev` on :5176. Only `/super-admin` is proxied to :3021 (`vite.config.ts`); UI routes
  sit at the root, so nothing collides on reload.
- Auth is the super-admin's own JWT, not Firebase: `saFetch` in `src/api/super-admin.ts` keeps it
  in `sessionStorage`. Route paths live in `src/api/saRoutes.ts`.
- First super-admin is created from `apps/server` with `scripts/create-super-admin.ts` (no seeded
  credentials; see `apps/server/CLAUDE.md`).
- Shared components and helpers come from `packages/web-ui`; add there, not here, anything the
  console also needs.
- Branding guards (`src/__tests__/branding/`) must stay green.
- `pnpm test` from this directory; TZ is pinned to UTC in `vite.config.ts`.
