# CLAUDE.md

Magick Agency: the agency dialer as one self-sufficient app. Spec:
`../MagickVoice-platform/docs/agency-extraction-plan.md` (v4.2). Domain
invariants: `../MagickVoice-platform/agency.md`. Status: `docs/build-status.md`.
Decisions: `docs/decisions.md`. Port ledger: `PORTING.md`.

## Rules that are not negotiable

- **Port verbatim** from core v1.123.2 / master v3.24.0 / cusui v2.96.0. The only
  allowed changes are the plan's (hop collapses, re-keying onto `agency_calls`,
  billing removal, VoBiz/SIP/softphone deletion). Each change gets a `PORTING.md`
  row and an equivalence or deletion test.
- **Test counts are evidence.** A ported suite reports its source's count minus the
  deletions listed in `PORTING.md`. Never `--reporter=basic` (Vitest 4: runs nothing, exits 0).
- **Ports:** Postgres 5436, Redis 6383 (db 0 dev, db 1 test), server 3021, console
  5175, super-admin 5176. Never 5432/5433/5434/6379/6380/6381.
- **Contracts and schema are lead-owned.** `packages/contracts` and
  `packages/db/migrations` change only through the lead.
- **Lane-owned files:** each lane adds config only in `apps/server/src/config/blocks/<lane>.ts`,
  routes only in `apps/server/src/api/<lane>.plugin.ts`, background work only in
  `apps/server/src/bootstrap/<lane>.ts`.
- **Scoped git:** no `git add -A`, no `git stash`. Nothing is pushed without Manas.
- Zod `.refine` runs on a dirty result: guard `BigInt` / `JSON.parse` inside it.
- Enumerate routes from Fastify's `onRoute` hook, never by grep.
