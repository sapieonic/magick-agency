# packages/contracts

The wire contract shared by the server, both web UIs and (through fixtures) the mobile app. A
shared file: every change ships with its server and UI consumers and their tests in the same
commit. `pnpm lint` typechecks `test/` too, and several guards are type-level, so lint is part of
the test.

## Two families of agency types

- **Dialer contract:** `src/agency.ts`, a barrel over `src/agency/*.ts`, error unions in
  `src/errors.ts`. What the internal handler instance and the dialer runtime produce, station
  socket frames included.
- **Console wire types:** `src/api/agency/`. What the public API layer serves after enrichment.
  Where a name exists in both they are not interchangeable. Every difference is listed in
  `src/api/agency/CONTRACT-DIFF.md`: update it when you change either side.
- Platform wire types: `src/api/platform/`. RBAC permissions: `src/rbac.ts`. Flags: `src/flags.ts`
  (also register a new flag in `apps/server/src/feature-flags/registry.ts`).

## Guards

- **Error-code unions:** each union (`AgencyActionErrorCode`, `AgencySoftphoneErrorCode`, the
  telephony-credential codes, ...) has a `*_ERROR_CODES` list held equal to it by a two-sided
  exhaustiveness guard and a hand-written snapshot (`test/errors.test.ts`). A new code goes in the
  union, the list and the snapshot.
- `test/console-wire-diff.test.ts` and `test/console-wire-derived.test.ts` pin the console types
  to the dialer contract at type level.
- **Mobile drift:** the Dart app cannot import this package. `fixtures/agent/*.json` are wire
  samples its `agency_wire` package decodes, and `fixtures/agent/literals.json` holds every closed
  string vocabulary it switches on. After changing a literal union, const list or a fixture-backed
  shape, regenerate and commit:

  ```bash
  node ../../tooling/contracts-literals.mjs          # rewrite literals.json
  node ../../tooling/contracts-literals.mjs --check  # what CI runs
  ```

  `test/agent-fixtures.test.ts` fails `pnpm test` on a stale file, and the mobile CI job
  (which every change to this package runs) runs the Dart side. The extractor only reads plain literal
  unions, `as const` lists and objects: keep those declarations plain.
