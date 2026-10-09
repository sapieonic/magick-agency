import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_CODES,
  DEFAULT_DISPOSITION_RETRY,
  DEFAULT_DISPOSITIONS,
  DISPOSITION_FLAGS,
  dispositionSummary,
  slugifyCode,
  EMPTY_CAMPAIGN_CONFIG,
  FIXED_ZERO_OUTCOMES,
  OUR_FAULT_REDIAL_BOUND,
  OUR_FAULT_RETRY_COPY,
  OUR_FAULT_RETRY_DEFAULT,
  OUR_FAULT_RETRY_OUTCOMES,
  OUR_FAULT_ZERO_WARNING,
  OUTCOME_LABELS,
  RETRY_OUTCOMES,
  buildConfigPayload,
  callingWindowEcho,
  configBlockReason,
  configFromCampaign,
  describeDays,
  emptyCampaignConfig,
  fieldErrorsFromResponse,
  isBuiltInCode,
  isUsableTimezone,
  retryPreview,
  validateConfig,
  type CampaignConfigState,
} from '../../utils/agencyCampaignConfigForm';
import type { AgencyCampaign, AgencyRetryOutcome } from '../../types/agency-campaign';

/**
 * `AD-P3-U-02`: (a) built-in codes cannot be deleted and the reason is explained
 * inline; (b) server validation errors map to the offending field; (c) the form
 * round-trips an existing campaign without loss.
 */

function config(over: Partial<CampaignConfigState> = {}): CampaignConfigState {
  return {
    ...EMPTY_CAMPAIGN_CONFIG,
    dispositions: EMPTY_CAMPAIGN_CONFIG.dispositions.map((entry) => ({ ...entry })),
    window: { ...EMPTY_CAMPAIGN_CONFIG.window },
    ...over,
  };
}

describe('the built-in codes', () => {
  it('names exactly the three §2.4 codes', () => {
    expect([...BUILT_IN_CODES]).toEqual(['voicemail', 'callback', 'do_not_call']);
    for (const code of BUILT_IN_CODES) expect(isBuiltInCode(code)).toBe(true);
    expect(isBuiltInCode('promised_to_pay')).toBe(false);
  });

  it('seeds a new campaign with them, matching what master defaults to', () => {
    expect(EMPTY_CAMPAIGN_CONFIG.dispositions.map((entry) => entry.code)).toEqual([
      ...BUILT_IN_CODES,
    ]);
    // The flags are what every mechanism actually keys on — not the code string.
    expect(EMPTY_CAMPAIGN_CONFIG.dispositions[1]!.requires_datetime).toBe(true);
    expect(EMPTY_CAMPAIGN_CONFIG.dispositions[2]!.suppress).toBe(true);
  });

  it('gives do_not_call `suppress` and NOT `terminal`, matching core and master', () => {
    /**
     * The three copies of this catalog have to agree and cannot share a
     * constant, so this is the only thing stopping them drifting.
     *
     * `terminal` was the flag this copy added and neither of the others has.
     * Core's `resolveDispositionDecision` reads `suppress` first and returns
     * from that arm, so on this entry `terminal` can never be observed — and if
     * an operator ever clears `suppress`, the leftover flag downgrades the
     * contact from `suppressed` to the weaker `completed`. It is `suppress`, not
     * `terminal`, that stops the number being dialed again.
     */
    const dnc = DEFAULT_DISPOSITIONS.find((entry) => entry.code === 'do_not_call')!;
    expect(dnc.suppress).toBe(true);
    expect('terminal' in dnc).toBe(false);
    expect(dnc).toEqual({ code: 'do_not_call', label: 'Do not call', suppress: true });
  });
});

describe('catalog copies are independent, now that a retry rule can be edited', () => {
  /**
   * `EMPTY_CAMPAIGN_CONFIG` and `configFromCampaign` both used a shallow
   * `{ ...entry }`, which shares the `retry` OBJECT with `DEFAULT_DISPOSITIONS`
   * — a module-level constant every form in the app then held a reference into.
   * Nothing mutated it while the rule had no editor. One now exists.
   */
  it('gives every config its own retry object, not a reference to the default', () => {
    const a = EMPTY_CAMPAIGN_CONFIG.dispositions[0]!;
    expect(a.retry).toEqual(DEFAULT_DISPOSITIONS[0]!.retry);
    expect(a.retry).not.toBe(DEFAULT_DISPOSITIONS[0]!.retry);

    // …and two builders started from the factory share nothing at all — the
    // singleton itself is what `useState` used to be handed.
    const one = emptyCampaignConfig();
    const two = emptyCampaignConfig();
    expect(one.dispositions[0]!.retry).toEqual(two.dispositions[0]!.retry);
    expect(one.dispositions[0]!.retry).not.toBe(two.dispositions[0]!.retry);
    expect(one.dispositions).not.toBe(EMPTY_CAMPAIGN_CONFIG.dispositions);
    expect(one.window.days).not.toBe(EMPTY_CAMPAIGN_CONFIG.window.days);
  });

  it('does not hand a loaded campaign a reference into the campaign object', () => {
    const campaign = {
      id: 'camp-1',
      name: 'Collections',
      status: 'draft' as const,
      disposition_catalog: [{ code: 'sale', label: 'Sale', retry: { max_attempts: 2 } }],
    };
    const state = configFromCampaign(campaign);
    expect(state.dispositions[0]!.retry).not.toBe(campaign.disposition_catalog[0]!.retry);
    // …and the payload it builds is likewise not a reference back into the form.
    const payload = buildConfigPayload(state);
    expect(payload.disposition_catalog![0]!.retry).not.toBe(state.dispositions[0]!.retry);
    expect(payload.disposition_catalog![0]!.retry).toEqual({ max_attempts: 2 });
  });

  it('seeds a switched-on retry from core’s own voicemail rule', () => {
    // Named rather than a literal in the component: seeding `max_attempts: 0`
    // would be a rule the engine ignores, so the control would appear inert.
    expect(DEFAULT_DISPOSITION_RETRY).toEqual({ delay_minutes: 240, max_attempts: 2 });
    expect(DEFAULT_DISPOSITIONS.find((e) => e.code === 'voicemail')!.retry)
      .toEqual(DEFAULT_DISPOSITION_RETRY);
  });
});

describe('the outcome card’s own copy', () => {
  /**
   * The five flags used to be five bare checkbox labels. "Ends this contact"
   * and "Stops calling this contact" sat side by side reading like the same
   * setting worded twice, and they are not: `terminal` finishes the contact on
   * this campaign, `suppress` suppresses them outright and wins the precedence
   * check outright. Every tile therefore has to carry the sentence that says
   * which of the two it is.
   */
  it('gives every flag a blurb, and covers exactly the entry’s flags', () => {
    expect(DISPOSITION_FLAGS.map((f) => f.flag)).toEqual([
      'is_success',
      'requires_note',
      'requires_datetime',
      'terminal',
      'suppress',
    ]);
    for (const { title, blurb } of DISPOSITION_FLAGS) {
      expect(title.length).toBeGreaterThan(0);
      // A tile with a title and no explanation is the row this replaced.
      expect(blurb.length).toBeGreaterThan(20);
    }
  });

  describe('slugifyCode', () => {
    it('turns a label into a code the validator accepts', () => {
      const state = config({
        dispositions: [{ code: slugifyCode('Promised to pay'), label: 'Promised to pay' }],
      });
      expect(slugifyCode('Promised to pay')).toBe('promised_to_pay');
      expect(validateConfig(state)['disposition_catalog[0].code']).toBeUndefined();
    });

    it('strips punctuation, case and edge underscores rather than emitting an illegal code', () => {
      expect(slugifyCode('  Won’t pay — refused!  ')).toBe('won_t_pay_refused');
      // NFKD runs before the case fold: '№' expands to 'No', and folding first
      // left the capital to be stripped as punctuation.
      expect(slugifyCode('Café №2')).toBe('cafe_no2');
    });

    it('never exceeds the 50 characters master allows, and never ends on an underscore', () => {
      const code = slugifyCode('a'.repeat(48) + ' bcdef');
      expect(code.length).toBeLessThanOrEqual(50);
      expect(code.endsWith('_')).toBe(false);
      expect(validateConfig(config({ dispositions: [{ code, label: 'x' }] }))[
        'disposition_catalog[0].code'
      ]).toBeUndefined();
    });

    it('returns empty for a label with nothing usable in it, rather than a placeholder', () => {
      // The field stays empty and fails validation, which is honest. Filling it
      // with something the operator did not choose is not.
      expect(slugifyCode('—  !!')).toBe('');
    });
  });

  describe('dispositionSummary', () => {
    /**
     * The echo exists for the same reason `callingWindowEcho` does: the
     * combination is what the operator configured and no single control shows
     * it.
     */
    it('states the contact’s fate even in the plain case', () => {
      // An absent sentence reads as "nothing happens", which is a different
      // configuration from "stays in the queue".
      expect(dispositionSummary({ code: 'sale', label: 'Sale' })).toBe(
        'The contact stays in the queue with its remaining attempts. It does not count as a success.',
      );
    });

    it('names both things the agent is made to do', () => {
      const summary = dispositionSummary({
        code: 'callback',
        label: 'Callback',
        requires_note: true,
        requires_datetime: true,
        is_success: true,
      });
      expect(summary).toContain('type a note and pick a date and time to call back');
      expect(summary).toContain('It counts as a success.');
    });

    it('reports suppress rather than terminal when both are set, matching core’s precedence', () => {
      // `resolveDispositionDecision` checks suppress first and returns, so a
      // summary that reported "finished on this campaign" would be describing
      // the arm that cannot run.
      const summary = dispositionSummary({
        code: 'do_not_call',
        label: 'Do not call',
        suppress: true,
        terminal: true,
      });
      expect(summary).toContain('suppressed');
      expect(summary).not.toContain('finished on this campaign');
    });

    it('reads the disposition’s own retry rule, which nothing on screen used to show', () => {
      const voicemail = DEFAULT_DISPOSITIONS.find((entry) => entry.code === 'voicemail')!;
      // The default entry has carried this 4-hour, twice rule all along.
      expect(dispositionSummary(voicemail)).toContain('every 4 hours, up to 2 times');
    });

    it('does not promise a retry from a rule that can never fire', () => {
      const summary = dispositionSummary({
        code: 'sale',
        label: 'Sale',
        retry: { max_attempts: 0, delay_minutes: 30 },
      });
      expect(summary).toContain('stays in the queue');
      expect(summary).not.toContain('every 30 minutes');
    });

    it('says a callback keeps its place, rather than claiming remaining attempts', () => {
      const summary = dispositionSummary({
        code: 'callback',
        label: 'Callback',
        requires_datetime: true,
      });
      expect(summary).toContain('keeps its place in the queue until that time comes round');
    });
  });
});

describe('wrap-up auto-return', () => {
  /**
   * Core has stored `wrapup_auto_return` since migration 072 and reads it in
   * `wrapup-manager.ts` — `false` holds the agent in wrap-up until they mark
   * themselves ready. The form hardcoded it and never sent it, so every campaign
   * ran on the column default and no operator could change it.
   */
  it('sends the flag on every save, including when it is true', () => {
    // `true` matters as much as `false`: with the key omitted from the payload,
    // an operator who turned auto-return off could never turn it back on.
    expect(buildConfigPayload(config({ autoReturn: true })).wrapup_auto_return).toBe(true);
    expect(buildConfigPayload(config({ autoReturn: false })).wrapup_auto_return).toBe(false);
  });

  it('loads a campaign that holds agents until they click, rather than re-seeding true', () => {
    const state = configFromCampaign({
      id: 'camp-1',
      name: 'Collections',
      status: 'running',
      wrapup_auto_return: false,
    });
    expect(state.autoReturn).toBe(false);
    // The whole round trip, because a load that reads `false` and a save that
    // writes `true` back is the same bug one step later.
    expect(buildConfigPayload(state).wrapup_auto_return).toBe(false);
  });

  it('falls back to core’s own default when the campaign does not carry the field', () => {
    const state = configFromCampaign({ id: 'camp-1', name: 'Collections', status: 'draft' });
    expect(state.autoReturn).toBe(true);
  });
});

describe('validation, keyed exactly as master keys its details', () => {
  it('accepts the default configuration', () => {
    expect(validateConfig(config())).toEqual({});
    expect(configBlockReason(config())).toBeNull();
  });

  it('refuses a duplicate disposition code, naming the entry', () => {
    const state = config({
      dispositions: [
        { code: 'callback', label: 'Callback' },
        { code: 'callback', label: 'Call back later' },
      ],
    });
    // `find()` is first-wins and silent: the operator's second entry, with its
    // own flags, would simply never apply.
    expect(validateConfig(state)['disposition_catalog[1].code']).toContain('already used');
  });

  it('refuses a code that differs only in case', () => {
    const state = config({ dispositions: [{ code: 'Callback', label: 'Callback' }] });
    expect(validateConfig(state)['disposition_catalog[0].code']).toBeTruthy();
  });

  it('refuses an unlabelled outcome — the agent reads the label off a button', () => {
    const state = config({ dispositions: [{ code: 'callback', label: '   ' }] });
    expect(validateConfig(state)['disposition_catalog[0].label']).toBeTruthy();
  });

  it('requires max_attempts on a retry rule rather than defaulting it', () => {
    // A rule with no max_attempts reaches the retry engine as undefined and
    // every comparison against it is false — the configured retry never fires.
    const state = config({ retryPolicy: { no_answer: { delay_minutes: 60 } as never } });
    expect(validateConfig(state)['retry_policy.no_answer.max_attempts']).toBeTruthy();
  });

  it('bounds the retry delay at 30 days', () => {
    const ok = config({ retryPolicy: { busy: { delay_minutes: 43_200, max_attempts: 2 } } });
    expect(validateConfig(ok)).toEqual({});
    const over = config({ retryPolicy: { busy: { delay_minutes: 43_201, max_attempts: 2 } } });
    expect(validateConfig(over)['retry_policy.busy.delay_minutes']).toBeTruthy();
  });

  it('refuses a window that starts and ends at the same time', () => {
    // Core reads start === end as permanently closed, not as 24 hours: a
    // saveable campaign that can never dial.
    const state = config({ window: { ...EMPTY_CAMPAIGN_CONFIG.window, start: '09:00', end: '09:00' } });
    expect(validateConfig(state)['calling_window_end']).toContain('never dial');
  });

  it('refuses HH:MM and HH:MM:SS forms of the SAME time, not just identical strings', () => {
    // Postgres renders TIME as HH:MM:SS, so an edit-then-save round trip mixes
    // the two in one body and a raw string comparison lets the pair through.
    const state = config({
      window: { ...EMPTY_CAMPAIGN_CONFIG.window, start: '09:00', end: '09:00:00' },
    });
    expect(validateConfig(state)['calling_window_end']).toBeTruthy();
  });

  it('allows a window that wraps midnight', () => {
    const state = config({ window: { ...EMPTY_CAMPAIGN_CONFIG.window, start: '22:00', end: '06:00' } });
    expect(validateConfig(state)['calling_window_end']).toBeUndefined();
  });

  it('refuses an empty day set', () => {
    const state = config({ window: { ...EMPTY_CAMPAIGN_CONFIG.window, days: [] } });
    expect(validateConfig(state)['calling_days']).toContain('never dial');
  });

  it('refuses day 0 rather than reading it as Sunday', () => {
    // ISO-8601: 1 = Monday … 7 = Sunday. A caller sending 0 believes Postgres
    // `dow`, so accepting it means we and they disagree about which days run —
    // and the default Mon–Fri set is identical under both numberings, so the
    // ambiguity is undetectable by testing the default.
    const state = config({ window: { ...EMPTY_CAMPAIGN_CONFIG.window, days: [0, 1] } });
    expect(validateConfig(state)['calling_days']).toContain('ISO-8601');
  });
});

describe('the timezone gate', () => {
  it('accepts full IANA zones and exactly UTC', () => {
    expect(isUsableTimezone('Asia/Kolkata')).toBe(true);
    expect(isUsableTimezone('America/New_York')).toBe(true);
    expect(isUsableTimezone('UTC')).toBe(true);
  });

  it('refuses EST — which Intl accepts, resolving to a zone with no DST', () => {
    // The load-bearing case. `new Intl.DateTimeFormat(undefined, { timeZone:
    // 'EST' })` does not throw; ICU resolves it to America/Panama. A campaign
    // configured EST dials an hour early for half the year and tests clean
    // whenever anyone checks.
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: 'EST' })).not.toThrow();
    expect(isUsableTimezone('EST')).toBe(false);
    expect(isUsableTimezone('IST')).toBe(false);
  });

  it('refuses a well-shaped zone that does not exist', () => {
    expect(isUsableTimezone('Made/Up')).toBe(false);
  });

  it('surfaces the reason on the field', () => {
    const state = config({ window: { ...EMPTY_CAMPAIGN_CONFIG.window, timezone: 'EST' } });
    expect(validateConfig(state)['default_timezone']).toContain('daylight saving');
  });
});

describe('the calling-window echo', () => {
  const WINDOW = { start: '09:00', end: '20:00', days: [1, 2, 3, 4, 5], timezone: 'Asia/Kolkata' };

  it('says the campaign would be dialing at a time inside the window', () => {
    // 2026-08-11 is a Tuesday. 09:00 UTC is 14:30 in Asia/Kolkata — inside.
    const echo = callingWindowEcho(WINDOW, new Date('2026-08-11T09:00:00Z'));
    expect(echo).toContain('14:30');
    expect(echo).toContain('would be dialing');
  });

  it('is evaluated ON the window boundary, not near it', () => {
    // Chosen to sit exactly at the close: 20:00 IST = 14:30 UTC. A test picked
    // at an arbitrary hour cannot observe an off-by-one at the edge, which is
    // the only place this logic can be wrong.
    const openEdge = callingWindowEcho(WINDOW, new Date('2026-08-11T03:30:00Z')); // 09:00 IST
    expect(openEdge).toContain('would be dialing');

    const closeEdge = callingWindowEcho(WINDOW, new Date('2026-08-11T14:30:00Z')); // 20:00 IST
    expect(closeEdge).toContain('would not be dialing');
  });

  it('reads the day in the CAMPAIGN zone, not the browser one', () => {
    // 2026-08-16 21:00Z is a Sunday in UTC and Monday 02:30 in Asia/Kolkata.
    // Monday is a calling day; Sunday is not.
    const echo = callingWindowEcho(
      { ...WINDOW, start: '00:00', end: '06:00' },
      new Date('2026-08-16T21:00:00Z'),
    );
    expect(echo).toContain('would be dialing');
  });

  it('marks an overnight window as overnight', () => {
    const echo = callingWindowEcho({ ...WINDOW, start: '22:00', end: '06:00' });
    expect(echo).toContain('overnight');
  });

  it('does not claim a live status for a zone it cannot resolve', () => {
    const echo = callingWindowEcho({ ...WINDOW, timezone: 'EST' });
    expect(echo).not.toContain('would be dialing');
    expect(echo).not.toContain('would not be dialing');
  });

  it('describes contiguous days as a range and scattered ones as a list', () => {
    expect(describeDays([1, 2, 3, 4, 5])).toBe('Mon–Fri');
    expect(describeDays([1, 3, 5])).toBe('Mon, Wed, Fri');
    expect(describeDays([1, 2, 3, 4, 5, 6, 7])).toBe('Every day');
  });
});

describe('the retry preview', () => {
  it('says “not retried” for a zero policy rather than showing a delay', () => {
    expect(retryPreview('busy', undefined)).toContain('not retried');
    expect(retryPreview('busy', { max_attempts: 0, delay_minutes: 15 })).toContain('not retried');
  });

  it('reads as English for the ordinary case', () => {
    expect(retryPreview('busy', { delay_minutes: 15, max_attempts: 4 })).toBe(
      'Busy: retried every 15 minutes, up to 4 times.',
    );
    expect(retryPreview('no_answer', { delay_minutes: 60, max_attempts: 1 })).toBe(
      'No answer: retried every 1 hour, up to 1 time.',
    );
  });
});

/**
 * `MAG-100` (reopened): master added `agent_disconnected` and `orphaned` to
 * `RETRY_POLICY_OUTCOMES` and core ships real, non-zero defaults for both
 * (`retry-policy.ts`'s `DEFAULT_RETRY_POLICY`), but cusui's union and table
 * never followed — an operator could not tune the one lever that controls how
 * many of a customer's own retries an our-fault drop consumes.
 */
describe('the our-fault outcome — `agent_disconnected` (MAG-100, MAG-97)', () => {
  it('is in the table master and core both support', () => {
    expect(RETRY_OUTCOMES).toContain('agent_disconnected');
  });

  it('does NOT expose `orphaned` — core never reads a campaign\u2019s value for it', () => {
    /*
     * Master accepts the key and core ships a `DEFAULT_RETRY_POLICY` entry, which
     * is exactly what makes it look safe to expose. But the only producer that
     * consults a policy for `orphaned` is core\u2019s reaper, and it passes `null`
     * deliberately, taking only the bound; the dial path gates its policy read on
     * `outcome === 'agent_disconnected'`.
     *
     * So a row here would save, persist, reload — and change nothing. That is the
     * silently-inert class `NEVER_SENT_RETRY_OUTCOMES` exists to refuse, and the
     * first version of this feature shipped one.
     */
    expect(RETRY_OUTCOMES).not.toContain('orphaned');
    expect(OUR_FAULT_RETRY_OUTCOMES).not.toContain('orphaned');
  });

  it('is an editable row, NOT fixed at zero — core reads the configured cap', () => {
    // Unlike `invalid`/`connected`, this has no short-circuit in core: a
    // configured cap genuinely governs the outcome, so hiding the inputs
    // behind a fixed-zero cell would make the row lie about what it does.
    expect(FIXED_ZERO_OUTCOMES).not.toContain('agent_disconnected');
  });

  it('is named in `OUR_FAULT_RETRY_OUTCOMES`, so the callout knows which row it is about', () => {
    // `canceled` joined it after the 2026-09-08 pilot — see the block at the
    // foot of this file.
    // Asserted as an exact set rather than a `toContain` so a third member
    // cannot be added without someone deciding whether the shared callout and
    // the shared zero warning are still true of it.
    expect(OUR_FAULT_RETRY_OUTCOMES).toEqual(['agent_disconnected', 'canceled']);
  });

  it('is labelled as OUR fault, not the customer’s', () => {
    // The label is the fastest thing an operator reads — it has to say the
    // right thing without them opening the explanatory callout at all.
    expect(OUTCOME_LABELS.agent_disconnected).toContain('our fault');
  });

  it('tells the operator the bound can be LOWERED, which is the half that bites', () => {
    /*
     * The first version said the platform limit "cannot be raised from here" and
     * called it "smaller". Both misled. Core takes
     * `min(configured, OUR_FAULT_REDIAL_BOUND)`: the row cannot raise it, but it
     * CAN lower it — and the two are equal at 3, not smaller. An operator reading
     * that text would conclude the row could not affect the bound at all, and
     * then set it to 0.
     */
    expect(OUR_FAULT_RETRY_COPY).toMatch(/only LOWER it here, never raise it/);
    expect(OUR_FAULT_RETRY_COPY).not.toMatch(/smaller/);
    expect(OUR_FAULT_RETRY_COPY).toContain(String(OUR_FAULT_REDIAL_BOUND));
  });

  it('spells out what 0 actually does, because "0 attempts" does not convey it', () => {
    // Core retires the contact outright once `ourFaultAttemptsUsed >= 0` — it
    // does not merely skip a redial. Never dialed again, allowance unused.
    expect(OUR_FAULT_RETRY_COPY).toMatch(/retires that contact for good/);
    expect(OUR_FAULT_ZERO_WARNING).toMatch(/retires the contact permanently/);
  });

  it('previews an UNSET row as core’s default, not as "not retried"', () => {
    /*
     * The preview and the callout sat on the same screen saying opposite things:
     * the preview said "not retried", the callout said core retries anyway. The
     * preview was the wrong one — an absent key means core falls back to
     * `DEFAULT_RETRY_POLICY`, which is the whole reason the callout exists.
     */
    const preview = retryPreview('agent_disconnected', undefined);
    expect(preview).not.toContain('not retried');
    expect(preview).toContain('platform default');
    expect(preview).toContain(String(OUR_FAULT_RETRY_DEFAULT.max_attempts));
  });

  it('round-trip through load → save like any other outcome key', () => {
    const state = configFromCampaign({
      id: 'camp-1',
      name: 'Collections',
      status: 'running',
      retry_policy: {
        agent_disconnected: { delay_minutes: 5, max_attempts: 3 },
        // Still round-trips even though no row renders it: hydration is a spread,
        // so a key set out-of-band survives an unrelated save rather than being
        // silently dropped. Not exposing a control is not the same as erasing data.
        orphaned: { delay_minutes: 0, max_attempts: 3 },
      },
    });
    const payload = buildConfigPayload(state);
    expect(payload.retry_policy).toEqual({
      agent_disconnected: { delay_minutes: 5, max_attempts: 3 },
      orphaned: { delay_minutes: 0, max_attempts: 3 },
    });
  });

  it('preview like any other editable outcome, with no special-casing', () => {
    const outcome: AgencyRetryOutcome = 'agent_disconnected';
    expect(retryPreview(outcome, { delay_minutes: 5, max_attempts: 3 })).toBe(
      'Agent disconnected (our fault): retried every 5 minutes, up to 3 times.',
    );
    expect(retryPreview('orphaned', undefined)).toContain('not retried');
  });
});

/**
 * After the 2026-09-08 pilot, core gained a `canceled` outcome — a dial we
 * stopped before anyone picked up — master's `RETRY_POLICY_OUTCOMES` accepts the
 * key, and core's `resolveOurFaultRedial` genuinely reads a campaign's value for
 * it. That last clause is the whole argument for a row: it is the test
 * `orphaned` fails.
 */
describe('the third our-fault outcome — `canceled` (pilot 2026-09-08)', () => {
  it('is in the table, because core reads a campaign’s value for it', () => {
    /*
     * The distinction from `orphaned`, which master also accepts and which is
     * deliberately absent two describes up. A cancelled dial is never bridged,
     * so core's `ended` handler always routes it to `resolveOurFaultRedial`,
     * and that function reads `policy?.canceled` for a stricter cap and for the
     * delay. `orphaned`'s only producer passes `null` instead.
     */
    expect(RETRY_OUTCOMES).toContain('canceled');
  });

  it('is an editable row, NOT fixed at zero', () => {
    expect(FIXED_ZERO_OUTCOMES).not.toContain('canceled');
  });

  it('is labelled as OUR fault, and says WHEN the cancel happened', () => {
    // "Before answer" is what separates the row from `no_answer` two rows above
    // it — the customer letting it ring out. Without it an operator reads two
    // rows that sound like the same thing and tunes the wrong one.
    expect(OUTCOME_LABELS.canceled).toContain('our fault');
    expect(OUTCOME_LABELS.canceled).toContain('before answer');
  });

  it('previews an UNSET row as core’s our-fault fallback, not as "not retried"', () => {
    /*
     * Same defect the `agent_disconnected` case pins, arrived at differently:
     * `canceled` never reaches `DEFAULT_RETRY_POLICY` (core documents that entry
     * as unread), so an unset row falls back to
     * `DEFAULT_OUR_FAULT_REDIAL_DELAY_MINUTES` (5) and `OUR_FAULT_REDIAL_BOUND`
     * (3) — which is exactly `OUR_FAULT_RETRY_DEFAULT`. Saying "not retried"
     * would contradict the callout a few pixels below.
     */
    const preview = retryPreview('canceled', undefined);
    expect(preview).not.toContain('not retried');
    expect(preview).toContain('platform default');
    expect(preview).toContain(String(OUR_FAULT_RETRY_DEFAULT.max_attempts));
  });

  it('is SENT, unlike `invalid` — the key is live at master and at core', () => {
    const state = configFromCampaign({
      id: 'camp-1',
      name: 'Collections',
      status: 'running',
      retry_policy: { canceled: { delay_minutes: 0, max_attempts: 2 } },
    });

    expect(buildConfigPayload(state).retry_policy).toEqual({
      canceled: { delay_minutes: 0, max_attempts: 2 },
    });
  });

  it('shares the our-fault copy, which must be true of BOTH rows', () => {
    /*
     * One callout under one table, so it may not name only an agent-side drop —
     * it renders on the `canceled` row too. And the zero warning renders INSIDE
     * a row, where the row's own label names the failure, so naming
     * `agent_disconnected` in it was wrong on the row this change adds.
     */
    expect(OUR_FAULT_RETRY_COPY).toContain('before anyone picked up');
    expect(OUR_FAULT_ZERO_WARNING).not.toContain('agent-side');
  });
});

describe('round-tripping an existing campaign', () => {
  const CAMPAIGN: AgencyCampaign = {
    id: 'camp-1',
    name: 'Collections',
    status: 'running',
    disposition_catalog: [
      { code: 'voicemail', label: 'Voicemail', retry: { delay_minutes: 240, max_attempts: 2 } },
      { code: 'promised_to_pay', label: 'Promised to pay', is_success: true, requires_note: true },
    ],
    retry_policy: { no_answer: { delay_minutes: 45, max_attempts: 3 } },
    // Postgres renders a TIME column with seconds.
    calling_window_start: '09:30:00',
    calling_window_end: '20:00:00',
    calling_days: [1, 2, 3, 4, 5, 6],
    default_timezone: 'America/New_York',
    wrapup_seconds: 45,
  };

  it('loads every configured value, trimming the seconds a time input cannot show', () => {
    const state = configFromCampaign(CAMPAIGN);
    expect(state.window.start).toBe('09:30');
    expect(state.window.end).toBe('20:00');
    expect(state.window.days).toEqual([1, 2, 3, 4, 5, 6]);
    expect(state.window.timezone).toBe('America/New_York');
    expect(state.wrapupSeconds).toBe(45);
    expect(state.retryPolicy.no_answer).toEqual({ delay_minutes: 45, max_attempts: 3 });
  });

  it('keeps a custom disposition and its flags through load → save', () => {
    const payload = buildConfigPayload(configFromCampaign(CAMPAIGN));
    expect(payload.disposition_catalog).toEqual(CAMPAIGN.disposition_catalog);
    expect(payload.retry_policy).toEqual(CAMPAIGN.retry_policy);
    expect(payload.calling_days).toEqual(CAMPAIGN.calling_days);
    expect(payload.default_timezone).toBe('America/New_York');
    expect(payload.wrapup_seconds).toBe(45);
  });

  it('does not mutate the campaign it loaded from', () => {
    const state = configFromCampaign(CAMPAIGN);
    state.dispositions[0]!.label = 'Changed';
    state.window.days.push(7);
    expect(CAMPAIGN.disposition_catalog![0]!.label).toBe('Voicemail');
    expect(CAMPAIGN.calling_days).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('HEALS a stored `retry_policy.invalid`, dropping it on the next save (MAG-103)', () => {
    /**
     * MAG-103 made master refuse `retry_policy.invalid` — core suppresses an
     * unreachable number before any policy is read, so a rule on it can never
     * fire. This form cannot CREATE the key (it is a fixed-zero row with no
     * inputs), but it hydrates `retry_policy` as a lossless spread, so a campaign
     * that already carried the key from a direct API caller would be re-sent it
     * and would become UNSAVEABLE — and the 400 lands on a row that renders no
     * field error, so the operator would see a failed save with no cause and no
     * way to clear it.
     *
     * Dropping it on serialize makes that unreachable, and heals the stored row
     * on the next save the operator makes for any reason.
     */
    const legacy: AgencyCampaign = {
      ...CAMPAIGN,
      retry_policy: {
        no_answer: { delay_minutes: 45, max_attempts: 3 },
        invalid: { max_attempts: 3, delay_minutes: 10 },
        connected: { max_attempts: 0 },
      },
    };

    const payload = buildConfigPayload(configFromCampaign(legacy));

    // The inert key is gone…
    expect(payload.retry_policy).not.toHaveProperty('invalid');
    // …and `in` too, since `{invalid: undefined}` would still serialise as a key
    // and master would still refuse it.
    expect('invalid' in (payload.retry_policy as object)).toBe(false);

    // …while EVERY other key survives byte-for-byte. `AD-P3-U-02` acceptance (c)
    // still holds for everything else — trading one silent loss for another is
    // not a fix. `connected` in particular is NOT stripped: it has no
    // short-circuit in core, so its rule genuinely overrides the built-in.
    expect(payload.retry_policy).toEqual({
      no_answer: { delay_minutes: 45, max_attempts: 3 },
      connected: { max_attempts: 0 },
    });

    // And the rest of the body is untouched by the filter.
    expect(payload.disposition_catalog).toEqual(legacy.disposition_catalog);
    expect(payload.calling_days).toEqual(legacy.calling_days);
    expect(payload.wrapup_seconds).toBe(45);
  });

  it('does not mutate the campaign it healed', () => {
    // The filter must copy, not splice the loaded object — the caller still holds
    // the campaign it passed in, and a proxy that edits its own input is how a
    // form starts lying about what it loaded.
    const legacy: AgencyCampaign = {
      ...CAMPAIGN,
      retry_policy: { invalid: { max_attempts: 3 }, busy: { max_attempts: 2 } },
    };
    buildConfigPayload(configFromCampaign(legacy));

    expect(legacy.retry_policy).toHaveProperty('invalid');
  });

  it('sends an EMPTY retry policy as {} rather than omitting it', () => {
    // `{}` means "core's documented per-key defaults", not "retry nothing", and
    // it is the ORDINARY case — a campaign nobody configured retries for.
    const payload = buildConfigPayload(config({ retryPolicy: {} }));
    expect(payload.retry_policy).toEqual({});
    expect('retry_policy' in payload).toBe(true);
  });

  it('keeps an explicitly empty catalog, which is a legal configuration', () => {
    // An empty catalog means "agents do not disposition on this campaign", which
    // core supports on purpose. Silently re-seeding the built-ins would delete
    // that configuration.
    const payload = buildConfigPayload(config({ dispositions: [] }));
    expect(payload.disposition_catalog).toEqual([]);
  });
});

describe('mapping master’s validation answer onto fields', () => {
  it('reads the flat details record master sends', () => {
    const err = Object.assign(new Error('Validation Error'), {
      statusCode: 400,
      details: {
        error: 'Validation Error',
        details: {
          'calling_window_end': 'The calling window cannot start and end at the same time…',
          'disposition_catalog[0].code': "Duplicate disposition code 'callback'.",
        },
      },
    });
    const mapped = fieldErrorsFromResponse(err);
    expect(mapped['calling_window_end']).toContain('same time');
    expect(mapped['disposition_catalog[0].code']).toContain('Duplicate');
  });

  it('is keyed identically to the client-side finding for the same rule', () => {
    // The point of mirroring master's field paths: a rule only master knows
    // renders in the same place as one this module catches.
    const clientKey = Object.keys(
      validateConfig(config({ window: { ...EMPTY_CAMPAIGN_CONFIG.window, start: '09:00', end: '09:00' } })),
    );
    expect(clientKey).toContain('calling_window_end');
  });

  it('returns nothing for a masked or shapeless error rather than inventing a field', () => {
    expect(fieldErrorsFromResponse(new Error('boom'))).toEqual({});
    expect(fieldErrorsFromResponse({ details: { error: 'Internal Error' } })).toEqual({});
    expect(fieldErrorsFromResponse(null)).toEqual({});
  });
});
