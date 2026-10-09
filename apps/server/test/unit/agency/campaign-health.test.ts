import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// AD-P4-C-01 §C.2 — the health strip's diagnosis.
//
// The strip shows ONE reason. So the tests that matter are not "does each
// condition produce a message" but:
//
//   * does the RANKING hold when several are true at once — a supervisor acting
//     on the wrong one wastes the minutes the strip exists to save;
//   * does a degraded dependency produce silence rather than a guess — `null`
//     in-use must not read as saturation, because "contact support about your
//     limit" is the wrong instruction when we simply could not read Redis;
//   * and does core refuse to emit the one arm it cannot know (`credits_low`),
//     which is `AD-P4-C-04` applied to a union instead of a field.
// ---------------------------------------------------------------------------

import {
  campaignHealth,
  diagnoseAll,
  ELEVATED_FAILURE_MIN_ATTEMPTS,
  RECENT_FAILURE_WINDOW_MINUTES,
  type CampaignHealthInputs,
} from '../../../src/agency/campaign-health.js';
import {
  AGENCY_STALL_PRIORITY,
  type AgencyStallCode,
} from '@magick-agency/contracts/agency';
import type { AgencyCampaignRecord } from '../../../src/db/models/agency.model.js';

function campaign(patch: Partial<AgencyCampaignRecord> = {}): AgencyCampaignRecord {
  return {
    id: 'camp-1', tenant_id: 't1', account_id: 'a1', name: 'c',
    caller_ids: ['+911'], telephony_provider: 'vobiz',
    calling_window_start: '00:00:00', calling_window_end: '24:00:00',
    calling_days: [0, 1, 2, 3, 4, 5, 6], default_timezone: 'UTC',
    wrapup_seconds: 30, abandon_announcement_id: null, wrapup_auto_return: true,
    retry_policy: {} as never, disposition_catalog: [], break_reasons: [],
    context_display: {} as never, record_calls: false, analysis_profile_id: null,
    status: 'running',
    abandonment_ceiling_pct: 3, pause_reason: null, paused_at: null,
    pause_abandonment_rate_pct: null,
    contacts_total: 100, created_by: null,
    started_at: null, ended_at: null, completed_at: null,
    last_transition_by_user_id: null, last_transition_by_name: null,
    // Migration 111's lineage columns. An ordinary campaign is generation 0 with
    // no parent and no frozen selector; a retry campaign's health is computed by
    // exactly the same code, so this fixture stays on the common shape.
    parent_campaign_id: null, root_campaign_id: null,
    retry_generation: 0, retry_selector: null, retry_idempotency_key: null,
    created_at: new Date(), updated_at: new Date(),
    ...patch,
  };
}

/** A campaign that is dialing normally — every diagnosis false. */
function healthy(patch: Partial<CampaignHealthInputs> = {}): CampaignHealthInputs {
  return {
    campaign: campaign(),
    stats: {
      contacts_pending: 50, retries_pending: 0, agents_live: 3,
      agents_by_state: {
        offline: 0, available: 2, reserved: 0, on_call: 1, wrapup: 0, break: 0,
      },
    } as unknown as CampaignHealthInputs['stats'],
    dncAppliedVersion: 7,
    concurrencyLimit: 5,
    concurrencyInUse: 2,
    contactsOutsideCallingHours: 0,
    nextCallingWindowOpensAt: null,
    nextRetryAt: null,
    lastDialAt: new Date('2026-08-14T10:00:00Z'),
    recentFailures: { attempts: 100, failed: 1, windowMinutes: RECENT_FAILURE_WINDOW_MINUTES },
    onBreakByReason: {},
    ...patch,
  };
}

/** Inputs that trip every diagnosis core can make, simultaneously. */
function everythingWrong(): CampaignHealthInputs {
  return healthy({
    campaign: campaign({
      status: 'paused',
      pause_reason: 'abandonment_ceiling',
      pause_abandonment_rate_pct: 3.4,
      paused_at: new Date('2026-08-14T09:00:00Z'),
    }),
    stats: {
      contacts_pending: 0, retries_pending: 312, agents_live: 6,
      agents_by_state: {
        offline: 0, available: 0, reserved: 0, on_call: 1, wrapup: 0, break: 5,
      },
    } as unknown as CampaignHealthInputs['stats'],
    dncAppliedVersion: null,
    concurrencyLimit: 5,
    concurrencyInUse: 5,
    contactsOutsideCallingHours: 0,
    recentFailures: { attempts: 50, failed: 25, windowMinutes: RECENT_FAILURE_WINDOW_MINUTES },
    onBreakByReason: { lunch: 5 },
  });
}

describe('the health strip shows one diagnosis, and it is the right one', () => {
  it('reports nothing when the campaign is dialing normally', () => {
    expect(campaignHealth(healthy())).toEqual({ stall: null, other_stalls: [] });
  });

  it('ranks by ACTION when several conditions are true at once', () => {
    const { stall, other_stalls } = campaignHealth(everythingWrong());

    // The compliance stop wins. A supervisor who reads "no agents available"
    // first goes and finds staff for a campaign that is paused for a regulatory
    // reason and will not dial regardless.
    expect(stall?.code).toBe('auto_paused_abandonment');

    expect(other_stalls).toEqual([
      'dnc_unavailable',
      'no_agents_available',
      'concurrency_saturated',
      'list_exhausted_retries_pending',
      'elevated_failure_rate',
    ]);
  });

  it('orders `other_stalls` by the exported priority, not by evaluation order', () => {
    // The branches in the assembler happen to be written in priority order today.
    // This asserts the OUTPUT is sorted by `AGENCY_STALL_PRIORITY`, so reordering
    // those branches cannot silently change which diagnosis a supervisor sees.
    const codes = diagnoseAll(everythingWrong()).map((s) => s.code);
    const byPriority = [...codes].sort(
      (a, b) => AGENCY_STALL_PRIORITY.indexOf(a) - AGENCY_STALL_PRIORITY.indexOf(b),
    );
    expect(codes).toEqual(byPriority);
  });

  it('never emits `credits_low` — core holds no balance', () => {
    // `AD-P4-C-04` applied to a union. Master owns the balance and inserts this
    // arm when proxying; a branch here would be a declared-but-unproducible code
    // that reads as reachable to the console and to the compiler.
    const emitted = new Set<AgencyStallCode>(diagnoseAll(everythingWrong()).map((s) => s.code));
    expect((emitted as Set<string>).has('credits_low')).toBe(false);
    // PORT NOTE (magick-agency): core also asserted against `AGENCY_CORE_STALL_CODES`,
    // the subset core could produce. That list existed to state the core-vs-master
    // producer split and is folded into the contract's one list now
    // (`packages/contracts/PORTING.md`): with `credits_low` removed, every code is
    // produced here, so the priority list IS the producible set.
    expect(AGENCY_STALL_PRIORITY as readonly string[]).not.toContain('credits_low');
    // And the split is exhaustive the other way: every code this module CAN emit is
    // in the priority list, so nothing can be emitted that the console cannot rank.
    for (const code of emitted) {
      expect(AGENCY_STALL_PRIORITY).toContain(code);
    }
  });
});

describe('evidence, and the refusals', () => {
  it('carries the FROZEN abandonment rate, not a live one', () => {
    const { stall } = campaignHealth(healthy({
      campaign: campaign({
        pause_reason: 'abandonment_ceiling',
        pause_abandonment_rate_pct: 3.4,
        abandonment_ceiling_pct: 3,
        paused_at: new Date('2026-08-14T09:00:00Z'),
      }),
    }));
    expect(stall).toEqual({
      code: 'auto_paused_abandonment',
      measured_pct: 3.4,
      ceiling_pct: 3,
      paused_at: '2026-08-14T09:00:00.000Z',
    });
  });

  it('a supervisor pause is NOT an abandonment stall', () => {
    // Both write `paused`; only one is a compliance event. Keying on the status
    // rather than the reason would tell a supervisor their own deliberate pause
    // was a regulatory breach.
    expect(campaignHealth(healthy({
      campaign: campaign({ status: 'paused', pause_reason: 'supervisor', paused_at: new Date() }),
    })).stall).toBeNull();
  });

  it('treats an unreadable concurrency counter as unknown, never as saturated', () => {
    const { stall } = campaignHealth(healthy({ concurrencyInUse: null, concurrencyLimit: 5 }));
    expect(stall).toBeNull();
  });

  it('MAG-146: a limit of 0 is "no known ceiling", never saturation', () => {
    // `agency-campaigns.routes.ts` falls `concurrencyLimit` back to `0` when the
    // `account_settings` read degrades, and the route's own comment says `0` is
    // chosen BECAUSE `saturated()` reads it as "no known ceiling" — never a real
    // account limit (both write paths that can ever set
    // `account_settings.max_concurrent_calls`, `account-settings.routes.ts` and
    // `internal.routes.ts`'s `legacy_total` mode, enforce a Zod `min(1)`, so `0`
    // is unreachable as a genuine configured limit and is safe to reserve as the
    // sentinel).
    //
    // Without `limit > 0` in `saturated()`, a degraded settings read plus ANY
    // known non-zero in-use count satisfies `in_use >= 0` and the strip reports
    // `concurrency_saturated` — a diagnosis whose own header says has no action
    // (D10/CR-2: no setter, contact support) — for a ceiling that was never
    // measured, let alone reached. Deleting `limit > 0` from `saturated()` must
    // turn this test red.
    const { stall, other_stalls } = campaignHealth(healthy({
      concurrencyLimit: 0,
      concurrencyInUse: 7,
    }));
    expect(stall?.code).not.toBe('concurrency_saturated');
    expect(other_stalls).not.toContain('concurrency_saturated');
  });

  it('MAG-146: a negative limit is unreachable through any validated write, but the guard would cover it too', () => {
    // `account_settings.max_concurrent_calls` has no DB-level CHECK, and the
    // sentinel's safety rests on no write path being able to produce `0` or
    // less. There are THREE such paths, not two, and the third does not get
    // there by Zod:
    //
    //  1. `account-settings.routes.ts:69` — refuses concurrency changes outright.
    //  2. `internal.routes.ts` `legacy_total` mode — Zod `min(1)`.
    //  3. `internal.routes.ts:252` `provider_breakdown` mode →
    //     `providerConcurrencyRepository.replaceProviderBreakdown()`, which
    //     writes `SUM(providers[].max_concurrent_calls)` into the column. Its
    //     per-provider Zod floor is **`min(0)`**, so the sum's floor is held by
    //     a hand-written `if (total < 1 || total > 1000)` at
    //     `internal.routes.ts:228` — an imperative check, not a schema.
    //
    // So "every Zod schema enforces a minimum" is false for the path that comes
    // closest to writing the sentinel. The conclusion still holds — 0 and
    // negative are both unreachable today — but it holds because of one `if`.
    // Delete or refactor that check and `[{ max_concurrent_calls: 0 }]` writes a
    // genuine configured `0`, at which point `saturated()` reads a real
    // zero-capacity account as "no known ceiling" and goes permanently silent on
    // the one diagnosis that would explain why nothing is dialing.
    //
    // Note the sibling CHECK sometimes cited as precedent, migration `070:47`,
    // is `>= 0` — it permits zero too.
    const { stall, other_stalls } = campaignHealth(healthy({
      concurrencyLimit: -1,
      concurrencyInUse: 7,
    }));
    // Both sides. `concurrency_saturated` is 4th of 8 in AGENCY_STALL_PRIORITY,
    // so asserting only on `stall?.code` lets any higher-priority diagnosis
    // firing on the fixture push it into `other_stalls`, where a one-sided
    // assertion cannot see it — and the test passes with the guard deleted.
    expect(stall?.code).not.toBe('concurrency_saturated');
    expect(other_stalls).not.toContain('concurrency_saturated');
  });

  it('still reports real saturation once a positive limit is actually reached', () => {
    // The guard's other side: `limit > 0` must not swallow genuine saturation.
    const { stall } = campaignHealth(healthy({ concurrencyLimit: 5, concurrencyInUse: 5 }));
    expect(stall?.code).toBe('concurrency_saturated');
  });

  it('MAG-146: list_exhausted_retries_pending needs retries_pending > 0, not just an empty list', () => {
    // Found while re-checking `diagnoseAll` for the same unasserted-guard shape
    // (ticket acceptance criterion 4). `stats.contacts_pending === 0 &&
    // stats.retries_pending > 0` has the same COVERAGE SHAPE as `saturated()`'s
    // guard — an AND clause nothing exercised — though not the same anatomy:
    // `limit = 0` is a manufactured sentinel meaning "unknown", while
    // `retries_pending = 0` is a real and truthful measurement. Deleting
    // `stats.retries_pending > 0` left every existing
    // test green: the two tests that reach `contacts_pending: 0` both also set a
    // non-zero `retries_pending`, so nothing ever exercised the "list exhausted
    // AND nothing scheduled" case. Without the guard, a campaign with an empty
    // list and an empty retry queue — §5.3's actual "complete", not "exhausted
    // with retries pending" — would report `list_exhausted_retries_pending` with
    // `retries_pending: 0`, which is the diagnosis this guard exists to prevent.
    const { stall, other_stalls } = campaignHealth(healthy({
      stats: {
        contacts_pending: 0, retries_pending: 0, agents_live: 3,
        agents_by_state: {
          offline: 0, available: 2, reserved: 0, on_call: 1, wrapup: 0, break: 0,
        },
      } as unknown as CampaignHealthInputs['stats'],
    }));
    // Both sides — this code is 6th of 8 in AGENCY_STALL_PRIORITY, so it is even
    // easier to displace into `other_stalls` than `concurrency_saturated` is. A
    // one-sided assertion here passes with the guard deleted the moment anything
    // higher-priority fires on the fixture.
    expect(stall?.code).not.toBe('list_exhausted_retries_pending');
    expect(other_stalls).not.toContain('list_exhausted_retries_pending');
  });

  it('does not blame staffing when nobody is on shift at all', () => {
    // Zero agents on shift is an empty campaign, not a stalled one — §C.6 gives it
    // its own EmptyState with the station URL to share. Reporting "dialing has
    // stalled — no agents are available" for a campaign nobody has joined sends a
    // supervisor looking for a fault that is really a setup step.
    const { stall } = campaignHealth(healthy({
      stats: {
        contacts_pending: 50, retries_pending: 0, agents_live: 0,
        agents_by_state: {
          offline: 0, available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0,
        },
      } as unknown as CampaignHealthInputs['stats'],
    }));
    expect(stall).toBeNull();
  });

  it('an agent mid-reservation still counts as capacity', () => {
    // `reserved` is a live agent about to receive a call. Counting only
    // `available` would flap the diagnosis on and off every pacing tick.
    const { stall } = campaignHealth(healthy({
      stats: {
        contacts_pending: 50, retries_pending: 0, agents_live: 2,
        agents_by_state: {
          offline: 0, available: 0, reserved: 1, on_call: 1, wrapup: 0, break: 0,
        },
      } as unknown as CampaignHealthInputs['stats'],
    }));
    expect(stall).toBeNull();
  });

  it('only reports calling hours when EVERYTHING waiting is shut out', () => {
    // 20 of 50 outside the window is a partially-dialable campaign, not a stall.
    expect(campaignHealth(healthy({ contactsOutsideCallingHours: 20 })).stall).toBeNull();

    const { stall } = campaignHealth(healthy({
      contactsOutsideCallingHours: 50,
      nextCallingWindowOpensAt: new Date('2026-08-15T09:00:00.000Z'),
    }));
    expect(stall).toEqual({
      code: 'outside_calling_hours',
      contacts_waiting: 50,
      next_window_opens_at: '2026-08-15T09:00:00.000Z',
    });
  });

  it('still reports it when every waiting contact is in RETRY BACKOFF, not due', () => {
    // The overnight case, at the assembler. The pre-dial gate defers an
    // out-of-hours contact by pushing `next_attempt_at` to the next window-open
    // instant, so after one pacing pass nothing on the roster is due and every
    // pending contact counts as a "retry". Both numbers must still describe the
    // same 50 contacts, or the one diagnosis that explains a silent overnight
    // campaign is the one that cannot fire.
    const { stall } = campaignHealth(healthy({
      stats: {
        contacts_pending: 50, retries_pending: 50, agents_live: 3,
        agents_by_state: {
          offline: 0, available: 2, reserved: 0, on_call: 1, wrapup: 0, break: 0,
        },
      } as unknown as CampaignHealthInputs['stats'],
      contactsOutsideCallingHours: 50,
      nextCallingWindowOpensAt: new Date('2026-08-15T09:00:00.000Z'),
    }));
    expect(stall?.code).toBe('outside_calling_hours');
  });

  it('outranks calling hours over the retry diagnosis that would otherwise mask it', () => {
    // `contacts_pending: 0` with retries scheduled is §5.3's "list exhausted".
    // Calling hours sits ABOVE it in `AGENCY_STALL_PRIORITY`, so a campaign shut
    // out overnight reads as shut out overnight and not as finished-but-waiting —
    // the two need different actions from the supervisor (none, versus none until
    // 9am, which is the difference between "should I be worried" and "no").
    const { stall, other_stalls } = campaignHealth(healthy({
      stats: {
        contacts_pending: 0, retries_pending: 40, agents_live: 3,
        agents_by_state: {
          offline: 0, available: 2, reserved: 0, on_call: 1, wrapup: 0, break: 0,
        },
      } as unknown as CampaignHealthInputs['stats'],
      contactsOutsideCallingHours: 40,
      nextCallingWindowOpensAt: new Date('2026-08-15T09:00:00.000Z'),
      nextRetryAt: new Date('2026-08-15T09:00:00.000Z'),
    }));
    expect(stall?.code).toBe('outside_calling_hours');
    expect(other_stalls).toEqual(['list_exhausted_retries_pending']);
  });

  it('separates "list exhausted, retries scheduled" from "complete" (§5.3)', () => {
    const { stall } = campaignHealth(healthy({
      stats: {
        contacts_pending: 0, retries_pending: 312, agents_live: 3,
        agents_by_state: {
          offline: 0, available: 2, reserved: 0, on_call: 1, wrapup: 0, break: 0,
        },
      } as unknown as CampaignHealthInputs['stats'],
      nextRetryAt: new Date('2026-08-14T15:40:00Z'),
    }));
    expect(stall).toEqual({
      code: 'list_exhausted_retries_pending',
      retries_pending: 312,
      next_retry_at: '2026-08-14T15:40:00.000Z',
    });
  });

  it('will not call a handful of dials an elevated failure rate', () => {
    // 3 of 4 failed is 75%, well over the threshold — and meaningless. Without the
    // floor the strip cries wolf on its lowest-priority diagnosis in the first
    // minute of every campaign, which is how supervisors learn to ignore it.
    const belowFloor = ELEVATED_FAILURE_MIN_ATTEMPTS - 1;
    expect(campaignHealth(healthy({
      recentFailures: { attempts: belowFloor, failed: belowFloor, windowMinutes: 10 },
    })).stall).toBeNull();
  });

  it('names the window it measured, so the copy cannot lie about it', () => {
    const { stall } = campaignHealth(healthy({
      recentFailures: { attempts: 50, failed: 19, windowMinutes: RECENT_FAILURE_WINDOW_MINUTES },
    }));
    expect(stall).toEqual({
      code: 'elevated_failure_rate',
      failed_pct: 38,
      attempts: 50,
      window_minutes: RECENT_FAILURE_WINDOW_MINUTES,
    });
  });
});
