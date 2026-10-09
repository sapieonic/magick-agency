import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  releaseTelephonyLease,
  resetTelephonyReleaseLatches,
  setTelephonyReleaseObserver,
  type TelephonyReleaseGuards,
  type TelephonyReleaseOutcome,
  type TelephonyReleaseSource,
} from '../../../src/core/telephony-release.js';

// Guard doubles are built per-test (no shared test utilities by project convention).
function makeGuards(opts: {
  globalDegraded?: boolean | undefined;
  accountDegraded?: boolean | undefined;
  /** Omit to build a guard with NO isDegraded at all (the shape ~50 existing doubles have). */
  withIsDegraded?: boolean;
  /** Omit to build a provider guard with no releaseAll (the coordinator/webrtc double shape). */
  releaseAll?: ((...args: unknown[]) => Promise<unknown>) | undefined;
  withProviderGuard?: boolean;
} = {}) {
  const withIsDegraded = opts.withIsDegraded !== false;
  const globalRelease = vi.fn().mockResolvedValue(undefined);
  const accountRelease = vi.fn().mockResolvedValue(undefined);
  const providerRelease = vi.fn().mockResolvedValue(undefined);

  const guards: TelephonyReleaseGuards = {
    concurrencyGuard: {
      release: globalRelease,
      ...(withIsDegraded ? { isDegraded: () => opts.globalDegraded === true } : {}),
    },
    accountConcurrencyGuard: {
      release: accountRelease,
      ...(withIsDegraded ? { isDegraded: () => opts.accountDegraded === true } : {}),
    },
    ...(opts.withProviderGuard === false
      ? {}
      : {
        providerConcurrencyGuard: {
          release: providerRelease,
          // type-only cast (the server tsconfig typechecks tests).
          ...(opts.releaseAll ? { releaseAll: opts.releaseAll as NonNullable<NonNullable<TelephonyReleaseGuards['providerConcurrencyGuard']>['releaseAll']> } : {}),
        },
      }),
  };
  return { guards, globalRelease, accountRelease, providerRelease };
}

const PARAMS = {
  concurrencyKey: 'ext-ref-1',
  tenantId: 'tenant-1',
  accountId: 'default',
  provider: 'vobiz',
  source: 'session_end' as TelephonyReleaseSource,
};

describe('releaseTelephonyLease', () => {
  beforeEach(() => {
    setTelephonyReleaseObserver(null);
    // The decline-reason log is latched once per reason+source per process, so
    // without this the log assertions would be order-dependent across tests.
    resetTelephonyReleaseLatches();
  });

  describe('healthy composite path — the round-trip reduction', () => {
    it('releases every scope in ONE call and does not touch the per-guard releases', async () => {
      const releaseAll = vi.fn().mockResolvedValue({ status: 'released', scopes: 3 });
      const { guards, globalRelease, accountRelease, providerRelease } = makeGuards({ releaseAll });

      const outcome = await releaseTelephonyLease(guards, PARAMS);

      expect(outcome).toBe('composite');
      expect(releaseAll).toHaveBeenCalledTimes(1);
      expect(releaseAll).toHaveBeenCalledWith('ext-ref-1', 'tenant-1', 'default', 'vobiz');
      // The whole point: three release evaluations collapse to one.
      expect(globalRelease).not.toHaveBeenCalled();
      expect(accountRelease).not.toHaveBeenCalled();
      expect(providerRelease).not.toHaveBeenCalled();
    });

    it('treats a legacy account (2 scopes, no provider lease) as a composite success', async () => {
      const releaseAll = vi.fn().mockResolvedValue({ status: 'released', scopes: 2 });
      const { guards, globalRelease, accountRelease } = makeGuards({ releaseAll });

      expect(await releaseTelephonyLease(guards, PARAMS)).toBe('composite');
      expect(globalRelease).not.toHaveBeenCalled();
      expect(accountRelease).not.toHaveBeenCalled();
    });

    it('reports a SINGLE released scope as partial, never as success', async () => {
      // A complete lease is 2 scopes (legacy) or 3 (provider mode), so 1 means the
      // rest are still parked — e.g. a wrong tenant/account, where the tenant-less
      // global key alone still hits.
      const releaseAll = vi.fn().mockResolvedValue({ status: 'released', scopes: 1 });
      const { guards, globalRelease, accountRelease } = makeGuards({ releaseAll });

      expect(await releaseTelephonyLease(guards, PARAMS)).toBe('partial');
      // Re-running per scope would use the same keys, so it would not help — the
      // value of `partial` is the signal, not a retry.
      expect(globalRelease).not.toHaveBeenCalled();
      expect(accountRelease).not.toHaveBeenCalled();
    });

    it('accepts two released scopes, because legacy-complete and provider-partial are indistinguishable', async () => {
      const releaseAll = vi.fn().mockResolvedValue({ status: 'released', scopes: 2 });
      const { guards } = makeGuards({ releaseAll });

      expect(await releaseTelephonyLease(guards, PARAMS)).toBe('composite');
    });

    it('reports zero released scopes as noop and does NOT fall back', async () => {
      // Redis authoritatively held nothing — a duplicate teardown, or leases that
      // TTL-expired. Falling back would spend three round trips deleting nothing.
      const releaseAll = vi.fn().mockResolvedValue({ status: 'released', scopes: 0 });
      const { guards, globalRelease, accountRelease, providerRelease } = makeGuards({ releaseAll });

      expect(await releaseTelephonyLease(guards, PARAMS)).toBe('noop');
      expect(globalRelease).not.toHaveBeenCalled();
      expect(accountRelease).not.toHaveBeenCalled();
      expect(providerRelease).not.toHaveBeenCalled();
    });
  });

  describe('the degraded gate — a latched guard must keep its local counter', () => {
    it.each([
      ['global', { globalDegraded: true }],
      ['account', { accountDegraded: true }],
    ])('classifies on the per-scope path when the %s guard is degraded', async (_label, degraded) => {
      const releaseAll = vi.fn().mockResolvedValue({ status: 'released', scopes: 3 });
      const { guards, globalRelease, accountRelease, providerRelease } = makeGuards({ releaseAll, ...degraded });

      const outcome = await releaseTelephonyLease(guards, PARAMS);

      // A degraded guard's process-local counter is decremented ONLY by its own
      // release(). degradedMode never resets, so classifying on the Redis-only
      // composite would ratchet that counter to the limit forever.
      expect(outcome).toBe('fallback');
      expect(globalRelease).toHaveBeenCalledWith('ext-ref-1');
      expect(accountRelease).toHaveBeenCalledWith('ext-ref-1', 'tenant-1', 'default');
      expect(providerRelease).toHaveBeenCalledWith('ext-ref-1', 'tenant-1', 'default', 'vobiz');
    });

    it('still cleans Redis on the degraded path, because no per-guard release will', async () => {
      // A degraded guard skips Redis entirely. Without this best-effort composite a
      // latched replica would park a global + account slot in the SHARED counter on
      // every call it ends, for a full lock TTL, until another replica swept it.
      const releaseAll = vi.fn().mockResolvedValue({ status: 'released', scopes: 3 });
      const { guards, globalRelease } = makeGuards({ releaseAll, globalDegraded: true });

      const outcome = await releaseTelephonyLease(guards, PARAMS);

      expect(releaseAll).toHaveBeenCalledTimes(1);
      expect(releaseAll).toHaveBeenCalledWith('ext-ref-1', 'tenant-1', 'default', 'vobiz');
      // It is cleanup only — the per-scope path still owns the local counters and
      // the classification.
      expect(outcome).toBe('fallback');
      expect(globalRelease).toHaveBeenCalledTimes(1);
    });

    it('does not attempt the Redis cleanup when there is no provider to key it on', async () => {
      const releaseAll = vi.fn().mockResolvedValue({ status: 'released', scopes: 3 });
      const { guards } = makeGuards({ releaseAll, globalDegraded: true });

      await releaseTelephonyLease(guards, { ...PARAMS, provider: '' });

      expect(releaseAll).not.toHaveBeenCalled();
    });

    it('treats a guard with NO isDegraded method as healthy', async () => {
      // ~50 existing test doubles and older embedders omit it; an absent optional
      // method must not disable the fast path.
      const releaseAll = vi.fn().mockResolvedValue({ status: 'released', scopes: 3 });
      const { guards } = makeGuards({ releaseAll, withIsDegraded: false });

      expect(await releaseTelephonyLease(guards, PARAMS)).toBe('composite');
      expect(releaseAll).toHaveBeenCalledTimes(1);
    });
  });

  describe('a missing provider cannot silently release nothing', () => {
    it.each([['empty string', ''], ['undefined', undefined]])(
      'falls back when the provider is %s',
      async (_label, provider) => {
        // releaseAll builds the provider key from this and reports `unavailable`
        // without it — releasing nothing at all, while the call still holds the
        // global + account leases. CallSession defaults telephonyProvider to ''.
        const releaseAll = vi.fn().mockResolvedValue({ status: 'released', scopes: 3 });
        const { guards, globalRelease, accountRelease, providerRelease } = makeGuards({ releaseAll });

        const outcome = await releaseTelephonyLease(guards, { ...PARAMS, provider });

        expect(outcome).toBe('fallback');
        // No provider means no key to build — nothing to clean up either.
        expect(releaseAll).not.toHaveBeenCalled();
        expect(globalRelease).toHaveBeenCalledWith('ext-ref-1');
        expect(accountRelease).toHaveBeenCalledWith('ext-ref-1', 'tenant-1', 'default');
        // Nothing to release a provider lease against, so it is not attempted.
        expect(providerRelease).not.toHaveBeenCalled();
      },
    );
  });

  describe('inconclusive composite results fall back', () => {
    it.each([
      ['unavailable (no Redis client)', { status: 'unavailable' }],
      ['an unrecognised shape', { weird: true }],
      ['undefined (a double predating the typed result)', undefined],
    ])('falls back on %s', async (_label, resolved) => {
      const releaseAll = vi.fn().mockResolvedValue(resolved);
      const { guards, globalRelease, accountRelease, providerRelease } = makeGuards({ releaseAll });

      const outcome = await releaseTelephonyLease(guards, PARAMS);

      expect(outcome).toBe('fallback');
      expect(globalRelease).toHaveBeenCalledTimes(1);
      expect(accountRelease).toHaveBeenCalledTimes(1);
      expect(providerRelease).toHaveBeenCalledTimes(1);
    });

    it('reports FAILURE (not fallback) when Redis rejected the composite', async () => {
      // The three guards swallow their own Redis errors and never reject, so the
      // composite's `failed` status is the only evidence a release did not land.
      // Classifying this as `fallback` would make the alertable outcome
      // unreachable in production.
      const releaseAll = vi.fn().mockResolvedValue({ status: 'failed', err: new Error('redis down') });
      const { guards, globalRelease, accountRelease, providerRelease } = makeGuards({ releaseAll });

      expect(await releaseTelephonyLease(guards, PARAMS)).toBe('failure');
      // It still attempts every scope — a blip may have cleared in between.
      expect(globalRelease).toHaveBeenCalledTimes(1);
      expect(accountRelease).toHaveBeenCalledTimes(1);
      expect(providerRelease).toHaveBeenCalledTimes(1);
    });

    it('reports plain fallback when the composite merely never ran', async () => {
      // `unavailable` is the ordinary degraded / legacy / no-provider route, not
      // a failure: the per-guard releases are the real work there.
      const releaseAll = vi.fn().mockResolvedValue({ status: 'unavailable' });
      const { guards } = makeGuards({ releaseAll });

      expect(await releaseTelephonyLease(guards, PARAMS)).toBe('fallback');
    });

    it('falls back rather than reporting a terminal noop on a released status with no count', async () => {
      // `undefined > 0` is false, which would land on the TERMINAL noop and skip
      // the fallback entirely — leaking every lease until the sweep.
      const releaseAll = vi.fn().mockResolvedValue({ status: 'released' });
      const { guards, globalRelease, accountRelease } = makeGuards({ releaseAll });

      expect(await releaseTelephonyLease(guards, PARAMS)).toBe('fallback');
      expect(globalRelease).toHaveBeenCalledTimes(1);
      expect(accountRelease).toHaveBeenCalledTimes(1);
    });

    it('still releases every scope, and reports failure, when releaseAll throws outright', async () => {
      const releaseAll = vi.fn().mockRejectedValue(new Error('boom'));
      const { guards, globalRelease, accountRelease } = makeGuards({ releaseAll });

      // An escaping throw is treated exactly like a `failed` result: fall back,
      // never propagate, and report the alertable outcome.
      await expect(releaseTelephonyLease(guards, PARAMS)).resolves.toBe('failure');
      expect(globalRelease).toHaveBeenCalledTimes(1);
      expect(accountRelease).toHaveBeenCalledTimes(1);
    });

    it('falls back when the provider guard has no releaseAll at all', async () => {
      const { guards, globalRelease, accountRelease, providerRelease } = makeGuards();

      expect(await releaseTelephonyLease(guards, PARAMS)).toBe('fallback');
      expect(globalRelease).toHaveBeenCalledTimes(1);
      expect(accountRelease).toHaveBeenCalledTimes(1);
      expect(providerRelease).toHaveBeenCalledTimes(1);
    });

    it('releases global + account when there is no provider guard at all', async () => {
      const { guards, globalRelease, accountRelease } = makeGuards({ withProviderGuard: false });

      expect(await releaseTelephonyLease(guards, PARAMS)).toBe('fallback');
      expect(globalRelease).toHaveBeenCalledTimes(1);
      expect(accountRelease).toHaveBeenCalledTimes(1);
    });
  });

  describe('absent or null guards (the static/IVR call sites)', () => {
    // Those sites reach the guards through a callManager whose guards can be
    // null, and previously released each only behind an `if`.
    it('declines the composite and releases only the guards that exist', async () => {
      const releaseAll = vi.fn().mockResolvedValue({ status: 'released', scopes: 3 });
      const accountRelease = vi.fn().mockResolvedValue(undefined);
      const providerRelease = vi.fn().mockResolvedValue(undefined);

      const outcome = await releaseTelephonyLease({
        concurrencyGuard: null,
        accountConcurrencyGuard: { release: accountRelease },
        providerConcurrencyGuard: { release: providerRelease, releaseAll },
      }, PARAMS);

      // Taking the composite here would release a global lease this caller does
      // not manage.
      expect(releaseAll).not.toHaveBeenCalled();
      expect(outcome).toBe('fallback');
      expect(accountRelease).toHaveBeenCalledWith('ext-ref-1', 'tenant-1', 'default');
      expect(providerRelease).toHaveBeenCalledTimes(1);
    });

    it('declines the composite when the account guard is the missing one', async () => {
      const releaseAll = vi.fn().mockResolvedValue({ status: 'released', scopes: 3 });
      const globalRelease = vi.fn().mockResolvedValue(undefined);

      const outcome = await releaseTelephonyLease({
        concurrencyGuard: { release: globalRelease },
        accountConcurrencyGuard: undefined,
        providerConcurrencyGuard: { release: vi.fn(), releaseAll },
      }, PARAMS);

      expect(releaseAll).not.toHaveBeenCalled();
      expect(outcome).toBe('fallback');
      expect(globalRelease).toHaveBeenCalledWith('ext-ref-1');
    });

    it('is a clean no-op-ish fallback when no guard exists at all', async () => {
      await expect(releaseTelephonyLease({}, PARAMS)).resolves.toBe('fallback');
    });
  });

  describe('fallback failure isolation and concurrency', () => {
    it('still releases the other scopes when one rejects, and reports failure', async () => {
      const { guards, globalRelease, accountRelease, providerRelease } = makeGuards();
      globalRelease.mockRejectedValue(new Error('global boom'));

      const outcome = await releaseTelephonyLease(guards, PARAMS);

      expect(outcome).toBe('failure');
      expect(globalRelease).toHaveBeenCalledTimes(1);
      expect(accountRelease).toHaveBeenCalledTimes(1);
      expect(providerRelease).toHaveBeenCalledTimes(1);
    });

    it('never lets a synchronous throw from a guard escape into teardown', async () => {
      const { guards, accountRelease, providerRelease } = makeGuards();
      // type-only non-null assertion (the server tsconfig typechecks tests).
      (guards.concurrencyGuard!.release as ReturnType<typeof vi.fn>)
        .mockImplementation(() => { throw new Error('sync boom'); });

      await expect(releaseTelephonyLease(guards, PARAMS)).resolves.toBe('failure');
      // The other scopes are still released.
      expect(accountRelease).toHaveBeenCalledTimes(1);
      expect(providerRelease).toHaveBeenCalledTimes(1);
    });

    it('reports failure when every scope rejects, and never throws', async () => {
      const { guards, globalRelease, accountRelease, providerRelease } = makeGuards();
      globalRelease.mockRejectedValue(new Error('a'));
      accountRelease.mockRejectedValue(new Error('b'));
      providerRelease.mockRejectedValue(new Error('c'));

      await expect(releaseTelephonyLease(guards, PARAMS)).resolves.toBe('failure');
    });

    it('starts all three releases before any of them settles (concurrent, not serial)', async () => {
      const { guards, globalRelease, accountRelease, providerRelease } = makeGuards();
      let unblock!: () => void;
      const gate = new Promise<void>((resolve) => { unblock = resolve; });
      // Every scope blocks on the same gate; if the helper awaited them in
      // sequence this would deadlock until the timeout rather than resolve.
      globalRelease.mockReturnValue(gate);
      accountRelease.mockReturnValue(gate);
      providerRelease.mockReturnValue(gate);

      const pending = releaseTelephonyLease(guards, PARAMS);
      await Promise.resolve();
      expect(globalRelease).toHaveBeenCalledTimes(1);
      expect(accountRelease).toHaveBeenCalledTimes(1);
      expect(providerRelease).toHaveBeenCalledTimes(1);

      unblock();
      await expect(pending).resolves.toBe('fallback');
    });
  });

  describe('idempotency', () => {
    it('a second release against real composite semantics is a noop, not a double decrement', async () => {
      // Models Redis: the first DEL removes the leases, the second finds none.
      let leases = 3;
      const releaseAll = vi.fn().mockImplementation(async () => {
        const scopes = leases;
        leases = 0;
        return { status: 'released', scopes };
      });
      const { guards } = makeGuards({ releaseAll });

      expect(await releaseTelephonyLease(guards, PARAMS)).toBe('composite');
      expect(await releaseTelephonyLease(guards, PARAMS)).toBe('noop');
    });
  });

  describe('self-heal sweep arming (structural, not a per-site checklist)', () => {
    it.each([
      ['failure', { status: 'failed', err: new Error('x') }],
      ['noop', { status: 'released', scopes: 0 }],
      ['partial', { status: 'released', scopes: 1 }],
    ])('arms the sweep on %s', async (expected, resolved) => {
      const wakeSelfHeal = vi.fn();
      const { guards } = makeGuards({ releaseAll: vi.fn().mockResolvedValue(resolved) });

      const outcome = await releaseTelephonyLease({ ...guards, wakeSelfHeal }, PARAMS);

      expect(outcome).toBe(expected);
      expect(wakeSelfHeal).toHaveBeenCalledTimes(1);
    });

    it('does NOT arm the sweep on a clean composite', async () => {
      const wakeSelfHeal = vi.fn();
      const { guards } = makeGuards({
        releaseAll: vi.fn().mockResolvedValue({ status: 'released', scopes: 3 }),
      });

      expect(await releaseTelephonyLease({ ...guards, wakeSelfHeal }, PARAMS)).toBe('composite');
      expect(wakeSelfHeal).not.toHaveBeenCalled();
    });

    it('does NOT arm the sweep on a plain fallback — every managed scope was released', async () => {
      const wakeSelfHeal = vi.fn();
      const { guards } = makeGuards();

      expect(await releaseTelephonyLease({ ...guards, wakeSelfHeal }, PARAMS)).toBe('fallback');
      expect(wakeSelfHeal).not.toHaveBeenCalled();
    });

    it('tolerates a caller that opts out of the waker (the dequeue rollbacks do)', async () => {
      const { guards } = makeGuards({
        releaseAll: vi.fn().mockResolvedValue({ status: 'released', scopes: 0 }),
      });
      // No `wakeSelfHeal` member at all.
      await expect(releaseTelephonyLease(guards, PARAMS)).resolves.toBe('noop');
    });

    it('a throwing waker cannot cost a release that already happened', async () => {
      const { guards, globalRelease } = makeGuards();
      const wakeSelfHeal = vi.fn(() => { throw new Error('waker boom'); });
      // Force a drift outcome so the waker is reached.
      (guards.concurrencyGuard!.release as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('x'));

      await expect(releaseTelephonyLease({ ...guards, wakeSelfHeal }, PARAMS)).resolves.toBe('failure');
      expect(globalRelease).toHaveBeenCalledTimes(1);
    });
  });

  describe('the last-ditch release when something outside the guards throws', () => {
    it('still releases every scope when isDegraded() throws', async () => {
      // isDegraded/declineReason/logOnce all run BEFORE any release is attempted,
      // so returning `failure` without trying would make "never throws" mean
      // "never releases" for callers that do not arm the sweep.
      const { guards, globalRelease, accountRelease, providerRelease } = makeGuards({
        releaseAll: vi.fn().mockResolvedValue({ status: 'released', scopes: 3 }),
      });
      guards.concurrencyGuard!.isDegraded = () => { throw new Error('probe boom'); };

      const outcome = await releaseTelephonyLease(guards, PARAMS);

      expect(outcome).toBe('failure');
      expect(globalRelease).toHaveBeenCalledWith('ext-ref-1');
      expect(accountRelease).toHaveBeenCalledWith('ext-ref-1', 'tenant-1', 'default');
      expect(providerRelease).toHaveBeenCalledTimes(1);
    });

    it('reports failure without throwing when even the last-ditch release cannot run', async () => {
      const guards = {
        concurrencyGuard: {
          release: vi.fn(),
          isDegraded: () => { throw new Error('probe boom'); },
        },
      };
      // No account/provider guard, and the global release itself throws.
      (guards.concurrencyGuard.release as ReturnType<typeof vi.fn>)
        .mockImplementation(() => { throw new Error('release boom'); });

      await expect(releaseTelephonyLease(guards, PARAMS)).resolves.toBe('failure');
    });
  });

  describe('the metric observer seam', () => {
    it('reports each outcome with its source', async () => {
      const seen: Array<[TelephonyReleaseOutcome, TelephonyReleaseSource]> = [];
      setTelephonyReleaseObserver((outcome, source) => { seen.push([outcome, source]); });

      const composite = makeGuards({ releaseAll: vi.fn().mockResolvedValue({ status: 'released', scopes: 3 }) });
      await releaseTelephonyLease(composite.guards, PARAMS);

      const fell = makeGuards();
      await releaseTelephonyLease(fell.guards, { ...PARAMS, source: 'webrtc' });

      expect(seen).toEqual([['composite', 'session_end'], ['fallback', 'webrtc']]);
    });

    it('a throwing observer cannot cost a release that already happened', async () => {
      setTelephonyReleaseObserver(() => { throw new Error('metrics exploded'); });
      const { guards, globalRelease } = makeGuards();

      await expect(releaseTelephonyLease(guards, PARAMS)).resolves.toBe('fallback');
      expect(globalRelease).toHaveBeenCalledTimes(1);
    });

    it('emits nothing when unwired', async () => {
      const { guards } = makeGuards();
      await expect(releaseTelephonyLease(guards, PARAMS)).resolves.toBe('fallback');
    });
  });
});
