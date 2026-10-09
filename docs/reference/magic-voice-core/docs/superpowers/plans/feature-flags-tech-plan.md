> **Reference copy, verbatim below this box.** Origin: magic-voice-core @ `4850d1d9` (v1.123.2), path `docs/superpowers/plans/feature-flags-tech-plan.md`. Copied into Magick Agency on 2026-10-09; not kept in sync.
>
> **How this maps to Magick Agency:** The feature-flag service and super-admin override design. Agency keeps the service with its registry trimmed to the agency flags (`packages/contracts/src/flags.ts`) and serves the client map at `GET /feature-flags` instead of `/proxy/feature-flags`.
>
> Index of all copies: [`docs/reference/README.md`](../../../../README.md).

# Feature Flags — Technical Implementation Plan

**Status:** Ready for review
**Date:** 2026-06-23
**Author:** Atlas (Principal SWE)
**Design spec (authoritative):** `docs/superpowers/specs/2026-06-23-feature-flags-design.md`
**Branches:** core `claude/feature-flagging-tenant-rollout-m3s037` · master `feat/feature-flags` · cusui `feat/feature-flags`

This plan is **TDD-first**: every implementation item names the failing test(s) written
*before* the code. It clones proven patterns verbatim (`TenantSettingsCache`,
`AccountConcurrencyGuard` limit-resolution, `internal.routes.ts` S2S shape,
`metrics.ts` dual prom/OTel, `posthog.ts` fire-and-forget). Conventions to honour
everywhere: **ESM `.js` import suffixes**, `noUncheckedIndexedAccess` (index access is
`T | undefined`), Zod for all request/config validation, repository singleton export
(`export const xRepository = new XRepository()`), tests under `test/unit/` mirroring
`src/`, the `vi.hoisted()` mock pattern.

---

## Part 1 — CORE implementation (file by file, dependency order)

### 1.1 Migration `src/db/migrations/046_feature_flags.sql`

**Contents** (whole-file, applied by node-pg-migrate; no BEGIN/COMMIT wrapper, matching 044):

1. `CREATE TABLE IF NOT EXISTS feature_flag_overrides` exactly per spec §3 — columns
   `id/flag_key/scope_type/tenant_id/account_id/value JSONB/reason/expires_at/created_by/updated_by/created_at/updated_at`,
   the `ck_ff_scope` and `ck_ff_scope_cols` CHECKs.
2. Three partial unique indexes: `uq_ff_global` (`flag_key` WHERE global), `uq_ff_tenant`
   (`flag_key, tenant_id` WHERE tenant), `uq_ff_account` (`flag_key, tenant_id, account_id`
   WHERE account). Partial indexes are required because plain UNIQUE treats NULLs as distinct.
3. `idx_ff_tenant ON (tenant_id) WHERE scope_type IN ('tenant','account')` — the hot per-tenant snapshot read.
4. `CREATE TRIGGER set_feature_flag_overrides_updated_at BEFORE UPDATE … EXECUTE FUNCTION update_updated_at();`
   (the shared trigger fn used by 045 etc.).
5. **Backfill (before the drop)** — copy non-NULL `tenant_settings` prewarm overrides into
   `feature_flag_overrides` as tenant-scoped rows. Two `INSERT … SELECT` statements (one per
   field), each guarded `WHERE <col> IS NOT NULL`, value cast via `to_jsonb(<col>)`,
   `created_by='migration_046'`, conflict-safe (`ON CONFLICT DO NOTHING` against the partial
   unique index — but note `ON CONFLICT` needs the index inferred; use the explicit
   `ON CONFLICT (flag_key, tenant_id) WHERE scope_type='tenant' DO NOTHING`):
   ```sql
   INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value, reason, created_by)
   SELECT 'prewarm_enabled', 'tenant', tenant_id, to_jsonb(prewarm_enabled), 'migrated from tenant_settings (046)', 'migration_046'
   FROM tenant_settings WHERE prewarm_enabled IS NOT NULL
   ON CONFLICT (flag_key, tenant_id) WHERE scope_type='tenant' DO NOTHING;

   INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value, reason, created_by)
   SELECT 'prewarm_ring_delay_ms', 'tenant', tenant_id, to_jsonb(prewarm_ring_delay_ms), 'migrated from tenant_settings (046)', 'migration_046'
   FROM tenant_settings WHERE prewarm_ring_delay_ms IS NOT NULL
   ON CONFLICT (flag_key, tenant_id) WHERE scope_type='tenant' DO NOTHING;
   ```
6. **`DROP TABLE IF EXISTS tenant_settings;`** — *last*, after the backfill (ordering is a
   correctness requirement, see Risks).
7. Down-migration comments documenting reversal (drop indexes/table; tenant_settings recreate
   is best-effort/non-reversible per project convention — `tenant_settings` data is gone).

**Validate with** `/project:migration-reviewer src/db/migrations/046_feature_flags.sql`
before `npm run migrate:up`.

**Tests first** — `test/integration/repositories/feature-flag.repository.test.ts` (the integration
suite runs against a real PG; this is where SQL-level guarantees are asserted):
- partial unique: a 2nd global row for the same `flag_key` errors; a 2nd tenant row for same
  `(flag_key, tenant_id)` errors; an account row with the same `(flag_key, tenant_id, account_id)` errors;
  but a tenant row and an account row for the same flag/tenant coexist.
- `ck_ff_scope_cols`: inserting `scope_type='global'` with a non-NULL `tenant_id` errors;
  `scope_type='account'` with NULL `account_id` errors.
- backfill: seed `tenant_settings` rows (one with both non-NULL, one all-NULL), run 046,
  assert exactly the non-NULL fields produced override rows with correct JSONB values, and
  `tenant_settings` no longer exists (`to_regclass('tenant_settings') IS NULL`).

> Backfill is hard to unit-test (it's SQL); cover it in the integration migration test. The
> unit-level repository tests (1.3) mock the pool.

---

### 1.2 Registry `src/feature-flags/registry.ts`

**Contents:**
- Types `FlagScope = 'global'|'tenant'|'account'`, `FlagType = 'boolean'|'number'|'string'|'json'`,
  `FlagDefinition<T>` (per spec §4: `key, type, default, description, owner, scopes, envVar?,
  clientExposed?, validate?, rollout?`), plus `KnownFlag = FlagDefinition` union helper.
- `defineFlag<T>(def): FlagDefinition<T>` — `Object.freeze`s the def and registers it in a
  module-level `Map<string, FlagDefinition>` (`FLAG_REGISTRY`). Throws on duplicate key.
- `export const FLAGS = { whatsapp_personal, prewarm_enabled, prewarm_ring_delay_ms } as const;`
  - `whatsapp_personal`: boolean, default `false`, `envVar:'FF_WHATSAPP_PERSONAL'`,
    `scopes:['global','tenant']`, `clientExposed:true`, owner `'messaging'`.
  - `prewarm_enabled`: boolean, default `config.ai.prewarmEnabled`’s *env source* — but registry
    must not import config at module-eval for a circular-free graph; instead set
    `envVar:'AI_PREWARM_ENABLED'` and `default:true` (mirrors `config/schema.ts:478` default),
    `scopes:['tenant']`, `clientExposed:false`, owner `'voice'`.
  - `prewarm_ring_delay_ms`: number, default `3000`, `envVar:'AI_PREWARM_RING_DELAY_MS'`,
    `scopes:['tenant']`, `clientExposed:false`, owner `'voice'`,
    `validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 30000`.
- `getFlag(key): FlagDefinition | undefined`, `allFlags(): FlagDefinition[]` (catalog enumeration),
  `clientExposedFlags(): FlagDefinition[]`.
- **Env default parsing** lives here as `resolveEnvDefault(def): unknown` — boolean uses the
  same semantics as `envBoolean` (`!['false','0','no',''].includes(...)`); number uses
  `Number(raw)` with `Number.isFinite` guard else `default`; string passes through; json
  `JSON.parse` in try/catch. Returns `def.default` when `def.envVar` is unset/blank.

> **Decision: registry must not import `config/index.ts`.** Config validates Telephony/AI/etc.
> and pulls a large graph; importing it from the registry (which the service, routes, AND
> CallManager import) risks a cycle and makes the registry hard to unit-test in isolation.
> The registry reads `process.env[def.envVar]` directly via `resolveEnvDefault`. This is
> consistent with how `config/index.ts` itself reads env. (Open Q1.)

**Tests first** — `test/unit/feature-flags/registry.test.ts`:
- every flag in `FLAGS`: `typeof default` matches `type` (boolean/number/string), and
  `validate?.(default) !== false`.
- keys are unique and equal their `.key` property.
- `defineFlag` throws on a duplicate key registration.
- `resolveEnvDefault`: `FF_WHATSAPP_PERSONAL='true'|'false'|'0'|unset` → `true/false/false/false`;
  `AI_PREWARM_RING_DELAY_MS='5000'` → `5000`, `'abc'` → falls back to `3000`, unset → `3000`.
- `clientExposedFlags()` returns only `whatsapp_personal`; the prewarm flags are excluded.

---

### 1.3 Model + Repository

**`src/db/models/feature-flag.model.ts`:**
```ts
export type FlagScopeType = 'global' | 'tenant' | 'account';
export interface FeatureFlagOverrideRecord {
  id: string; flag_key: string; scope_type: FlagScopeType;
  tenant_id: string | null; account_id: string | null;
  value: unknown;            // JSONB
  reason: string | null; expires_at: Date | null;
  created_by: string | null; updated_by: string | null;
  created_at: Date; updated_at: Date;
}
export interface UpsertFeatureFlagOverrideInput {
  flag_key: string; scope_type: FlagScopeType;
  tenant_id?: string | null; account_id?: string | null;
  value: unknown; reason?: string | null; expires_at?: Date | null; updated_by?: string | null;
}
export interface DeleteFeatureFlagOverrideInput {
  flag_key: string; scope_type: FlagScopeType; tenant_id?: string | null; account_id?: string | null;
}
```

**`src/db/repositories/feature-flag.repository.ts`** (singleton `featureFlagRepository`):
- `upsert(input)` — three separate `INSERT … ON CONFLICT … DO UPDATE` paths keyed by `scope_type`
  (each conflict target matches the matching partial unique index, including its `WHERE`
  predicate, e.g. `ON CONFLICT (flag_key, tenant_id) WHERE scope_type='tenant'`). Sets
  `value = $value::jsonb` (pg serializes the JS value via `JSON.stringify`; cast on the column
  is implicit since column is JSONB — pass `JSON.stringify(value)`), `reason/expires_at/updated_by`,
  `updated_at = NOW()`. Returns the row.
- `findGlobal(): FeatureFlagOverrideRecord[]` — `WHERE scope_type='global'` (the global snapshot).
- `findByTenant(tenantId): FeatureFlagOverrideRecord[]` — `WHERE tenant_id=$1 AND scope_type IN ('tenant','account')`
  (uses `idx_ff_tenant`) — the per-tenant snapshot (tenant + account rows).
- `findByFlag(flagKey): FeatureFlagOverrideRecord[]` — all override rows for one flag (drives the
  per-flag admin GET).
- `delete(input): boolean` — DELETE keyed by the scope tuple, returns `rowCount > 0`.
- `upsertMany(inputs[]): FeatureFlagOverrideRecord[]` — used by the bulk endpoint; loop or
  multi-values insert; keep it simple (loop in a single client/transaction).

> **JSONB write:** pass `JSON.stringify(value)` as the parameter (node-pg sends it as text; the
> JSONB column parses it). Do **not** pass the raw object — node-pg would stringify objects but
> mishandle a bare boolean/number-as-JSON. Verified convention: pass the JSON text. (Open Q2.)

**Tests first** — `test/unit/db/repositories/feature-flag.repository.test.ts` (mock `getPool`,
mirroring `tenant-settings.repository.test.ts`):
- `upsert` global/tenant/account each issue the correct conflict target + params (assert SQL
  contains the right `ON CONFLICT` predicate and `JSON.stringify(value)` is the value param).
- `findByTenant` query restricts to `scope_type IN ('tenant','account')` and `tenant_id=$1`.
- `findGlobal` restricts to `scope_type='global'`.
- `delete` returns false when `rowCount=0`, true otherwise.
- Integration coverage of real JSONB round-trip + partial-unique conflict is in 1.1’s
  integration test.

---

### 1.4 Service `src/feature-flags/feature-flag.service.ts`

A near-clone of `TenantSettingsCache`. **Class `FeatureFlagService`**, singleton-ish but
constructed with `(redis, keyPrefix)` and held by `CallManager` and app context (see 1.5).

**Cache layout** (two keys, both 60s TTL, negative-cached):
- `{keyPrefix}ff:global` → JSON array of global override rows (or `[]`).
- `{keyPrefix}ff:tenant:{tenantId}` → JSON array of that tenant's tenant+account rows (or `[]`).

**Internal state** (cloned from `TenantSettingsCache`): `degradedMode`, `localCache:
Map<string, {value, expiresAt}>` keyed by `'global'` and `tenantId`.

**Private `getGlobalSnapshot()` / `getTenantSnapshot(tenantId)`** — identical read-through shape
to `TenantSettingsCache.getSettings`: Redis GET (skip if degraded) → on miss query
`featureFlagRepository.findGlobal()` / `.findByTenant(tenantId)` → on DB error log warn + return
`[]` (do NOT cache failure) → best-effort SET with TTL, flipping `degradedMode` + local cache on
write failure. **Failure semantics per spec §5:** read fail → fall through to DB (don't flip
degraded); write fail → degraded + local; DB read fail → empty snapshot ⇒ resolution falls to
env/default.

**Resolution** — `private resolveFrom(flag, ctx, global[], tenant[])` builds the precedence:
1. account row (`scope_type='account' && account_id===ctx.accountId`) — only if `'account' ∈ flag.scopes` and `ctx.accountId` present.
2. tenant row (`scope_type='tenant'` in the tenant snapshot).
3. global row (`scope_type='global'` in the global snapshot).
4. `resolveEnvDefault(flag)` (registry).
5. `flag.default`.

Each match also yields a `source ∈ {account,tenant,global,env,default}` for the metric.
**`expires_at`:** a row whose `expires_at` is set and `< now` is treated as absent (lazy expiry)
— skip it during resolution so an expired override reverts to the next layer without a sweep.

**Public API** (all `async`, all best-effort, never throw into the call path — wrap the whole
body so any unexpected error returns the registry default + logs warn):
```ts
isEnabled(flag, ctx): Promise<boolean>        // getValue coerced to boolean
getValue<T>(flag, ctx): Promise<T>            // typed resolved value
resolveAll(ctx): Promise<Record<string, unknown>>   // every flag, one global + one tenant read
resolveClientExposed(ctx): Promise<Record<string, unknown>>  // only clientExposed flags (client surface)
invalidate(opts: { tenantId?: string }): Promise<void>       // del ff:tenant:{id} and/or ff:global
```
`getValue`/`isEnabled`/`resolveAll` all funnel through one `getGlobalSnapshot()` +
`getTenantSnapshot(ctx.tenantId)` (so `resolveAll` is **one Redis round trip per snapshot, two
total**, satisfying the hot-path rule). Emit `featureFlagEvaluationsTotal` per resolved flag (see
1.8). `invalidate` deletes the relevant Redis keys (best-effort, TTL backstop) and clears the
matching local-cache entries.

**`resolvePrewarm(tenantId)` lives here too** as the typed wrapper that replaces
`TenantSettingsCache.resolvePrewarm` (spec §10a step 3):
```ts
async resolvePrewarm(tenantId: string): Promise<ResolvedPrewarm> {
  const all = await this.resolveAll({ tenantId });   // one cache read pair
  return {
    enabled: all[FLAGS.prewarm_enabled.key] as boolean,
    ringDelayMs: all[FLAGS.prewarm_ring_delay_ms.key] as number,
  };
}
```
`ResolvedPrewarm` moves to this module (or a shared types file); the prewarm hot path stays a
single resolve pair.

**Tests first** — `test/unit/feature-flags/feature-flag.service.test.ts` (mock `redis`,
`featureFlagRepository`, `registry` env via `process.env`, metrics; mirror
`test/unit/core/tenant-settings-cache.test.ts`):
- precedence matrix: with account+tenant+global rows present, `getValue` returns account value;
  remove account → tenant; remove tenant → global; remove global → env (set `FF_WHATSAPP_PERSONAL`);
  unset env → registry default. Assert the `source` label each time via the metric mock.
- `'account'` scope ignored for a flag whose `scopes` omit `'account'` (e.g. `whatsapp_personal`).
- cache: 2nd `getValue` for same tenant doesn't re-query the repo (Redis hit); negative cache
  (`[]`) prevents repeated DB hits.
- degraded mode: Redis SET throws → flips degraded, subsequent reads use local cache.
- DB-down: `findByTenant` rejects → resolution returns env/default, no throw, warn logged.
- `expires_at` in the past → row skipped, falls through to next layer.
- `resolveAll` issues exactly one global + one tenant snapshot read for N flags.
- `resolvePrewarm` returns `{enabled, ringDelayMs}` from the two prewarm flags (env-default and
  tenant-override paths).
- `isEnabled` never throws even if the whole body errors (force repo to throw a non-Error) →
  returns `flag.default`.

---

### 1.5 Wiring into CallManager + app context

**`src/core/call-manager.ts`:**
- Replace `import { TenantSettingsCache }` with `import { FeatureFlagService } from
  '../feature-flags/feature-flag.service.js'`.
- Field: `readonly featureFlags: FeatureFlagService;` (drop `readonly tenantSettings`).
- Constructor: `this.featureFlags = new FeatureFlagService(redis, config.redis.keyPrefix);`
- `ringing` handler (line ~480): `const prewarm = await this.featureFlags.resolvePrewarm(session.tenantId);`
  — the surrounding logic (`session.prewarmEnabled`, `prewarmRingDelayMs`, timer) is unchanged.
- Search-and-replace any other `this.tenantSettings.` references (none outside `ringing` + the
  internal route).

**`src/index.ts`:**
- The internal route registration already passes `callManager`; the new flag routes also need the
  service. Pass `callManager` (which now exposes `.featureFlags`) — or expose the service
  directly. Recommend: routes read `callManager.featureFlags` (mirrors how tenant-settings read
  `callManager.tenantSettings`). The client-surface route (`/api/v1/feature-flags`) needs the
  service too — register it with `{ featureFlags: callManager.featureFlags }`.

**Tests first** — extend `test/unit/core/call-manager*.test.ts` if a prewarm-resolution test
exists; otherwise the service-level `resolvePrewarm` test (1.4) plus the route tests cover it. Add
one CallManager test asserting the `ringing` event calls `featureFlags.resolvePrewarm` and stamps
`session.prewarmEnabled/RingDelayMs` (mock the service).

---

### 1.6 S2S admin routes (in `src/api/routes/internal.routes.ts`)

Add the §6 routes alongside the existing S2S routes (same `internalAuthMiddleware` preHandler,
already applied at the top of `internalRoutes`). They read `callManager.featureFlags`.

A shared helper `featureFlagResolveResponse(flagKey, ctx)` mirrors the retired
`tenantSettingsResponse` shape: `{ flag, effective, defaults, overrides }`.

| Route | Handler behaviour |
|---|---|
| `GET /feature-flags` | Catalog: `allFlags()` mapped to `{ key, type, default, scopes, clientExposed, owner, description }` + current `global` override value per flag (from `findGlobal`). |
| `GET /feature-flags/:flagKey` | `getFlag(flagKey)` (404 if unknown) + `findByFlag(flagKey)` rows. |
| `GET /feature-flags/resolve?tenant_id=&account_id=` | For each flag (or one if `flag_key` given): `{ effective: resolveAll(ctx), defaults: env/registry, overrides: applicable rows }`. Drives the "inherited (default: X)" UI. |
| `PUT /feature-flags/:flagKey/overrides` | Validate body (Zod) → **registry validation** (unknown flag ⇒ 404; scope not in `flag.scopes` ⇒ 422; value fails type/`validate` ⇒ 422) → `featureFlagRepository.upsert` → `featureFlags.invalidate({tenantId})` (tenant/account scope) or `invalidate({})`+global key for global scope → `auditLogger.log(...)` → best-effort `trackFeatureFlagChanged(...)` → return resolve response. |
| `DELETE /feature-flags/:flagKey/overrides` | Validate scope tuple → `repository.delete` (404 if nothing deleted) → invalidate → audit → posthog. |
| `POST /feature-flags/:flagKey/overrides/bulk` | Body `{ scope_type:'tenant', tenant_ids: string[], value, reason?, updated_by? }` → registry-validate once → `repository.upsertMany` → invalidate each tenant → one audit row (or per-tenant) → return count. |

**Zod validators** (new `src/api/validators/feature-flags.validator.ts`):
- `upsertOverrideSchema`: `{ scope_type: z.enum(['global','tenant','account']), tenant_id: z.string().min(1).optional(), account_id: z.string().min(1).optional(), value: z.unknown(), reason: z.string().max(500).nullable().optional(), expires_at: z.string().datetime().nullable().optional(), updated_by: z.string().max(100).optional() }`
  with a `.superRefine` enforcing scope/column coherence (tenant required for tenant/account,
  account required+only-for account, both forbidden for global) — mirrors the DB CHECK in TS so
  the 422 is descriptive rather than a raw PG error.
- `deleteOverrideSchema`, `bulkOverrideSchema`, `resolveQuerySchema`.
- **Value type validation** is *not* fully expressible in Zod (the type depends on the flag), so
  it happens in the handler: `validateFlagValue(flag, value)` (a registry helper) checks
  `typeof`/`Number.isInteger`/`flag.validate`. Tests cover the boolean/number/`0..30000` cases.

**Tests first** — `test/unit/api/routes/feature-flags-internal.test.ts` (clone the structure of
`tenant-settings.routes.test.ts`: real `internalAuthMiddleware`, mock repo + service +
auditLogger + posthog):
- S2S auth: 401 without/with wrong Bearer for every route; repo not called.
- `GET /feature-flags` returns the catalog incl. global overrides.
- `PUT` happy path: upsert called with the right scope tuple + JSON value, `invalidate` called,
  `auditLogger.log` called with `eventType:'feature_flag.override.upsert'` + old→new + actor,
  `trackFeatureFlagChanged` called.
- `PUT` unknown flag → 404, no write. Scope not in `flag.scopes` → 422. Value wrong type
  (`whatsapp_personal` ← `"yes"`) → 422. `prewarm_ring_delay_ms` ← `99999` → 422; `← 5000` → ok.
- `PUT` global scope with `tenant_id` present → 422 (superRefine).
- `DELETE` nothing deleted → 404. Happy path invalidates + audits.
- `POST …/bulk` enables for a list of tenants → upsertMany called with N rows, invalidate per tenant.
- `GET …/resolve` returns `{ effective, defaults, overrides }` reflecting precedence.

---

### 1.7 Tenant-facing client surface `GET /api/v1/feature-flags`

**New route file `src/api/routes/feature-flags.routes.ts`** (authenticated — `authMiddleware`
runs globally on `/api/v1/*`; reads `getTenantId(request)` / `getAccountId(request)` from
`auth.middleware.ts:122/127`). Registered in `index.ts`:
`await app.register(featureFlagsRoutes, { prefix: '/api/v1/feature-flags', featureFlags: callManager.featureFlags } as any);`

- `GET /` → `featureFlags.resolveClientExposed({ tenantId, accountId })` → returns
  `{ whatsapp_personal: true, ... }` (only `clientExposed` flags). No enumeration of internal flags,
  no write routes.

**Tests first** — `test/unit/api/routes/feature-flags-client.test.ts`:
- returns only `clientExposed` flags (asserts `prewarm_enabled` / `prewarm_ring_delay_ms` absent).
- resolves per caller tenant/account (mock service returns different values per ctx).
- never exposes a write verb (POST/PUT/DELETE → 404).
- (auth header enforcement is covered by the shared auth-middleware tests; add one 200-with-headers
  smoke case.)

---

### 1.8 Metrics `src/utils/metrics.ts`

Add the dual prom-client + OTel pair (per existing convention):
```ts
export const otelFeatureFlagEvaluationsTotal = meter.createCounter('feature_flag_evaluations_total', {
  description: 'Feature flag evaluations by flag, result, and resolution source',
});
export const featureFlagEvaluationsTotal = new Counter({
  name: 'feature_flag_evaluations_total',
  help: 'Feature flag evaluations by flag, result, and resolution source',
  labelNames: ['flag', 'result', 'source'] as const,   // source ∈ account|tenant|global|env|default
  registers: [registry],
});
```
The service increments both on every resolved flag. `result` = stringified boolean for boolean
flags, else `'value'` (avoid high cardinality on number/string flags). **Cardinality note:** `flag`
is bounded by the registry; `source` is 5 values; `result` is bounded — safe.

**Tests:** asserted indirectly in the service test (mock the counter, assert label args). A small
`metrics` smoke test isn't customary here.

---

### 1.9 PostHog change event `src/analytics/posthog.ts`

Add `trackFeatureFlagChanged(args)` mirroring `trackInboundIntentCreated` (fire-and-forget via the
shared `track`):
```ts
export function trackFeatureFlagChanged(args: {
  tenantId: string; accountId?: string; flagKey: string; scopeType: FlagScopeType;
  action: 'upsert' | 'delete'; oldValue?: unknown; newValue?: unknown; updatedBy?: string;
}): void {
  track('feature_flag_changed', args.tenantId, args.accountId ?? 'default', {
    flag_key: args.flagKey, scope_type: args.scopeType, action: args.action,
    new_value: args.newValue, has_old_value: args.oldValue !== undefined, updated_by: args.updatedBy,
  });
}
```
PII-free (flag key + scope + values are non-PII). Best-effort; never throws (the `track` wrapper
already swallows).

**Tests:** assert the route handler calls it with right args (in 1.6 test, mocked).

---

### 1.10 Gate WhatsApp personal on the flag (spec §9)

**Two gate points, core authoritative:**
1. **Connection-create** — `src/api/routes/messaging-connections.routes.ts:205` (`if (data.provider
   === 'whatsapp_personal')`). After the `config.messaging?.greenapi` config check (which stays as
   the "is the code wired in" switch), add:
   ```ts
   const enabled = await callManager?.featureFlags.isEnabled(FLAGS.whatsapp_personal, { tenantId, accountId })
     ?? false;
   if (!enabled) return reply.code(403).send({ error: 'Feature Not Enabled',
     message: 'WhatsApp Personal is not enabled for this account.' });
   ```
   **Plumbing:** `messagingConnectionsRoutes` is registered with `{ connectionManager }` only — it
   does **not** receive `callManager`. Either (a) pass `callManager` into its opts in `index.ts`
   and read `callManager.featureFlags`, or (b) export a module-level `featureFlagService` singleton
   from a small `src/feature-flags/index.ts` that both CallManager and routes import. **Recommend
   (b)** — a singleton `featureFlagService` (constructed at app boot with redis+keyPrefix, same as
   `auditLogger`/repositories), so any route can `import { featureFlagService }` without threading
   it through every `register`. CallManager then takes the singleton too. (Open Q3 — confirm
   redis is available at module-eval; if not, init it in `index.ts` like `initS3Client`.)
2. **Dispatch** — `src/messaging/dispatch.ts` GREEN-API path (`dispatchGreenApiMessagesInBackground`
   or equivalent around line 460–514). Before sending, gate on the same `isEnabled` check; on
   false, fail the batch's messages with a clear `error_code='FEATURE_DISABLED'` (so a connection
   created while enabled, then disabled, stops dispatching). Use the singleton from (b).

**Tests first:**
- `test/unit/api/routes/messaging-connections-ff-gate.test.ts` (or extend the existing
  whatsapp-personal lifecycle test): provider `whatsapp_personal` + flag disabled → 403, no
  provision call; flag enabled → proceeds to provision.
- dispatch gate test: flag disabled → messages marked failed `FEATURE_DISABLED`, no GREEN-API send.

---

### 1.11 FULL retirement of `/internal/tenant-settings` (spec §10a / §10b finding 1)

Zero external blast radius (audit confirmed nothing consumes it). Do this in the **same PR** as the
new system so `main` is never in a half-migrated state.

Delete / edit:
- `src/api/routes/internal.routes.ts`: remove `upsertTenantSettingsSchema`, `tenantSettingsResponse`,
  `invalidTenantId` (if only used by tenant-settings — verify), the `GET`/`PUT
  /tenant-settings/:tenantId` handlers, and the `tenantSettingsRepository` + `TenantSettingsRecord`
  imports.
- Delete `src/db/repositories/tenant-settings.repository.ts`,
  `src/db/models/tenant-settings.model.ts`, `src/core/tenant-settings-cache.ts`.
- Delete their tests: `test/unit/api/routes/tenant-settings.routes.test.ts`,
  `test/unit/core/tenant-settings-cache.test.ts`,
  `test/unit/db/repositories/tenant-settings.repository.test.ts`,
  `test/integration/repositories/tenant-settings.repository.test.ts`,
  `test/integration/api/tenant-settings.routes.test.ts`.
- `src/core/call-manager.ts`: drop `tenantSettings` field + import (done in 1.5).
- Grep the whole repo for `tenantSettings`, `TenantSettingsCache`, `tenant-settings`,
  `tenant_settings` and confirm nothing else references them (CLAUDE.md mentions are docs, update
  separately). The `tenant_settings` *table* is dropped by migration 046 (1.1).
- **Order:** code retirement + migration ship together; the migration’s backfill reads
  `tenant_settings` *before* dropping it, so the table must still exist at migrate-time. Code that
  no longer references the table is fine to deploy alongside.

**Tests:** the deletions above; `npm run lint` (`tsc --noEmit`) must pass with no dangling refs;
`npm test` green.

---

## Part 2 — MASTER plan (`/Users/manasnilorout/Personal/Sapionic/magick-master`)

> Confirmed against the repo by a read-only audit (see the cross-service exploration). Lane A
> (super-admin write) + Lane B (tenant read).

### Lane A — super-admin management (write path)

**Files to EDIT:**
- `src/proxy/core-client.ts` — `coreInternalRequest()` is **GET-only**. Add a write-capable
  variant (or extend it to accept `{ method, body }`), reusing the `${coreService.url}/internal${path}`
  builder, `Authorization: Bearer ${CORE_S2S_TOKEN}`, trace-context injection, and proxy
  span/metrics. Match the direct-`fetch` write shape already used by `createCoreApiKey` /
  `revokeCoreApiKey`. Return `{ status, body }` so the route can pass it through.
- `src/index.ts` — register `superAdminFeatureFlagsRoutes` under the existing
  `if (config.superAdmin)` block with prefix `/super-admin`.

**Files to ADD:**
- `src/api/routes/super-admin-feature-flags.routes.ts` — modeled **exactly** on
  `super-admin-usage.routes.ts`: `superAdminMiddleware` preHandler, Zod-validate body/query, call
  the (new write-capable) core client, `superAdminAuditRepository.log(...)` locally,
  `reply.code(result.status).send(result.body)`, 502 on core failure. Routes mirror core §6:
  - `GET /super-admin/feature-flags` (catalog)
  - `GET /super-admin/feature-flags/:flagKey`
  - `GET /super-admin/feature-flags/resolve?tenant_id=&account_id=`
  - `PUT /super-admin/feature-flags/:flagKey/overrides`
  - `DELETE /super-admin/feature-flags/:flagKey/overrides`
  - `POST /super-admin/feature-flags/:flagKey/overrides/bulk`
- `src/api/validators/feature-flags.validator.ts` (or matching the repo's validator-file naming) —
  Zod schemas for the override body/query.

**Audit threading:** thread `request.superAdmin!.id` (and/or `.email`) as core's `updated_by` in the
PUT/DELETE/bulk body. Double-audited: master's `super_admin_audit_log` (local) **and** core's
`audit_logs` (§7). Super-admin is all-or-nothing (no intra-admin RBAC).

**Master tests:** mirror `super-admin-usage` route tests — superAdminMiddleware 401, Zod 400, core
client called with right method/path/body, local audit emitted, 502 on core failure.

### Lane B — tenant-facing read (gate path)

**Files to ADD:**
- A `/proxy/feature-flags` route (in the proxy routes module that registers `/proxy/*` per-domain)
  calling `proxyToCore({ path: '/feature-flags', ... })` — per-tenant `X-API-Key` + `x-mgkvc-*`
  (NOT the S2S token). Small net-new route (the proxy lane is explicit-per-domain, no catch-all).

> Exact file paths for the proxy route module, the validator-naming convention, the
> `coreInternalRequest`/`proxyToCore`/`superAdminAuditRepository.log` signatures, and the
> `index.ts` registration lines are filled in from the master exploration results (see
> **Cross-service findings** appendix below — to be merged before coding).

---

## Part 3 — CUSUI plan (`/Users/manasnilorout/Personal/Sapionic/magick-comms-cusui`)

### Lane A — super-admin Feature Flags section
**Files to ADD/EDIT:**
- `src/types/super-admin.ts` (EDIT) — add flag catalog / override / resolve response types.
- `src/api/super-admin.ts` (EDIT) — add methods via the existing `saFetch` wrapper:
  `getFeatureFlags()`, `getFeatureFlag(key)`, `resolveFeatureFlags(tenantId, accountId?)`,
  `putFeatureFlagOverride(key, body)`, `deleteFeatureFlagOverride(key, body)`,
  `bulkFeatureFlagOverride(key, body)`.
- `src/pages/super-admin/SATenantDetailPage.tsx` (EDIT) — add a **"Feature Flags"** section
  alongside the existing "Service Configuration" / "Account Concurrency" sections, rendering the
  tri-state (enabled / inherited (default: X)) the same way Account Concurrency does, driven by the
  §6 `resolve` response (`{ effective, defaults, overrides }`). This is the prewarm management
  surface that was never built (folded-in prewarm flags surface here too).

### Lane B — tenant-facing gate
**Files to ADD/EDIT:**
- `src/config.ts` (EDIT) — add `featureFlags: \`${API_BASE}/proxy/feature-flags\`` endpoint.
- `src/api/feature-flags.ts` (ADD) — mirror `src/api/metadata.ts` (same fetch wrapper, endpoint
  ref).
- `src/types/feature-flags.ts` (ADD) — the client flag-map type.
- `src/contexts/FeatureFlagsContext.tsx` (ADD) + `useFeatureFlags()` — mirror `MetadataContext`,
  mounted in `src/App.tsx` inside `TenantProvider`. **Avoid the name `useFeatureFlag`** (already
  taken by the unused PostHog hook `src/hooks/useFeatureFlag.ts`). Loads flags once per
  tenant/account; components read synchronously.
- **Gate points (EDIT):**
  - `src/pages/messaging/ConnectionsPage.tsx:736-748` — wrap the WhatsApp-Personal provider card on
    `flags.whatsapp_personal`.
  - `src/components/common/ProviderSegmentedControl.tsx` — wrap the "WA Personal" pill on the same flag.

> Coordinate the visual/UX of the super-admin section and the tri-state control with the UX
> designer's spec — this plan names integration points only, not pixels. Exact line numbers /
> `saFetch` signature / `MetadataContext` shape / `config.ts` endpoint convention come from the
> cusui exploration (appendix).

---

## Part 4 — Phasing & sequencing

**Dependency edges:** Core §1.1–1.11 is the foundation; Master Lane A/B depend on core's
`/internal/feature-flags/*` and `/api/v1/feature-flags` existing (contract). cusui Lane A depends
on Master Lane A; cusui Lane B depends on Master Lane B.

**Phase 0 (parallel-safe, no deps):** write the failing tests for core 1.1–1.10 (TDD red).

**Phase 1 — Core (single PR, branch `claude/feature-flagging-tenant-rollout-m3s037`):**
1.2 registry → 1.3 model+repo → 1.1 migration → 1.4 service → 1.5 CallManager wiring →
1.6 admin routes + 1.9 posthog + 1.8 metrics → 1.7 client surface → 1.10 gate WhatsApp →
1.11 retire tenant-settings. Ships green (`npm run lint` + `npm test`), migration reviewed.
PR title (conventional commit, minor bump): `feat: generic feature-flag subsystem (per-tenant rollout)`.

**Phase 2 — Master (branch `feat/feature-flags`):** Lane A (write-capable core client +
super-admin routes) and Lane B (`/proxy/feature-flags`) can be **done in parallel** once core's
contract is merged/agreed. PR title: `feat: feature-flags super-admin + tenant proxy lanes`.

**Phase 3 — cusui (branch `feat/feature-flags`):** Lane B (context + gating) and Lane A
(super-admin section) in parallel once Master's routes exist. PR title:
`feat: feature-flags context + super-admin management UI`.

**What parallelizes:** core's three test files (registry/repo/service) can be written
concurrently; within Master, Lane A and Lane B; within cusui, Lane A and Lane B. Cross-repo,
Phases 2 and 3 can start as soon as the Phase-1 *contract* (route shapes) is frozen, even before
core merges — but should integrate against merged core.

**Coordinate the whole cross-service rollout with `/project:cross-service-feature` and run
`/project:typecheck-all` after each phase.**

---

## Part 5 — Risks & gotchas

1. **Retirement ordering — backfill before drop.** Migration 046 MUST run the `INSERT … SELECT`
   backfill from `tenant_settings` *before* `DROP TABLE tenant_settings`, and the code retirement
   (1.11) must not break the migration’s ability to read the table at migrate-time. The drop is the
   last statement. Get this wrong and prewarm overrides are silently lost.
2. **JSONB typing/validation.** `value` is `unknown` JSONB. (a) Write path: pass
   `JSON.stringify(value)` as the pg param so a bare boolean/number is stored as valid JSON, not as
   a Postgres literal. (b) Read path: node-pg returns JSONB already parsed — `value` is the JS
   value, no `JSON.parse`. (c) Type fidelity is enforced in the registry validator
   (`validateFlagValue`), not the DB; the DB CHECK only guards scope/column shape. A number flag
   written as `"5000"` (string) must be rejected at the route, not silently coerced.
3. **Negative-cache correctness.** Caching `[]` for "no overrides" is essential (the common case)
   but the cached snapshot is the *whole tenant set*, so an upsert/delete for that tenant MUST
   `invalidate({tenantId})`, and a *global* upsert MUST invalidate `ff:global`. Missing an
   invalidation = up to 60s stale (bounded, but a kill-switch wants it instant). Test every write
   path invalidates the right key.
4. **Prewarm hot-path stays one cache read pair.** `resolvePrewarm` must call `resolveAll` once
   (one global + one tenant snapshot read), not `getValue` per flag (which would double the reads).
   Regression risk if someone "simplifies" it later. Assert the read count in a test.
5. **ESM `.js` imports + `noUncheckedIndexedAccess`.** All new imports use `.js`. Registry `Map.get`
   and `resolveAll` record access return `T | undefined` — handle explicitly (the prewarm wrapper
   casts after asserting presence; better: have `resolveAll` always populate every registered flag
   so the keys exist).
6. **Registry ↔ config circular import.** The registry reads `process.env` directly (not
   `config/index.ts`) to avoid a cycle (registry is imported by service, routes, CallManager).
   Keep it dependency-light. (Open Q1.)
7. **`messagingConnectionsRoutes` has no `callManager`.** The WhatsApp gate needs the flag service;
   prefer a module-level `featureFlagService` singleton (Open Q3) over threading `callManager`
   through every route registration.
8. **`ALTER TYPE … ADD VALUE` not in play here** (046 adds no enum) — but the migration is still
   whole-file/one-transaction under node-pg-migrate; the `DROP TABLE` + backfill all run in that
   one transaction, which is what we want (atomic backfill-then-drop).
9. **`expires_at` lazy expiry** means an expired override sits in the cached snapshot until TTL;
   resolution skips it, so behaviour is correct, but the admin `overrides` listing should mark
   expired rows (don't present a dead override as live). Cosmetic, not correctness.
10. **Bulk endpoint cardinality** — `overrides/bulk` over many tenants issues many invalidations;
    keep it a bounded list (cap like the `migrateAccountIds` `max(1000)` precedent).

---

## Part 6 — Open technical questions

- **Q1 — Registry env source.** Confirm the registry should read `process.env[envVar]` directly
  (proposed) rather than importing `config`. Alternative: a tiny `feature-flags/env.ts` that the
  registry uses. Either avoids the cycle; pick one.
- **Q2 — JSONB param convention. RESOLVED.** Confirmed `JSON.stringify(value)` is the repo-wide
  convention (`call.repository.ts:82/85` prompt_variables, `static-call.repository.ts:40`,
  `audit.repository.ts:25`, `greenapi-message.repository.ts:93`). The feature-flag repository
  passes `JSON.stringify(value)` for the JSONB `value` param. (Bare boolean/number stringify to
  valid JSON, so this is safe for non-object flag values too.)
- **Q3 — Flag service injection.** Module-level singleton (`import { featureFlagService }`) vs.
  threading through `register` opts. Singleton is cleaner for the messaging gate but needs redis at
  init — confirm an init point in `index.ts` (like `initS3Client`/`auditLogger.start()`).
- **Q4 — Bulk audit granularity.** One audit row for a bulk enable, or one per tenant? Per-tenant
  is more faithful but noisier. Recommend one summary row + the tenant list in `eventData`.
- **Q5 — Client surface account scoping.** `whatsapp_personal` is `scopes:['global','tenant']`
  (no account). The client route resolves with `{tenantId, accountId}` anyway — fine. Confirm no
  client-exposed flag will ever need account scope without the client passing account (cusui's
  tenant app does send `x-mgkvc-account`, so OK).
- **Q6 — Should `MESSAGING_ENABLED_PROVIDERS` still list `whatsapp_personal` in prod?** Spec says
  the env stays as the "code wired in" switch and the flag governs per-tenant. Confirm prod keeps
  the provider in `MESSAGING_ENABLED_PROVIDERS` (module present) with the flag default-off.

---

## Appendix — Cross-service integration anchors (verified 2026-06-23)

Verified directly against both sibling repos. Every path/line/signature below is real on disk
today. **UX for the super-admin section and the tenant gate is owned by Iris's
`docs/superpowers/plans/feature-flags-ux-design.md` — this appendix names the integration
points and contracts only; cite that spec for visuals (§ references inline).**

### A. MASTER (`/Users/manasnilorout/Personal/Sapionic/magick-master`) — branch `feat/feature-flags`

#### A1. `src/proxy/core-client.ts` — make `coreInternalRequest` write-capable (EDIT)

Today `coreInternalRequest(req: CoreInternalRequestOptions)` (line 91) is **GET-only**: its
`CoreInternalRequestOptions` (lines 77–85) has **no `method`/`body`**, and the fetch hard-codes
`method: 'GET'` with metrics labelled `'GET'` (lines 112–142). Two valid approaches:

- **Preferred — extend in place.** Add `method?: 'GET'|'POST'|'PUT'|'DELETE'` (default `'GET'`) and
  `body?: unknown` to `CoreInternalRequestOptions`; thread `req.method ?? 'GET'` through the fetch
  `method`, the metrics labels (`proxyRequestsTotal`/`otelProxyRequestsTotal`/duration — currently
  literal `'GET'`), and serialize `body` as `JSON.stringify(req.body)` with
  `'content-type':'application/json'` when present (mirror `createCoreApiKey` at lines 37–53, which
  shows the S2S write shape: `method:'POST'`, Bearer `CORE_S2S_TOKEN`, JSON body). Keep the URL
  builder `${config.coreService.url}/internal${req.path}${queryString}`, the Bearer header, the
  trace-context injection (`propagation`), and the `{ status, body, headers }` return shape.
- *Alternative* — a sibling `coreInternalWrite()` helper if keeping `coreInternalRequest` GET-only is
  preferred for blast-radius. The extend-in-place option is cleaner and `super-admin-usage.routes.ts`
  callers pass no `method`, so the `?? 'GET'` default is back-compatible.

#### A2. `src/api/routes/super-admin-feature-flags.routes.ts` (NEW)

Model **exactly** on `src/api/routes/super-admin-usage.routes.ts` (the canonical SA→core `/internal/*`
proxy). That file's proven shape:
- `app.addHook('preHandler', superAdminMiddleware)` (from `../../auth/super-admin.middleware.js`).
- Per route: Zod `.safeParse` → 400 on failure; optional `tenantRepository.findById` → 404; then
  `await coreInternalRequest({ method, path, query?, body? })`; `superAdminAuditRepository.log({...}).catch(()=>{})`;
  `reply.code(result.status).send(result.body)`; wrap the core call in try/catch → **502** on failure.
- **Audit signature (real):** `superAdminAuditRepository.log({ admin_id: request.superAdmin!.id,
  admin_email: request.superAdmin!.email, action, resource_type:'tenant', resource_id, details })`.
  `request.superAdmin` is `{ sub, email, ... }` attached by `super-admin.middleware.ts:54`
  (`.id`/`.email` are on the loaded admin record).
- **Audit actor → core:** thread `request.superAdmin!.id` (and/or `.email`) into the request body as
  core's `updated_by` on PUT/DELETE/bulk (core stamps it on `audit_logs` + the override row). Result:
  **double audit** — master's `super_admin_audit_log` (action e.g. `feature_flag.override.upserted`)
  **and** core's `audit_logs`. Super-admin is all-or-nothing (no intra-admin RBAC).

Routes (mirror core §6, all under the `/super-admin` prefix from A4):
| master route | → core call |
|---|---|
| `GET /super-admin/feature-flags` | `coreInternalRequest({ method:'GET', path:'/feature-flags' })` |
| `GET /super-admin/feature-flags/:flagKey` | `…path:`/feature-flags/${flagKey}`` |
| `GET /super-admin/feature-flags/resolve?tenant_id=&account_id=` | `…path:'/feature-flags/resolve', query` |
| `PUT /super-admin/feature-flags/:flagKey/overrides` | `method:'PUT', body:{…, updated_by: request.superAdmin!.id}` |
| `DELETE /super-admin/feature-flags/:flagKey/overrides` | `method:'DELETE', body` |
| `POST /super-admin/feature-flags/:flagKey/overrides/bulk` | `method:'POST', body` |

UX driver: the `resolve` response (`{ effective, defaults, overrides }`) feeds the tri-state control —
Iris §1.4 (tri-state), §1.2 (scope selector), §1.6 (bulk), §1.7 (confirmation copy).

#### A3. `src/api/validators/super-admin-feature-flags.validator.ts` (NEW)

Convention: validators live in `src/api/validators/` named `super-admin-*.validator.ts` (e.g.
`super-admin-usage.validator.ts`). Add Zod schemas for the override upsert/delete/bulk bodies +
resolve query — same field shape as core's `feature-flags.validator.ts` (so master rejects early and
core re-validates authoritatively). master need not embed the per-flag value-type check (core owns it,
returns 422 → pass through).

#### A4. `src/index.ts` registration (EDIT)

- **SA lane:** inside the existing `if (config.superAdmin) { … }` block (lines 281–286, where
  `superAdminRoutes`/`superAdminPhoneRoutes`/`superAdminUsageRoutes` register at prefix
  `/super-admin`), add `await app.register(superAdminFeatureFlagsRoutes, { prefix: '/super-admin' });`.
  Add the import beside line 48.
- **Tenant lane (Lane B):** in the `/proxy/*` block (lines 250–262), add
  `await app.register(proxyFeatureFlagsRoutes, { prefix: '/proxy/feature-flags' });`.

#### A5. `src/api/routes/proxy-feature-flags.routes.ts` (NEW) — Lane B tenant read

Model on `src/api/routes/proxy-metadata.routes.ts` (the cleanest small proxy precedent):
- `app.addHook('preHandler', sessionMiddleware)` + `app.addHook('preHandler', tenantContextMiddleware)`.
- `app.get('/', { preHandler:[requirePermission('proxy.stats.read')] }, …)` (reuse an existing
  read permission; confirm the right scope with the team — `proxy.stats.read` is what metadata uses).
- Body: `const coreApiKey = await resolveCoreApiKey(tenantId)` (from `../../proxy/proxy.utils.js`);
  `const result = await proxyToCore({ method:'GET', path:'/feature-flags', coreApiKey, tenantId, accountId })`;
  `reply.code(result.status).send(result.body)`. **Tenant credential (`X-API-Key` via `coreApiKey`),
  NOT the S2S token** — `proxyToCore` (core-client.ts:154) handles the per-tenant header set.
- Optional: a short Redis cache like metadata's 30-min TTL is **not** recommended for flags (rollout
  changes must propagate fast; core's own 60s cache is the backstop). Skip caching here.

### B. CUSUI (`/Users/manasnilorout/Personal/Sapionic/magick-comms-cusui`) — branch `feat/feature-flags`

#### B1. Tenant-facing read (Lane B)
- **`src/config.ts` (EDIT):** add a `featureFlags: \`${API_BASE}/proxy/feature-flags\`` endpoint.
  Endpoints are a flat/grouped `ENDPOINTS` object (`metadata`, a `proxy: { calls: {…} }` group at
  lines 46+). Add `featureFlags` at top level next to `metadata` (it's its own standalone endpoint).
- **`src/api/feature-flags.ts` (NEW):** mirror `src/api/metadata.ts` verbatim —
  `import { ENDPOINTS } from '../config'; import { apiFetch } from './client';`
  `export function fetchFeatureFlags(tenantId: string): Promise<FeatureFlagMap> { return apiFetch(ENDPOINTS.featureFlags, {}, tenantId); }`
  (`apiFetch(url, opts, tenantId)` is the tenant-scoped fetch wrapper metadata uses).
- **`src/types/feature-flags.ts` (NEW):** `export type FeatureFlagMap = Record<string, boolean>;`
  (the core client surface returns `{ whatsapp_personal: true, … }`).
- **`src/contexts/FeatureFlagsContext.tsx` (NEW) + `useFeatureFlags()`:** mirror
  `src/contexts/MetadataContext.tsx`. **Name it `useFeatureFlags` (plural) — `useFeatureFlag`
  (singular) is already taken** by the unused PostHog hook (`src/hooks/useFeatureFlag.ts:11`,
  `export function useFeatureFlag(flag: string): boolean`). Loads flags once per tenant/account; lets
  components read synchronously.
- **`src/App.tsx` (EDIT):** mount `<FeatureFlagsProvider>` inside `<TenantProvider>` (line 68),
  alongside/just inside `<MetadataProvider>` (lines 69 & 154). UX requires the provider gate the
  first render to avoid a flash of the WA-Personal card — **Iris §2.1 (anti-flicker) + §2.2
  (loading state)**.
- **Gate points (EDIT):**
  - `src/pages/messaging/ConnectionsPage.tsx` — the WhatsApp-Personal provider card (the
    `onClick={() => handleSelectProvider('whatsapp_personal')}` block, **lines 736–748** as
    previously identified; verify exact lines at edit time) — wrap on `flags.whatsapp_personal`.
  - `src/components/common/ProviderSegmentedControl.tsx` — the "WA Personal" pill
    (`providers.includes('whatsapp_personal')` at **line 46**, label at **line 52**) — wrap on the
    same flag. UX: hide cleanly, no disabled/ghost state — **Iris §2.3**.

#### B2. Super-admin management (Lane A)
- **`src/api/super-admin.ts` (EDIT):** add methods via the existing `saFetch<T>(url, options)` wrapper
  (line 31; `saFetchRaw` at 74 for raw responses) — auth header + 401-redirect + error parsing already
  handled. Pattern to copy (e.g. `getTenantDetail` line 143: `saFetch(\`${SA_BASE}/tenants/${id}\`)`):
  `getFeatureFlags()`, `getFeatureFlag(key)`, `resolveFeatureFlags(tenantId, accountId?)`,
  `putFeatureFlagOverride(key, body)`, `deleteFeatureFlagOverride(key, body)`,
  `bulkFeatureFlagOverride(key, body)` — all under `SA_BASE`/`feature-flags`.
- **`src/types/super-admin.ts` (EDIT):** add flag-catalog / override-row / resolve-response types
  (mirror core's response shapes).
- **`src/pages/super-admin/SATenantDetailPage.tsx` (EDIT):** add a **"Feature Flags"** `section` after
  the **Account Concurrency** block (the page renders Credits at line 305, Phone Numbers 330, Service
  Configuration 384, then `{/* Account Concurrency */}` at **line 414**) — insert the new
  `<div className={styles.section}>` immediately after the Account Concurrency section, matching the
  existing `sectionHeader`/`<h2>` pattern. Drive it from the `resolve` response. **Full visual spec is
  Iris's `feature-flags-ux-design.md` §1 (placement §1.1, scope selector §1.2, flag-row §1.3,
  tri-state §1.4, non-boolean editors §1.5, bulk §1.6, confirm §1.7, empty/loading/error §1.8, reused
  components §1.9, tokens §3, a11y + microcopy §4) — implement to that, don't re-design.**

### C. Phase order recap (cross-repo)
Core (Phase 1, done) freezes the contract → **master Lane A + Lane B can build in parallel** (Phase 2)
→ **cusui Lane A (needs master SA routes) + Lane B (needs `/proxy/feature-flags`) in parallel**
(Phase 3). Run `/project:typecheck-all` after each repo. Branch `feat/feature-flags` in both siblings.
