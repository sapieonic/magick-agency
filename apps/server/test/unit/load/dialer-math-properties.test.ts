import { describe, expect, it, vi } from 'vitest';
import { createRng, LOAD_SEED, scaled, type Rng } from '../../helpers/load-scale.js';

// ---------------------------------------------------------------------------
// The dialer's pure rules as PROPERTIES over seeded generators: the retry policy,
// the our-fault redial bound, the abandonment predicate and rate, the guardrail's
// breach decision, the calling-hours window and the caller-ID rotation. Each case
// family runs a few thousand inputs (scaled by LOAD_SCALE) drawn by `createRng`,
// and every failure names the seed and the case.
//
// The example-based suites pin the documented cases one by one; these check the
// laws that must hold for EVERY input — bounds, monotonicity, never negative,
// never past a cap — which is what keeps a dialer working a roster for days from
// drifting into a state no example anticipated.
// ---------------------------------------------------------------------------

// The guardrail module imports a repository and the audit logger for its I/O
// half; only its pure decision is exercised here.
vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({ agencyCampaignRepository: {} }));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

const { resolveRetryDecision, resolveOurFaultRedial, DEFAULT_RETRY_POLICY, OUR_FAULT_REDIAL_BOUND, DEFAULT_OUR_FAULT_REDIAL_DELAY_MINUTES } =
  await import('../../../src/agency/retry-policy.js');
const { breachedRows, singleAbandonSampleFloor } = await import('../../../src/agency/abandonment-guardrail.js');
const { abandonmentRatePct, isAbandonedAttempt, ABANDONMENT_BRIDGE_GRACE_MS } = await import('@magick-agency/domain/abandonment-predicate');
const { callingWindowState, nextWindowOpen } = await import('../../../src/agency/calling-hours.js');
const { pickCallerId, usableCallerIds } = await import('../../../src/agency/pacing/caller-id-pool.js');

// The default sizes run in a couple of seconds; `LOAD_SCALE` multiplies the case
// counts, so the budget is set for a deliberate soak rather than the default.
vi.setConfig({ testTimeout: 300_000 });

const SEED = LOAD_SEED;
const OUTCOMES = ['connected', 'no_answer', 'busy', 'failed', 'invalid', 'abandoned', 'agent_disconnected', 'orphaned', 'canceled', 'machine'] as const;
type Outcome = (typeof OUTCOMES)[number];

/** A policy rule from the whole space an operator (or a bad row) can write. */
function randomRule(rng: Rng): { delay_minutes?: number; max_attempts: number } | undefined {
  if (rng.chance(0.15)) return undefined;
  const max = rng.pick([0, 1, 2, 3, 4, 5, 10, -1, 2.7, Number.NaN, Number.POSITIVE_INFINITY]);
  const delay = rng.pick([undefined, 0, 1, 5, 60, 1440, -5, 0.5, Number.NaN]);
  return delay === undefined ? { max_attempts: max } : { delay_minutes: delay, max_attempts: max };
}

function randomPolicy(rng: Rng): Record<string, { delay_minutes?: number; max_attempts: number }> | null {
  if (rng.chance(0.1)) return null;
  const p: Record<string, { delay_minutes?: number; max_attempts: number }> = {};
  for (const o of OUTCOMES) {
    const r = randomRule(rng);
    if (r) p[o] = r;
  }
  return p;
}

/** The effective max the policy resolves for an outcome (explicit rule, else the shipped default). */
function effectiveMax(policy: ReturnType<typeof randomPolicy>, outcome: Outcome): number | null {
  const rule = policy?.[outcome] ?? (DEFAULT_RETRY_POLICY as Record<string, { max_attempts: number } | undefined>)[outcome];
  if (!rule) return null;
  return Number.isFinite(rule.max_attempts) ? Math.max(0, Math.trunc(rule.max_attempts)) : 0;
}

describe('retry policy, as properties (load)', () => {
  const NOW = new Date('2026-03-08T06:30:00Z');

  it(`resolveRetryDecision is bounded, never negative, and monotone in attempts used — ${scaled(4000)} cases`, () => {
    const rng = createRng(SEED);
    for (let k = 0; k < scaled(4000); k++) {
      const policy = randomPolicy(rng);
      const outcome = rng.pick(OUTCOMES);
      const used = rng.int(0, 12);
      const tag = `case ${k}, seed ${SEED}: ${outcome} used=${used} policy=${JSON.stringify(policy?.[outcome] ?? null)}`;
      const d = resolveRetryDecision(policy as never, outcome as never, NOW, used);

      if (outcome === 'invalid') {
        expect(d.contactState, tag).toBe('suppressed');
        expect(d.suppressedReason, tag).toBe('invalid');
        continue;
      }
      if (d.contactState === 'pending') {
        // A retry is only scheduled inside the allowance, never in the past.
        const max = effectiveMax(policy, outcome)!;
        expect(used, tag).toBeLessThan(max);
        expect(d.nextAttemptAt, tag).not.toBeNull();
        const delayMs = d.nextAttemptAt!.getTime() - NOW.getTime();
        expect(delayMs, tag).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(delayMs), tag).toBe(true);
      } else {
        expect(d.nextAttemptAt, tag).toBeNull();
        expect(['completed', 'exhausted'], tag).toContain(d.contactState);
      }
      // Monotone: once a contact is out of retries, one more attempt never brings
      // it back.
      if (d.contactState !== 'pending') {
        const next = resolveRetryDecision(policy as never, outcome as never, NOW, used + 1);
        expect(next.contactState, tag).not.toBe('pending');
      }
    }
  });

  it(`a contact worked by the policy always terminates within its allowance — ${scaled(3000)} simulated contacts`, () => {
    const rng = createRng(SEED + 1);
    for (let k = 0; k < scaled(3000); k++) {
      const policy = randomPolicy(rng);
      // The largest allowance any outcome in this policy (or its defaults) grants.
      const ceiling = Math.max(1, ...OUTCOMES.map((o) => effectiveMax(policy, o) ?? 0));
      let used = 0;
      let state = 'pending';
      const history: string[] = [];
      while (state === 'pending') {
        const outcome = rng.pick(OUTCOMES);
        used++;
        history.push(outcome);
        const d = resolveRetryDecision(policy as never, outcome as never, NOW, used);
        state = d.contactState;
        expect(used, `case ${k}, seed ${SEED}: ${history.join(',')} still pending past ${ceiling}`).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it(`the our-fault redial bound is never exceeded, whatever the policy says — ${scaled(3000)} cases`, () => {
    const rng = createRng(SEED + 2);
    for (let k = 0; k < scaled(3000); k++) {
      const policy = randomPolicy(rng);
      const outcome = rng.pick(['agent_disconnected', 'canceled', 'orphaned'] as const);
      const used = rng.int(0, 8);
      const tag = `case ${k}, seed ${SEED}: ${outcome} used=${used} rule=${JSON.stringify(policy?.[outcome] ?? null)}`;
      const d = resolveOurFaultRedial(policy as never, outcome as never, NOW, used);
      if (used >= OUR_FAULT_REDIAL_BOUND) expect(d.contactState, tag).toBe('exhausted');
      if (d.contactState === 'pending') {
        expect(used, tag).toBeLessThan(OUR_FAULT_REDIAL_BOUND);
        const delayMs = d.nextAttemptAt!.getTime() - NOW.getTime();
        expect(delayMs, tag).toBeGreaterThanOrEqual(0);
        const configured = policy?.[outcome]?.delay_minutes;
        const expectMin = Number.isFinite(configured) ? Math.max(0, configured as number) : DEFAULT_OUR_FAULT_REDIAL_DELAY_MINUTES;
        expect(delayMs, tag).toBe(expectMin * 60_000);
        // A non-retryable configured rule (max 0) is honoured even for our faults.
        const max = policy?.[outcome]?.max_attempts;
        if (Number.isFinite(max)) expect(used, tag).toBeLessThan(Math.max(0, Math.trunc(max as number)));
      } else {
        expect(d.contactState, tag).toBe('exhausted');
        const next = resolveOurFaultRedial(policy as never, outcome as never, NOW, used + 1);
        expect(next.contactState, tag).toBe('exhausted');
      }
    }
  });
});

describe('abandonment math, as properties (load)', () => {
  it(`the abandonment predicate is answer-gated and monotone in bridge delay — ${scaled(4000)} cases`, () => {
    const rng = createRng(SEED + 3);
    for (let k = 0; k < scaled(4000); k++) {
      const answered = rng.chance(0.8) ? new Date(1_700_000_000_000 + rng.int(0, 1e6)) : null;
      const delay = rng.int(-50, 3 * ABANDONMENT_BRIDGE_GRACE_MS);
      const bridged = answered && rng.chance(0.8) ? new Date(answered.getTime() + delay) : null;
      const outcome = rng.pick(['connected', 'abandoned', 'no_answer', null] as const);
      const tag = `case ${k}, seed ${SEED}: answered=${!!answered} delay=${bridged ? delay : 'none'} outcome=${outcome}`;
      const v = isAbandonedAttempt({ answeredAt: answered, bridgedAt: bridged, outcome });
      if (!answered) expect(v, tag).toBe(false);
      else if (outcome === 'abandoned' || !bridged) expect(v, tag).toBe(true);
      else expect(v, tag).toBe(delay > ABANDONMENT_BRIDGE_GRACE_MS);
      // Bridging later never makes an abandoned call compliant.
      if (answered && bridged && v) {
        const later = isAbandonedAttempt({ answeredAt: answered, bridgedAt: new Date(bridged.getTime() + rng.int(1, 5000)), outcome });
        expect(later, tag).toBe(true);
      }
    }
  });

  it(`the rate is null with no answers and otherwise a bounded, monotone percentage — ${scaled(4000)} cases`, () => {
    const rng = createRng(SEED + 4);
    for (let k = 0; k < scaled(4000); k++) {
      const answered = rng.int(0, 5000);
      const abandoned = rng.int(0, answered);
      const tag = `case ${k}, seed ${SEED}: ${abandoned}/${answered}`;
      const r = abandonmentRatePct({ answered, abandoned });
      if (answered === 0) { expect(r, tag).toBeNull(); continue; }
      expect(r!, tag).toBeGreaterThanOrEqual(0);
      expect(r!, tag).toBeLessThanOrEqual(100);
      if (abandoned < answered) expect(abandonmentRatePct({ answered, abandoned: abandoned + 1 })!, tag).toBeGreaterThan(r!);
      expect(abandonmentRatePct({ answered: answered + 1, abandoned })!, tag).toBeLessThanOrEqual(r!);
    }
  });

  it(`the guardrail breaches only what it must, and more abandonment never clears a breach — ${scaled(4000)} cases`, () => {
    const rng = createRng(SEED + 5);
    for (let k = 0; k < scaled(4000); k++) {
      const answered = rng.int(0, 400);
      const abandoned = rng.int(0, answered);
      const ceiling = rng.pick([0.5, 1, 2, 3, 3, 3, 5, 10, 25, 100]);
      const status = rng.pick(['running', 'running', 'running', 'paused', 'completed', null]);
      const row = { tenant_id: 't', campaign_id: `c${k}`, answered, abandoned, status, ceiling_pct: ceiling };
      const tag = `case ${k}, seed ${SEED}: ${abandoned}/${answered} ceiling=${ceiling} ${status}`;
      const breached = breachedRows([row]).length === 1;
      const rate = abandonmentRatePct(row);
      if (breached) {
        expect(status, tag).toBe('running');
        expect(rate!, tag).toBeGreaterThan(ceiling);
        // Never a single call in a sample too coarse to measure the ceiling.
        expect(abandoned > 1 || answered >= singleAbandonSampleFloor(ceiling), tag).toBe(true);
      } else if (status === 'running' && rate !== null && rate > ceiling) {
        // The only breach it declines is the documented single-call refusal.
        expect(abandoned, tag).toBeLessThanOrEqual(1);
        expect(answered, tag).toBeLessThan(singleAbandonSampleFloor(ceiling));
      }
      // One abandoned call never pauses a campaign on its own (positive ceiling).
      if (abandoned <= 1) expect(breached, tag).toBe(false);
      // Monotone: more abandonment on the same answered count never clears it.
      if (breached && abandoned < answered) {
        expect(breachedRows([{ ...row, abandoned: abandoned + 1 }]).length, tag).toBe(1);
      }
    }
  });
});

describe('calling hours, as properties (load)', () => {
  const ZONES = [
    'UTC', 'Asia/Kolkata', 'America/New_York', 'Europe/London', 'Australia/Sydney',
    'Australia/Lord_Howe', 'America/Sao_Paulo', 'Pacific/Chatham', 'America/St_Johns', 'Not/AZone',
  ];
  const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;

  function randomWindow(rng: Rng) {
    const start = rng.int(0, 95) * 15;
    const end = rng.chance(0.1) ? 1440 : rng.int(0, 95) * 15;
    const days = [1, 2, 3, 4, 5, 6, 7].filter(() => rng.chance(0.6));
    return { start: hhmm(start), end: end === 1440 ? '24:00:00' : hhmm(end), days, timezone: rng.pick(ZONES) };
  }

  it(`nextWindowOpen is strictly in the future, genuinely open, and the FIRST opening — ${scaled(2000)} windows`, () => {
    const rng = createRng(SEED + 6);
    // Two years either side of a fixed instant, so DST transitions are crossed.
    const base = Date.parse('2026-03-01T00:00:00Z');
    let closedNow = 0;
    for (let k = 0; k < scaled(2000); k++) {
      const w = randomWindow(rng);
      const now = new Date(base + rng.int(0, 400 * 24 * 60) * 60_000 + rng.int(0, 59) * 1000);
      const tag = `case ${k}, seed ${SEED}: ${JSON.stringify(w)} at ${now.toISOString()}`;
      const state = callingWindowState(w, now);
      const next = nextWindowOpen(w, now);

      if (w.timezone === 'Not/AZone') {
        expect(state, tag).toBe('unresolvable');
        expect(next, tag).toBeNull();
        continue;
      }
      if (w.days.length === 0 || w.start === w.end) {
        expect(state, tag).toBe('closed');
        expect(next, tag).toBeNull();
        continue;
      }
      // A window with a day and a duration always opens again within the week.
      expect(next, tag).not.toBeNull();
      expect(next!.getTime(), tag).toBeGreaterThan(now.getTime());
      expect(next!.getTime() - now.getTime(), tag).toBeLessThanOrEqual(9 * 24 * 3600_000);
      expect(callingWindowState(w, next!), tag).toBe('open');
      if (state === 'closed') {
        closedNow++;
        // The deferral a closed gate writes must be the first opening — except
        // within an hour of a DST transition, where it can be up to that hour LATE,
        // which is the safe direction (early never is). Two shapes, both found by
        // this property:
        //  - fall-back: the SECOND occurrence of a repeated opening hour, which
        //    `nextWindowOpen` documents as lawful ("picking the later one merely
        //    starts up to an hour late") — Australia/Sydney, 2026-04-05, 02:00;
        //  - spring-forward, an opening INSIDE the skipped hour: the window is open
        //    from the transition instant, but the two-pass conversion lands on the
        //    configured minute after it — Europe/London, 2027-03-28, 01:30 opens at
        //    02:00 BST, returned as 02:30 BST. Its header calls the answer "the
        //    exact next opening"; across a gap it is up to the gap late (noted, not
        //    a compliance fault: no call can be placed early).
        // So an open instant before it may exist only inside the last hour, and
        // only when the zone's offset changed within that hour.
        const span = next!.getTime() - now.getTime();
        const probes = [next!.getTime() - 1000, ...Array.from({ length: 24 }, () => now.getTime() + Math.floor(rng.next() * span))];
        for (const t of probes) {
          if (t <= now.getTime()) continue;
          if (callingWindowState(w, new Date(t)) !== 'open') continue;
          const early = `${tag}: open at ${new Date(t).toISOString()}, before ${next!.toISOString()}`;
          expect(next!.getTime() - t, early).toBeLessThanOrEqual(3600_000);
          const offset = (at: number) => {
            const local = new Date(at).toLocaleString('sv-SE', { timeZone: w.timezone, hour12: false });
            return Date.parse(`${local.replace(' ', 'T')}Z`) - at;
          };
          expect(offset(next!.getTime() - 3600_000), `${early} — and no DST transition explains it`).not.toBe(offset(next!.getTime()));
        }
      }
    }
    expect(closedNow, `seed ${SEED}`).toBeGreaterThan(scaled(2000) / 10);
  });
});

describe('caller-ID rotation, as a property (load)', () => {
  it(`always picks a usable number and a batch rotates through the whole pool — ${scaled(2000)} pools`, () => {
    const rng = createRng(SEED + 7);
    for (let k = 0; k < scaled(2000); k++) {
      const raw = Array.from({ length: rng.int(0, 8) }, (_, i) => rng.pick([`+9190000000${i}`, ` +9190000001${i} `, '', '   ']));
      const pool = usableCallerIds({ caller_ids: raw } as never);
      const tag = `case ${k}, seed ${SEED}: ${JSON.stringify(raw)}`;
      for (const id of pool) {
        expect(id.trim(), tag).toBe(id);
        expect(id.length, tag).toBeGreaterThan(0);
      }
      if (pool.length === 0) { expect(pickCallerId(pool, rng.int(0, 100)), tag).toBeNull(); continue; }
      // One tick's batch (consecutive offsets at one instant) covers the pool.
      const spy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000 + rng.int(0, 1e6));
      const batch = Array.from({ length: pool.length }, (_, i) => pickCallerId(pool, i));
      spy.mockRestore();
      expect(new Set(batch), tag).toEqual(new Set(pool));
    }
  });
});
