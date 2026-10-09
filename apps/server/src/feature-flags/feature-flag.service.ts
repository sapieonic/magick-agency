import type Redis from 'ioredis';
import { logger } from '@magick-agency/observability';
import { featureFlagRepository } from '@magick-agency/db/repositories/feature-flag.repository';
import type { FeatureFlagOverrideRecord } from '@magick-agency/db/models/feature-flag.model';
import {
  allFlags,
  clientExposedFlags,
  resolveEnvDefault,
  type FlagDefinition,
} from './registry.js';
import { featureFlagEvaluationsTotal } from '@magick-agency/observability/metrics/shared';

/*
 * PORT NOTE (magick-agency): ported from core `src/feature-flags/feature-flag.service.ts`
 * (v1.123.2). REMOVED, as AI-only resolution paths: `resolvePrewarm` and
 * `resolveCallerActivity`, their result types `ResolvedPrewarm` /
 * `ResolvedCallerActivity`, and the helpers only they used (`layerOf`,
 * `exactBoolean`, `boundedNumber`, `RejectedValueContext`,
 * `warnRejectedFlagValue`, `previewValue`). Everything else — `getValue`,
 * `isEnabled`, `snapshot`, `resolveAll`, `resolveClientExposed`,
 * `resolveAllWithSource`, `invalidate`, the Redis read-through cache, degraded
 * mode and its probe, the corrupt-cache guard, and the fail-safe arms (a failed
 * snapshot read resolves the REGISTRY default) — is verbatim. Doc comments below
 * that mention the two removed resolvers or AI flags are core's and describe
 * core's callers.
 */

const CACHE_TTL_SECONDS = 60;

/**
 * How long a replica stays out of Redis after a WRITE failure before it is
 * allowed ONE probe to see whether Redis came back (see
 * {@link FeatureFlagService.claimRedisAttempt}).
 *
 * 30s = half `CACHE_TTL_SECONDS`, and both halves of that ratio are the reason
 * for the number. Below: a degraded replica serves flags from a per-replica
 * local cache, so a healed replica must rejoin the SHARED cache well within the
 * lifetime of the stale entries it wrote while degraded — otherwise recovery
 * lands after the staleness it was meant to end. Above: during a genuine Redis
 * outage this costs ONE request per replica per window (two per minute), which
 * is negligible next to re-attempting on every read, and the claim is taken
 * before the probe's first `await`, so a burst cannot turn one window into a
 * stampede.
 */
const DEGRADED_PROBE_COOLDOWN_SECONDS = 30;

/** Where a resolved value came from (drives the `source` metric label). */
export type ResolutionSource = 'account' | 'tenant' | 'global' | 'env' | 'default' | 'rollout';

export interface FlagContext {
  tenantId: string;
  accountId?: string;
}

/**
 * A point-in-time reader over ONE already-read global+tenant snapshot pair.
 *
 * Handed out by {@link FeatureFlagService.snapshot}. Both methods are
 * synchronous: the Redis/DB round trips happened once, when the snapshot was
 * taken, so a caller gating on five flags pays one round-trip pair rather than
 * five.
 */
export interface FlagSnapshot {
  /** Resolve a boolean flag from the already-read snapshot pair. Throws for a non-boolean flag (same as isEnabled). */
  isEnabled(flag: FlagDefinition): boolean;
  /** Resolve a typed flag's value from the already-read snapshot pair. */
  getValue<T>(flag: FlagDefinition<T>): T;
}

/**
 * A LAZY, memoised source of a {@link FlagSnapshot}, for a caller that wants to
 * share one snapshot pair across several checks WITHOUT paying for it when none
 * of them reaches a flag read.
 *
 * This exists because the eager alternative regresses the common case. The
 * call-initiation preflights each read a flag only on *some* of their internal
 * paths — the escalation stage, which is relevant to nearly every request,
 * returns before its flag read whenever the prompt has no escalation destination
 * and the request carried no escalation number. So an ordinary single call used
 * to do ZERO flag reads, and awaiting a snapshot up front would newly charge it
 * a Redis GET pair on the synchronous request path.
 *
 * Contract for implementers: the provider must be memoised on the PROMISE (not
 * the resolved value) so concurrent callers share one underlying `snapshot()`
 * call, and it must resolve `undefined` rather than reject when the snapshot
 * cannot be taken — a consumer then falls back to its own read, which is the
 * pre-existing behaviour.
 */
export type FlagSnapshotProvider = () => Promise<FlagSnapshot | undefined>;

/**
 * Outcome of a snapshot-pair read that reports FAILURE distinctly from an empty
 * result. `{ ok: true, global: [], tenant: [] }` is a tenant with no overrides
 * (resolve normally, reaching the env default); `{ ok: false }` is an infra
 * failure (resolve the registry default). Collapsing the two — as
 * `getSnapshotsAllOrNothing`'s `[[], []]` necessarily does — would let an
 * outage resolve a gated flag through its env var. See {@link FeatureFlagService.snapshot}.
 */
type SnapshotPairResult =
  | { ok: true; global: FeatureFlagOverrideRecord[]; tenant: FeatureFlagOverrideRecord[] }
  | { ok: false };

interface CacheEntry {
  value: FeatureFlagOverrideRecord[];
  expiresAt: number;
}

/**
 * Read-through cache + resolver for feature flags. Cloned from the (now retired)
 * tenant-settings cache shape: Redis read-through (60s TTL, shared across
 * replicas) → DB → registry default. Falls back to a per-replica local cache
 * when Redis writes fail (degraded mode) and probes its way back out again once
 * per `DEGRADED_PROBE_COOLDOWN_SECONDS` — it is a cooldown, never a latch; see
 * {@link FeatureFlagService.claimRedisAttempt}. The "no overrides" case caches
 * an empty array (negative cache) so the overwhelmingly common path never
 * re-hits the DB. A DB error is **never** cached (per the existing policy).
 *
 * Two snapshots resolve every flag for a request: the global override set
 * (`ff:global`) and the per-tenant set (`ff:tenant:{tenantId}`, holding the
 * tenant + account rows). `resolveAll` reads each once, so the call hot path is
 * a single round-trip pair.
 *
 * All public methods are best-effort and never throw into the call path
 * (`isEnabled` is the one exception: it throws when asked to coerce a
 * non-boolean flag — a programming error, not an infra failure).
 */
export class FeatureFlagService {
  private redis: Redis | null;
  private readonly keyPrefix: string;
  private degradedMode = false;
  /**
   * Epoch ms before which no Redis probe may be attempted. Only meaningful
   * while `degradedMode` is set; reset when it clears.
   */
  private nextRedisProbeAt = 0;
  private localCache = new Map<string, CacheEntry>();

  constructor(redis: Redis | null, keyPrefix: string) {
    this.redis = redis;
    this.keyPrefix = keyPrefix;
  }

  /** Resolve a flag's typed value (account → tenant → global → env → default). */
  async getValue<T>(flag: FlagDefinition<T>, ctx: FlagContext): Promise<T> {
    try {
      const [global, tenant] = await Promise.all([
        this.getGlobalSnapshot(),
        this.getTenantSnapshot(ctx.tenantId),
      ]);
      const { value, source } = this.resolveFrom(flag, ctx, global, tenant);
      this.recordEval(flag, value, source);
      return value as T;
    } catch (err) {
      // Total failure ⇒ registry default (off for gated capabilities ⇒ safe).
      logger.warn({ err, flag: flag.key }, 'Feature flag resolution failed, using registry default');
      this.recordEval(flag, flag.default, 'default');
      return flag.default;
    }
  }

  /** Resolve a boolean flag. Throws if the flag is not boolean (use getValue for typed flags). */
  async isEnabled(flag: FlagDefinition, ctx: FlagContext): Promise<boolean> {
    if (flag.type !== 'boolean') {
      throw new Error(`isEnabled called on non-boolean flag '${flag.key}' (type ${flag.type}); use getValue`);
    }
    const v = await this.getValue<boolean>(flag as FlagDefinition<boolean>, ctx);
    return v === true;
  }

  /**
   * Capture ONE global+tenant snapshot pair and return a synchronous reader over
   * it, for a caller that gates on several flags but is not resolving the whole
   * registry.
   *
   * **Why.** `isEnabled`/`getValue` each read a snapshot pair (a Redis GET pair,
   * or a DB pair on a miss). On the call-initiation request path three separate
   * preflights (`preflightSipConnection`, `preflightEscalationTransfer`,
   * `preflightPipelineTier`) each gate independently, so a single request paid up
   * to three round-trip pairs for what is one point-in-time question. `resolveAll`
   * already reads one pair for the whole registry; this is the same economy for an
   * arbitrary, caller-chosen subset:
   *
   * ```ts
   * const flags = await featureFlags.snapshot({ tenantId, accountId });
   * if (flags.isEnabled(FLAGS.custom_sip)) { … }        // no I/O
   * const cap = flags.getValue(FLAGS.max_sip_connections); // no I/O
   * ```
   *
   * **It is a point-in-time view.** The reader resolves from the records captured
   * at `snapshot()` time; a flag flipped mid-request is not observed. That is the
   * intended semantics for one request's gate decisions — the alternative, where
   * two gates in the same request disagree because an operator toggled a flag
   * between them, is strictly worse. (The 60s snapshot cache means the values were
   * already up to a TTL old, so this adds no staleness class that did not exist.)
   *
   * **Failure semantics are byte-identical to {@link getValue}, deliberately.**
   * `getValue`'s catch arm returns `flag.default` — the REGISTRY default,
   * ignoring the env default. `getSnapshotsAllOrNothing` instead degrades to
   * `[[], []]`, which falls through `resolveFrom` to the ENV default (step 4)
   * before the registry default (step 5). Those differ, and the difference is not
   * cosmetic: for a gated capability whose env var is set to "on", a Redis+DB
   * outage would resolve `true` here and `false` through `getValue` — i.e. this
   * path would silently OPEN a gate during an infrastructure outage. So the read
   * below distinguishes "the read FAILED" from "the read returned nothing" (a
   * tenant with no overrides legitimately reads `[[], []]` and must still get
   * env-then-registry resolution), and on failure every resolution returns
   * `flag.default` with source `'default'`, matching `getValue`'s catch arm
   * exactly — including its `recordEval` call, so the
   * `feature_flag_evaluations_total` series is unchanged.
   *
   * There are TWO ways resolution can fail, and both must land on that same arm:
   *
   *  1. **The read failed** (`pair.ok === false`) — handled above.
   *  2. **The resolver threw** — `getValue` wraps the read AND `resolveFrom` /
   *     `recordEval` in one try/catch, so anything thrown while resolving yields
   *     `flag.default`. This is reachable, not theoretical: `getSnapshot`
   *     `JSON.parse`s the cached Redis value with no shape check, so a value that
   *     is valid JSON but not an array (corruption, a stray SET, a key-prefix
   *     collision) makes `resolveFrom`'s `.find(...)` throw a TypeError. Left
   *     unguarded here, that TypeError escapes a synchronous `isEnabled` call and
   *     turns a gate read into a 500 on every request for as long as the bad value
   *     stays cached — where `getValue` degrades to a 403. So `resolve` catches it
   *     and takes the identical arm.
   *
   * A failed READ is logged once per snapshot rather than once per flag read (the
   * resolved values match `getValue` exactly, only the log volume differs); a
   * resolver THROW is logged per read, exactly as `getValue` would.
   */
  async snapshot(ctx: FlagContext): Promise<FlagSnapshot> {
    const pair = await this.readSnapshotPair(ctx.tenantId);

    const resolve = (flag: FlagDefinition): unknown => {
      try {
        if (!pair.ok) {
          // Mirror getValue's catch arm exactly: registry default, source 'default'.
          this.recordEval(flag, flag.default, 'default');
          return flag.default;
        }
        const { value, source } = this.resolveFrom(flag, ctx, pair.global, pair.tenant);
        this.recordEval(flag, value, source);
        return value;
      } catch (err) {
        // Same arm as getValue's catch, for the same reason (see the doc
        // comment's "resolver throw" note): resolution itself can throw on a
        // structurally-bad cached snapshot, and a gate read must degrade to the
        // registry default rather than escape into the caller's request path.
        logger.warn({ err, flag: flag.key }, 'Feature flag resolution failed, using registry default');
        this.recordEval(flag, flag.default, 'default');
        return flag.default;
      }
    };

    return {
      isEnabled: (flag: FlagDefinition): boolean => {
        if (flag.type !== 'boolean') {
          throw new Error(
            `isEnabled called on non-boolean flag '${flag.key}' (type ${flag.type}); use getValue`,
          );
        }
        return resolve(flag) === true;
      },
      getValue: <T,>(flag: FlagDefinition<T>): T => resolve(flag) as T,
    };
  }

  /**
   * Resolve every registered flag for a context using one snapshot read pair.
   *
   * Resolution goes through {@link resolveFromOrDefault}, not `resolveFrom`, for
   * the same reason `getValue` and `snapshot` wrap theirs in a try/catch: this is
   * the multi-flag entry point the `ringing` hot path reaches (via
   * {@link resolvePrewarm} / {@link resolveCallerActivity}), and a throw here
   * escapes into a telephony webhook handler rather than degrading a gate.
   */
  async resolveAll(ctx: FlagContext): Promise<Record<string, unknown>> {
    const [global, tenant] = await this.getSnapshotsAllOrNothing(ctx.tenantId);
    const out: Record<string, unknown> = {};
    for (const flag of allFlags()) {
      out[flag.key] = this.resolveFromOrDefault(flag, ctx, global, tenant).value;
    }
    return out;
  }

  /** Resolve only client-exposed flags (the tenant-facing surface). */
  async resolveClientExposed(ctx: FlagContext): Promise<Record<string, unknown>> {
    const [global, tenant] = await this.getSnapshotsAllOrNothing(ctx.tenantId);
    const out: Record<string, unknown> = {};
    for (const flag of clientExposedFlags()) {
      out[flag.key] = this.resolveFromOrDefault(flag, ctx, global, tenant).value;
    }
    return out;
  }

  /**
   * Resolve every flag AND report which layer each value came from. One snapshot
   * read pair, same as `resolveAll`.
   *
   * Two consumers, for the same reason: the super-admin resolve surface, so the UI
   * can attribute the inherited default precisely ("inherited (default: On — set
   * globally)" vs "… — from env") rather than inferring it; and
   * {@link resolvePrewarm} / {@link resolveCallerActivity}, so that when they
   * DISCARD a value they can say which layer wrote it. Both need the attribution
   * an operator would otherwise have to guess at.
   */
  async resolveAllWithSource(
    ctx: FlagContext,
  ): Promise<Record<string, { value: unknown; source: ResolutionSource }>> {
    const [global, tenant] = await this.getSnapshotsAllOrNothing(ctx.tenantId);
    const out: Record<string, { value: unknown; source: ResolutionSource }> = {};
    for (const flag of allFlags()) {
      out[flag.key] = this.resolveFromOrDefault(flag, ctx, global, tenant);
    }
    return out;
  }

  /** Drop cached snapshots so the next read re-queries the DB. */
  async invalidate(opts: { tenantId?: string }): Promise<void> {
    if (opts.tenantId) {
      this.localCache.delete(this.tenantCacheKey(opts.tenantId));
      await this.delKey(this.tenantRedisKey(opts.tenantId));
    } else {
      this.localCache.delete('global');
      await this.delKey(this.globalRedisKey());
    }
  }

  // --- Resolution ---

  private resolveFrom(
    flag: FlagDefinition,
    ctx: FlagContext,
    global: FeatureFlagOverrideRecord[],
    tenant: FeatureFlagOverrideRecord[],
  ): { value: unknown; source: ResolutionSource } {
    const live = (r: FeatureFlagOverrideRecord): boolean =>
      r.expires_at === null || new Date(r.expires_at).getTime() > Date.now();

    // 1. account
    if (flag.scopes.includes('account') && ctx.accountId) {
      const acc = tenant.find(
        (r) => r.flag_key === flag.key && r.scope_type === 'account' && r.account_id === ctx.accountId && live(r),
      );
      if (acc) return { value: acc.value, source: 'account' };
    }
    // 2. tenant
    const ten = tenant.find((r) => r.flag_key === flag.key && r.scope_type === 'tenant' && live(r));
    if (ten) return { value: ten.value, source: 'tenant' };
    // 3. global
    const glob = global.find((r) => r.flag_key === flag.key && r.scope_type === 'global' && live(r));
    if (glob) return { value: glob.value, source: 'global' };
    // 4. env / 5. registry default
    return this.resolveEnvOrRegistryDefault(flag);
  }

  /**
   * {@link resolveFrom}, guaranteed not to throw — the multi-flag loops'
   * equivalent of `getValue`'s try/catch and `snapshot`'s per-flag catch, and the
   * third of the three places that must take the SAME arm on a resolver throw.
   *
   * Without it, `resolveAll` / `resolveClientExposed` / `resolveAllWithSource`
   * were the only resolve entry points with nothing between `resolveFrom` and
   * their caller. That matters because of who those callers are: `resolvePrewarm`
   * and `resolveCallerActivity` run on the `ringing` telephony webhook, so a
   * TypeError out of `resolveFrom` — reachable from a structurally-bad cached
   * snapshot, see {@link readCachedSnapshot} — became a 500 on every `ringing`
   * for the life of the cached value, on every tenant if the poisoned key was
   * `ff:global`. `getValue` degraded, `snapshot` degraded, these did not.
   *
   * `readCachedSnapshot` is the primary fix and stops the known cause at the
   * parse; this is the containment, and it is not redundant with it. It is what
   * makes the guarantee structural — "no resolve entry point can throw into a
   * caller" — rather than contingent on today's list of ways `resolveFrom` might
   * throw, and it is exactly the guarantee the class doc comment already claims
   * ("All public methods are best-effort and never throw into the call path").
   *
   * The failure arm is the REGISTRY default, matching `getValue`'s catch and
   * `snapshot`'s, deliberately and not merely for symmetry: falling back to the
   * env layer here would let a corrupt cache entry resolve a gated flag through
   * its env var — the exact substitution {@link SnapshotPairResult} exists to
   * prevent for the read-failure case. Per-flag, not per-loop, so one unresolvable
   * flag cannot blank the other twenty. No `recordEval` call: unlike `getValue`
   * and `snapshot`, these loops do not meter their evaluations, and starting to
   * here would put a new series under `feature_flag_evaluations_total` for a
   * failure path only.
   */
  private resolveFromOrDefault(
    flag: FlagDefinition,
    ctx: FlagContext,
    global: FeatureFlagOverrideRecord[],
    tenant: FeatureFlagOverrideRecord[],
  ): { value: unknown; source: ResolutionSource } {
    try {
      return this.resolveFrom(flag, ctx, global, tenant);
    } catch (err) {
      logger.warn(
        { err, flag: flag.key, tenantId: ctx.tenantId },
        'Feature flag resolution failed, using registry default',
      );
      return { value: flag.default, source: 'default' };
    }
  }

  /**
   * Steps 4-5 of {@link resolveFrom} — the value a flag resolves to once no
   * override row applies: the env layer if it is set, else the registry default.
   *
   * Extracted so `resolvePrewarm` can ask for it when it DISCARDS a malformed
   * override row, without a second snapshot read (this reads `process.env` only)
   * and without restating the "is the env layer set?" test. That test is subtler
   * than it looks and must not drift: an env var set to the EMPTY STRING counts as
   * unset here (registry default), whereas `resolveEnvDefault` alone would parse
   * `''` as boolean false. Two copies of this predicate would eventually disagree,
   * and the disagreement would show up only for a tenant with a corrupt row on a
   * deployment with an empty env var — i.e. never in a test anyone thought to
   * write. One definition, used by both callers.
   */
  private resolveEnvOrRegistryDefault(
    flag: FlagDefinition,
  ): { value: unknown; source: ResolutionSource } {
    if (flag.envVar && process.env[flag.envVar] !== undefined && process.env[flag.envVar] !== '') {
      return { value: resolveEnvDefault(flag), source: 'env' };
    }
    return { value: flag.default, source: 'default' };
  }

  private recordEval(flag: FlagDefinition, value: unknown, source: ResolutionSource): void {
    const result = flag.type === 'boolean' ? String(value === true) : 'value';
    try {
      featureFlagEvaluationsTotal.inc({ flag: flag.key, result, source });
    } catch {
      // metrics are best-effort
    }
  }

  // --- Snapshot reads (throwing variants used by getValue's try/catch) ---

  private async getGlobalSnapshot(): Promise<FeatureFlagOverrideRecord[]> {
    return this.getSnapshot('global', this.globalRedisKey(), () => featureFlagRepository.findGlobal());
  }

  private async getTenantSnapshot(tenantId: string): Promise<FeatureFlagOverrideRecord[]> {
    return this.getSnapshot(this.tenantCacheKey(tenantId), this.tenantRedisKey(tenantId), () =>
      featureFlagRepository.findByTenant(tenantId),
    );
  }

  // --- All-or-nothing snapshot pair for resolveAll/resolveClientExposed/resolvePrewarm ---

  /**
   * Read the global + tenant snapshots for a multi-flag resolve. **All-or-nothing:**
   * if EITHER read fails the pair collapses to `[[], []]` (full registry-default
   * fallback). A partial result — a good global with an empty tenant snapshot —
   * would transiently invert precedence (D1): an opted-in tenant override (`true`)
   * would resolve to a surviving `global=false`, leaving the tenant stuck off. So a
   * partial failure must degrade to defaults, never to the other layer's value.
   * (`isEnabled`/`getValue` already fail whole via the `Promise.all` in `getValue`.)
   */
  private async getSnapshotsAllOrNothing(
    tenantId: string,
  ): Promise<[FeatureFlagOverrideRecord[], FeatureFlagOverrideRecord[]]> {
    const pair = await this.readSnapshotPair(tenantId);
    return pair.ok ? [pair.global, pair.tenant] : [[], []];
  }

  /**
   * All-or-nothing snapshot-pair read that reports FAILURE distinctly from an
   * empty result — the distinction {@link snapshot} needs and
   * `getSnapshotsAllOrNothing`'s `[[], []]` return type cannot express (a tenant
   * with no overrides reads exactly the same empty pair). Same all-or-nothing
   * rule: if either read fails, neither survives, so a partial failure can't
   * invert precedence (D1).
   */
  private async readSnapshotPair(tenantId: string): Promise<SnapshotPairResult> {
    try {
      const [global, tenant] = await Promise.all([
        this.getGlobalSnapshot(),
        this.getTenantSnapshot(tenantId),
      ]);
      return { ok: true, global, tenant };
    } catch (err) {
      logger.warn({ err, tenantId }, 'Feature flag snapshot read failed, resolving registry defaults');
      return { ok: false };
    }
  }

  /**
   * Read-through one snapshot. Same shape as the retired tenant-settings cache: a Redis
   * read failure falls through to the DB without flipping degraded mode; only a
   * write failure flips it. A DB read failure throws (caller decides) and is
   * never cached. Degraded mode is left again by the single per-window probe
   * described on {@link claimRedisAttempt}.
   */
  private async getSnapshot(
    localKey: string,
    redisKey: string,
    dbRead: () => Promise<FeatureFlagOverrideRecord[]>,
  ): Promise<FeatureFlagOverrideRecord[]> {
    // Decided ONCE per read so the GET and the SET below belong to the same
    // probe. Deciding twice would let a probe whose GET proved Redis is back be
    // refused the SET (the cooldown having just been re-armed), leaving a healed
    // replica writing only to its local cache — recovery that recovers nothing.
    let useRedis = this.claimRedisAttempt();
    const probing = useRedis && this.degradedMode;

    if (useRedis) {
      let cached: string | null = null;
      try {
        cached = await this.redis!.get(redisKey);
      } catch {
        // Redis read failed — fall through to DB (don't flip degraded mode).
        // Preserved deliberately: a read miss costs a query, not correctness,
        // and the DB is the source of truth.
        // If this WAS the probe, Redis is demonstrably still down, so drop the
        // write attempt too — one probe must cost one round trip, not two.
        if (probing) useRedis = false;
      }

      // Parsing sits OUTSIDE that catch on purpose: a cached value we cannot use
      // is not evidence that Redis is unreachable, so it must not be folded into
      // the read-failure arm above (which would cancel a probe's SET and, worse,
      // silently re-run the DB path as if the cache had simply missed).
      if (cached !== null) {
        // A GET that HITS is what ends degraded mode on this arm; a MISS heals
        // via the successful SET further down instead. Healing on a READ when
        // only a WRITE flipped the flag looks asymmetric and is deliberate: a
        // probe whose GET hits returns from right here without ever reaching the
        // SET, so requiring a write success to heal would leave a replica latched
        // forever behind a shared key it can read perfectly well — the exact bug
        // this mechanism replaces. A Redis that serves reads but refuses writes
        // simply re-enters degraded mode on its next miss.
        //
        // A MISS must NOT heal, which is the whole reason this sits in the hit
        // branch rather than beside the GET. A miss proves only that Redis
        // answered a read; it is no evidence at all about the write failure that
        // caused degraded mode. Clearing the flag before the DB read and the SET
        // below turns the entire duration of that DB query into a window where
        // `claimRedisAttempt()` returns true unconditionally for every concurrent
        // caller — so if writes are still unavailable, a burst spends a Redis
        // round trip AND a DB query each before one of them re-enters degraded
        // mode. That is precisely the stampede the synchronous, cooldown-armed
        // claim exists to prevent, defeated by the single probe that was supposed
        // to be its one permitted cost.
        //
        // BEFORE `readCachedSnapshot`, not after: a corrupt cached value is still
        // proof that Redis is reachable, and `readCachedSnapshot` THROWS on one —
        // so healing after it would spend the probe, heal nothing, and keep the
        // replica degraded on the strength of a bad VALUE rather than a bad Redis.
        this.leaveDegradedMode();
        return await this.readCachedSnapshot(cached, redisKey);
      }
    } else {
      const local = this.localCache.get(localKey);
      if (local && local.expiresAt > Date.now()) {
        return local.value;
      }
    }

    // Cache miss — query DB. A DB error is NOT cached.
    const value = await dbRead();

    if (useRedis) {
      try {
        await this.redis!.set(redisKey, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS);
        this.leaveDegradedMode();
      } catch {
        this.enterDegradedMode();
        this.localCache.set(localKey, { value, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
      }
    } else {
      this.localCache.set(localKey, { value, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
    }

    return value;
  }

  /**
   * Turn a cached string into records, or FAIL THE READ. Never returns data of
   * the wrong shape, and never returns a value the caller could mistake for "this
   * tenant has no overrides".
   *
   * ── What was wrong ────────────────────────────────────────────────────────
   * `getSnapshot` used to `return JSON.parse(cached) as FeatureFlagOverrideRecord[]`,
   * the cast being the only "validation" there was. A value that is valid JSON but
   * NOT an array — a key-prefix collision, a stray `SET`, a partial write — reached
   * `resolveFrom`, where `.find(...)` threw `TypeError: tenant.find is not a
   * function`. `getValue` and `snapshot` caught that and degraded; `resolveAll` did
   * not, and `resolveAll` is what `resolvePrewarm`/`resolveCallerActivity` — and so
   * the `ringing` telephony webhook — resolve through. One bad `ff:global` value
   * therefore 500'd every inbound call on every tenant for as long as it stayed
   * cached, with carriers retrying into it. A GET *hit* never re-`SET`s, so the
   * window did not self-heal; a stray `SET` issued without `EX` never expires at
   * all. {@link resolveFromOrDefault} is the containment; this is the cause.
   *
   * ── Why THROW rather than treat it as a cache miss ────────────────────────
   * A miss would fall through to the DB, which is the source of truth, produce the
   * right answer, and repair the key on the way out — strictly better answers. It
   * is rejected anyway, because a corrupt cache entry must not be able to resolve a
   * gated capability through its env var: with no override rows in the DB, "cache
   * miss" resolves `custom_sip` from `FF_CUSTOM_SIP`, i.e. evident corruption of
   * the flag namespace would OPEN a gate. That is the substitution
   * {@link SnapshotPairResult} exists to prevent, and it is pinned in
   * `test/unit/feature-flags/flag-snapshot.test.ts` ("resolves the REGISTRY default
   * even when the env var would open the gate"). Failing the read routes every
   * caller to the arm it already has for an unreadable snapshot pair — registry
   * defaults, gates shut — which is the conservative direction for a gate.
   *
   * Unparseable JSON takes the same arm as a non-array, deliberately: both mean
   * "the key holds something that is not a snapshot", and splitting them would put
   * two treatments of one condition in one function. (Unparseable JSON previously
   * fell through to the DB by accident of sitting inside the GET's catch block.)
   *
   * ── Repair ────────────────────────────────────────────────────────────────
   * The key is DELETED before throwing. Without it the conservative arm is worse
   * than the bug it replaces — a no-TTL stray `SET` on `ff:global` would pin the
   * whole fleet to registry defaults permanently. With it, corruption costs the
   * requests already in flight and nothing after. The DEL is best-effort
   * ({@link delKey} swallows its own errors) and can only remove a value already
   * known to be unusable.
   *
   * Contents are NOT validated beyond the shape. `resolveFrom` tolerates junk rows
   * (they match no `flag_key`), and the values inside a matching row are the
   * untrusted-JSONB case `resolvePrewarm`/`resolveCallerActivity` already guard at
   * the point of use — re-validating here would repeat that on the hot path for
   * every flag, including the ones nobody read.
   */
  private async readCachedSnapshot(
    cached: string,
    redisKey: string,
  ): Promise<FeatureFlagOverrideRecord[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cached);
    } catch {
      await this.discardCorruptKey(redisKey, 'unparseable JSON');
      throw new Error(`Feature flag cache key '${redisKey}' holds unparseable JSON`);
    }
    if (!Array.isArray(parsed)) {
      const shape = parsed === null ? 'null' : typeof parsed;
      await this.discardCorruptKey(redisKey, `non-array (${shape})`);
      throw new Error(`Feature flag cache key '${redisKey}' holds a non-array snapshot (${shape})`);
    }
    return parsed as FeatureFlagOverrideRecord[];
  }

  /** Log and evict a cache key whose contents are not a snapshot. See {@link readCachedSnapshot}. */
  private async discardCorruptKey(redisKey: string, reason: string): Promise<void> {
    logger.warn(
      { redisKey, reason },
      'Feature flag cache key holds a corrupt snapshot; evicting it and failing this read to registry defaults',
    );
    await this.delKey(redisKey);
  }

  /**
   * May this read touch Redis — and if we are degraded, is this the one request
   * allowed to find out?
   *
   * Degraded mode used to be a ONE-WAY LATCH: a single transient `SET` failure
   * took a replica off shared Redis permanently, for the life of the process.
   * That is worse than it sounds, because `invalidate()` clears the shared key
   * and only the LOCAL cache of the replica that handled the write — so every
   * other latched replica kept serving a stale policy for up to
   * `CACHE_TTL_SECONDS` after every subsequent change, forever. Which replica
   * handles a given call's `ringing` webhook is effectively random, so a tenant's
   * pre-warm toggle then took effect on some calls and not others: the classic
   * "it misbehaves sometimes, with no pattern" report.
   *
   * The claim is taken SYNCHRONOUSLY, before the caller's first `await`: the
   * cooldown is re-armed here rather than when the probe finishes, so a burst of
   * concurrent reads arriving the instant a window opens yields exactly one
   * probe and the rest take the local-cache path. That also means a probe that
   * FAILS costs no more than one that succeeds — the next window is already set,
   * whatever the outcome — which is what keeps a real Redis outage as cheap as
   * the latch it replaces, minus one round trip per window.
   */
  private claimRedisAttempt(): boolean {
    if (!this.redis) return false;
    if (!this.degradedMode) return true;

    const now = Date.now();
    if (now < this.nextRedisProbeAt) return false;
    this.nextRedisProbeAt = now + DEGRADED_PROBE_COOLDOWN_SECONDS * 1000;
    return true;
  }

  private enterDegradedMode(): void {
    const wasDegraded = this.degradedMode;
    this.degradedMode = true;
    this.nextRedisProbeAt = Date.now() + DEGRADED_PROBE_COOLDOWN_SECONDS * 1000;
    if (!wasDegraded) {
      logger.warn(
        { probeInSeconds: DEGRADED_PROBE_COOLDOWN_SECONDS },
        'Feature flag cache entering degraded mode (Redis write failed); serving from the local cache until a probe succeeds',
      );
    }
  }

  private leaveDegradedMode(): void {
    if (!this.degradedMode) return;
    this.degradedMode = false;
    this.nextRedisProbeAt = 0;
    logger.info('Feature flag cache left degraded mode (Redis reachable again)');
  }

  private async delKey(key: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(key);
    } catch {
      // Non-critical — TTLs out within CACHE_TTL_SECONDS.
    }
  }

  // --- Key helpers ---

  private globalRedisKey(): string {
    return `${this.keyPrefix}ff:global`;
  }
  private tenantRedisKey(tenantId: string): string {
    return `${this.keyPrefix}ff:tenant:${tenantId}`;
  }
  private tenantCacheKey(tenantId: string): string {
    return `tenant:${tenantId}`;
  }
}
