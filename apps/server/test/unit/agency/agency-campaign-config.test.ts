import { describe, it, expect } from 'vitest';
import {
  validateAgencyCampaignConfig,
  withCampaignConfigDefaults,
  issuesToDetails,
  isUsableTimezone,
  DEFAULT_DISPOSITION_CATALOG,
  RETRY_POLICY_OUTCOMES,
} from '../../../src/agency/agency-campaign-config.js';

/** Field paths of every issue, so a case can name what it expects. */
function fields(body: unknown): string[] {
  return validateAgencyCampaignConfig(body).map((i) => i.field);
}
function messageFor(body: unknown, field: string): string | undefined {
  return validateAgencyCampaignConfig(body).find((i) => i.field === field)?.message;
}

describe('what the validator deliberately does NOT require', () => {
  it('accepts an EMPTY disposition catalog', () => {
    /**
     * Design §2.4 says `voicemail`, `callback` and `do_not_call` "cannot be
     * removed from a catalog … because the retry engine, the scheduler and the DNC
     * path each depend on one of them existing". They do not: each mechanism keys
     * on a FLAG — `entry.retry`, `entry.requires_datetime`, `entry.suppress` — and
     * the real DNC path is the dedicated `attempts/:id/dnc` route, which never
     * reads the catalog. Grepping core's `src/` for those three strings as
     * comparisons returns nothing outside the contract's prose.
     *
     * And core supports the empty catalog on purpose: `requiresDisposition` reads
     * it as "no codes to pick, so requiring one is a dead end". A required-codes
     * rule here would make a campaign whose agents do not disposition unsaveable.
     */
    expect(fields({ disposition_catalog: [] })).toEqual([]);
  });

  it('accepts a catalog WITHOUT voicemail, callback or do_not_call', () => {
    expect(fields({ disposition_catalog: [{ code: 'sale', label: 'Sale', terminal: true }] })).toEqual(
      [],
    );
  });

  it('accepts an EMPTY retry policy — the ordinary case, not an edge case', () => {
    // `agency_campaigns.retry_policy` defaults to `'{}'` and nothing seeds it, so
    // `{}` is what almost every campaign carries. Core's `DEFAULT_RETRY_POLICY`
    // falls back PER KEY, so it means "the documented defaults", not "retry
    // nothing".
    expect(fields({ retry_policy: {} })).toEqual([]);
  });

  it('accepts a partial retry policy — per-key fallback is the design', () => {
    expect(fields({ retry_policy: { busy: { delay_minutes: 5, max_attempts: 9 } } })).toEqual([]);
  });

  it('says nothing about fields the body does not carry', () => {
    // Serves PATCH as well as POST: a partial update must be able to touch one
    // field without being told about four it did not send.
    expect(fields({ name: 'Q3 outreach' })).toEqual([]);
    expect(fields({})).toEqual([]);
  });

  it('ignores a non-object body rather than throwing', () => {
    expect(fields(null)).toEqual([]);
    expect(fields('nope')).toEqual([]);
    expect(fields([1, 2])).toEqual([]);
  });
});

describe('the disposition catalog', () => {
  it('accepts §2.4\'s own example catalog verbatim', () => {
    // The design's block is the reference the builder is written against; a
    // validator that rejects it is wrong about something.
    expect(
      fields({
        disposition_catalog: [
          { code: 'sale', label: 'Sale', is_success: true, terminal: true },
          { code: 'callback', label: 'Callback', requires_datetime: true },
          { code: 'voicemail', label: 'Voicemail', retry: { delay_minutes: 240, max_attempts: 2 } },
          { code: 'not_interested', label: 'Not interested', terminal: true },
          { code: 'do_not_call', label: 'Do not call', suppress: true },
        ],
      }),
    ).toEqual([]);
  });

  it('rejects a duplicate code, which first-wins would hide', () => {
    const issues = validateAgencyCampaignConfig({
      disposition_catalog: [
        { code: 'sale', label: 'Sale' },
        { code: 'sale', label: 'Sale (upsell)', terminal: true },
      ],
    });

    // `find(c => c.code === x)` takes the first, silently, so the operator's
    // second entry and its flags simply never apply.
    expect(issues.map((i) => i.field)).toEqual(['disposition_catalog[1].code']);
    expect(issues[0]!.message).toContain("Duplicate");
  });

  it('rejects a code that differs from another only in case', () => {
    // The code is compared byte-for-byte at three boundaries — core's lookup on
    // submit, the console's pad, the retry engine's precedence check — so `Sale`
    // is a code core answers `unknown_disposition_code` to.
    expect(fields({ disposition_catalog: [{ code: 'Sale', label: 'Sale' }] })).toEqual([
      'disposition_catalog[0].code',
    ]);
  });

  it('rejects a missing or blank label — the agent reads it off a button', () => {
    expect(fields({ disposition_catalog: [{ code: 'sale' }] })).toEqual([
      'disposition_catalog[0].label',
    ]);
    expect(fields({ disposition_catalog: [{ code: 'sale', label: '   ' }] })).toEqual([
      'disposition_catalog[0].label',
    ]);
  });

  it('rejects a non-boolean flag', () => {
    expect(
      fields({ disposition_catalog: [{ code: 'sale', label: 'Sale', terminal: 'yes' }] }),
    ).toEqual(['disposition_catalog[0].terminal']);
  });

  it('requires max_attempts when a disposition carries a retry', () => {
    /**
     * The contract types `max_attempts` non-optional while the value arrives as
     * untyped JSON, so `retry: {}` reaches the retry engine as
     * `max_attempts: undefined` and every comparison against it is false. The
     * operator's configured voicemail retry then never fires once — configured,
     * stored, inert.
     */
    expect(
      fields({ disposition_catalog: [{ code: 'voicemail', label: 'VM', retry: {} }] }),
    ).toEqual(['disposition_catalog[0].retry.max_attempts']);
  });

  it('rejects a non-object retry', () => {
    expect(
      fields({ disposition_catalog: [{ code: 'voicemail', label: 'VM', retry: 3 }] }),
    ).toEqual(['disposition_catalog[0].retry']);
  });

  it('rejects an unknown field inside a retry rule', () => {
    // `retry: { delay_mins: 240, max_attempts: 2 }` stores fine and delays by
    // core's default rather than 240 — a typo that changes behaviour quietly.
    expect(
      fields({
        disposition_catalog: [
          { code: 'voicemail', label: 'VM', retry: { max_attempts: 2, delay_mins: 240 } },
        ],
      }),
    ).toEqual(['disposition_catalog[0].retry.delay_mins']);
  });

  it('rejects a non-array catalog and a non-object entry', () => {
    expect(fields({ disposition_catalog: {} })).toEqual(['disposition_catalog']);
    expect(fields({ disposition_catalog: ['sale'] })).toEqual(['disposition_catalog[0]']);
  });

  it('reports EVERY bad entry, not just the first', () => {
    const issues = fields({
      disposition_catalog: [
        { code: 'BAD', label: 'x' },
        { code: 'ok', label: '' },
      ],
    });

    // The builder renders issues against the fields at once; one-at-a-time makes
    // an operator fix a five-field form in five round trips.
    expect(issues).toEqual(['disposition_catalog[0].code', 'disposition_catalog[1].label']);
  });
});

describe('built-in semantic mismatch — a label that promises a behaviour it cannot deliver (`AD-P3-M-06`)', () => {
  /**
   * `AD-P3-M-04` settled that built-in codes are available, not force-merged,
   * and that is correct — but it creates this hazard rather than removing it.
   * Nothing keys on a disposition's code STRING; every mechanism keys on a
   * FLAG. `{ code: 'do_not_call', label: 'Do not call' }` with no
   * `suppress: true` is a button labelled "Do not call" that suppresses
   * nothing: the customer asks never to be called again, the agent clicks the
   * obvious control, and the contact is retried on schedule. Mirrors core's
   * `builtInSemanticMismatches()` (`disposition-policy.ts`), which detects the
   * same hazard but has zero consumers there — the fix belongs at the layer
   * that owns config validation, which is here.
   *
   * Blocking, not a warning — a mis-flagged built-in is pushed into `issues`,
   * which the route surfaces as a 400 on both POST and PATCH. That is a
   * deliberate departure from core's advisory-only stance: the failure mode is
   * a customer's do-not-call request being silently ignored, a regulated harm,
   * and this file is already the enforced feedback surface, not merely
   * advisory prose.
   */

  it("flags do_not_call with no suppress at all", () => {
    expect(
      fields({ disposition_catalog: [{ code: 'do_not_call', label: 'Do not call' }] }),
    ).toEqual(['disposition_catalog[0].suppress']);
  });

  it('flags do_not_call with suppress explicitly false — false is not the flag', () => {
    expect(
      fields({ disposition_catalog: [{ code: 'do_not_call', label: 'Do not call', suppress: false }] }),
    ).toEqual(['disposition_catalog[0].suppress']);
  });

  it('flags voicemail with no retry rule', () => {
    expect(
      fields({ disposition_catalog: [{ code: 'voicemail', label: 'Voicemail' }] }),
    ).toEqual(['disposition_catalog[0].retry']);
  });

  it('flags callback with no requires_datetime', () => {
    expect(
      fields({ disposition_catalog: [{ code: 'callback', label: 'Callback' }] }),
    ).toEqual(['disposition_catalog[0].requires_datetime']);
  });

  it('flags callback with requires_datetime explicitly false', () => {
    expect(
      fields({
        disposition_catalog: [{ code: 'callback', label: 'Callback', requires_datetime: false }],
      }),
    ).toEqual(['disposition_catalog[0].requires_datetime']);
  });

  it('names the code and the missing flag in the message, not just the field path', () => {
    const message = messageFor(
      { disposition_catalog: [{ code: 'do_not_call', label: 'Do not call' }] },
      'disposition_catalog[0].suppress',
    );
    expect(message).toContain('do_not_call');
    expect(message).toContain('suppress');
  });

  it('does NOT flag a built-in carrying the right flag, regardless of its VALUE', () => {
    // `voicemail` with `max_attempts: 1` instead of the default 2 is an
    // operator's business — only a MISSING flag is reported, never a
    // different value on the right one.
    expect(
      fields({
        disposition_catalog: [
          { code: 'voicemail', label: 'Voicemail', retry: { max_attempts: 1 } },
          { code: 'callback', label: 'Callback', requires_datetime: true },
          { code: 'do_not_call', label: 'Do not call', suppress: true },
        ],
      }),
    ).toEqual([]);
  });

  it('does NOT resurrect the withdrawn "built-ins are mandatory" rule — an empty catalog is still legal', () => {
    expect(fields({ disposition_catalog: [] })).toEqual([]);
  });

  it('does NOT flag a non-built-in code carrying no flags — a plain label is a valid disposition', () => {
    expect(
      fields({ disposition_catalog: [{ code: 'sale', label: 'Sale' }] }),
    ).toEqual([]);
  });

  it('does NOT flag a built-in code spelled with different case — codes compare byte-for-byte', () => {
    // 'DO_NOT_CALL' fails the lowercase `.code` rule already; it must not ALSO
    // gain a semantic-mismatch issue for a code this file cannot recognise as
    // the built-in (case-sensitivity is asserted elsewhere as `.code`'s own
    // rule — this test is about not double-counting, not about case rules).
    const issues = fields({
      disposition_catalog: [{ code: 'DO_NOT_CALL', label: 'Do not call' }],
    });
    expect(issues).toEqual(['disposition_catalog[0].code']);
  });

  it('reports a mismatch alongside other unrelated issues on the same entry', () => {
    const issues = fields({
      disposition_catalog: [{ code: 'do_not_call', label: '', suppress: false }],
    });
    expect(issues.sort()).toEqual(
      ['disposition_catalog[0].label', 'disposition_catalog[0].suppress'].sort(),
    );
  });
});

describe('the retry policy', () => {
  it('accepts every real outcome key', () => {
    const policy: Record<string, unknown> = {};
    for (const outcome of RETRY_POLICY_OUTCOMES) policy[outcome] = { max_attempts: 1 };

    expect(fields({ retry_policy: policy })).toEqual([]);
  });

  it('accepts §2.4\'s own policy block, less the one key MAG-103 refuses', () => {
    // What this case really guards is that the DOCUMENTED policy stays saveable —
    // a validator that rejects the design's own example is the bug. MAG-103
    // removes `invalid` from that example (it is inert: core suppresses an
    // unreachable number before any policy is read), so it is dropped here rather
    // than the case being deleted. `connected: {max_attempts: 0}` STAYS — it is a
    // live key that genuinely overrides core's built-in.
    expect(
      fields({
        retry_policy: {
          no_answer: { delay_minutes: 60, max_attempts: 3 },
          busy: { delay_minutes: 15, max_attempts: 4 },
          failed: { delay_minutes: 120, max_attempts: 2 },
          abandoned: { delay_minutes: 5, max_attempts: 2 },
          connected: { max_attempts: 0 },
        },
      }),
    ).toEqual([]);
  });

  it('rejects `machine`, and the message says WHY it would never fire', () => {
    const message = messageFor({ retry_policy: { machine: { max_attempts: 2 } } }, 'retry_policy.machine');

    /**
     * The highest-value rule in the file. With AMD off (D1) the system can never
     * classify an outcome as `machine` — a call answered by voicemail is
     * `connected`, because the carrier cannot tell us otherwise. So a `machine`
     * rule is not an ignored typo; it is a retry policy an operator configured,
     * saw stored, and which will never fire once. The message has to say that and
     * point at the disposition, or the operator retypes it.
     */
    expect(message).toContain('never');
    expect(message).toContain('voicemail');
    expect(message).toContain('connected');
  });

  it('rejects `voicemail` as a policy key for the same reason', () => {
    // The other name an operator reaches for. §2.4 puts voicemail retry on the
    // disposition, and there is no `voicemail` outcome to key a policy by.
    expect(fields({ retry_policy: { voicemail: { max_attempts: 2 } } })).toEqual([
      'retry_policy.voicemail',
    ]);
  });

  it('rejects an unknown key with the valid list, not a lecture', () => {
    const message = messageFor({ retry_policy: { nobody_home: { max_attempts: 1 } } }, 'retry_policy.nobody_home');

    expect(message).toContain('no_answer');
    expect(message).not.toContain('never fire');
  });

  it('requires max_attempts on each rule', () => {
    expect(fields({ retry_policy: { busy: { delay_minutes: 15 } } })).toEqual([
      'retry_policy.busy.max_attempts',
    ]);
  });

  it('accepts max_attempts: 0 — that is how an operator says "never retry"', () => {
    // §2.4's own block uses it for `connected`. Treating 0 as missing (a falsy
    // check instead of a presence check) would make the documented policy
    // unsaveable — that is what this case guards, and it is unrelated to MAG-103.
    // Re-keyed from `invalid` to `connected`, which carries the same
    // `{max_attempts: 0}` in §2.4 and is still a valid key.
    expect(fields({ retry_policy: { connected: { max_attempts: 0 } } })).toEqual([]);
    expect(fields({ retry_policy: { busy: { max_attempts: 0 } } })).toEqual([]);
  });

  it('rejects a fractional or negative max_attempts', () => {
    expect(fields({ retry_policy: { busy: { max_attempts: 2.5 } } })).toEqual([
      'retry_policy.busy.max_attempts',
    ]);
    expect(fields({ retry_policy: { busy: { max_attempts: -1 } } })).toEqual([
      'retry_policy.busy.max_attempts',
    ]);
  });

  it('bounds delay_minutes at 30 days', () => {
    expect(fields({ retry_policy: { busy: { max_attempts: 1, delay_minutes: 43_200 } } })).toEqual([]);
    // Beyond that a delay is indistinguishable from never, and a contact parked
    // for a year is worse than one marked exhausted.
    expect(fields({ retry_policy: { busy: { max_attempts: 1, delay_minutes: 43_201 } } })).toEqual([
      'retry_policy.busy.delay_minutes',
    ]);
  });

  it('rejects a non-object policy or rule', () => {
    expect(fields({ retry_policy: [] })).toEqual(['retry_policy']);
    expect(fields({ retry_policy: { busy: 3 } })).toEqual(['retry_policy.busy']);
  });
});

// ===========================================================================
// MAG-100 — `agent_disconnected` and `orphaned`
//
// Both keys are genuinely produced by core AND carry an entry in core's
// `DEFAULT_RETRY_POLICY` (MAG-97), so `resolveRetryDecision` really does act on a
// rule keyed by either. They were absent from master's list alone, so master 400'd
// a key core both accepts and honours.
//
// ⚠️ These cases are written with LITERAL key names on purpose. The existing
// "accepts every real outcome key" case iterates `RETRY_POLICY_OUTCOMES` itself,
// so it is self-referential — it would have passed unchanged both before and after
// this fix and proves nothing about which keys are in the list.
// ===========================================================================
describe('the retry policy: our-fault outcomes (MAG-100)', () => {
  it("accepts 'agent_disconnected', which core produces and acts on", () => {
    expect(fields({ retry_policy: { agent_disconnected: { delay_minutes: 5, max_attempts: 3 } } })).toEqual(
      [],
    );
  });

  it("accepts 'orphaned', which the reaper writes for a dead replica's attempt", () => {
    expect(fields({ retry_policy: { orphaned: { delay_minutes: 0, max_attempts: 3 } } })).toEqual([]);
  });

  it('names both keys in the valid list an unknown key is told about', () => {
    // Criterion 4: the error for a GENUINELY unknown key still enumerates the
    // valid set, and that set must now include the two new keys — otherwise the
    // operator is told to use a list that omits the thing they need.
    const message = messageFor(
      { retry_policy: { nobody_home: { max_attempts: 1 } } },
      'retry_policy.nobody_home',
    );

    expect(message).toContain('agent_disconnected');
    expect(message).toContain('orphaned');
    // …and still the originals, so this did not become a two-key list.
    expect(message).toContain('no_answer');
    expect(message).toContain('connected');
  });

  it('VALIDATES the rules on both keys rather than waving them through', () => {
    /**
     * The load-bearing case. `expect(fields(…)).toEqual([])` above is satisfied by
     * ACCEPTANCE and equally by the validator never traversing the key at all —
     * an allowlist bypass, or a `continue` that skips rule checks, would be green
     * on both. These assertions can only pass if each key reaches
     * `validateRetryRule` exactly like `busy` does.
     */
    expect(fields({ retry_policy: { agent_disconnected: { delay_minutes: 5 } } })).toEqual([
      'retry_policy.agent_disconnected.max_attempts',
    ]);
    expect(fields({ retry_policy: { orphaned: { max_attempts: 2.5 } } })).toEqual([
      'retry_policy.orphaned.max_attempts',
    ]);
    expect(fields({ retry_policy: { orphaned: { max_attempts: 1, delay_minutes: 43_201 } } })).toEqual([
      'retry_policy.orphaned.delay_minutes',
    ]);
    expect(fields({ retry_policy: { agent_disconnected: 3 } })).toEqual([
      'retry_policy.agent_disconnected',
    ]);
    expect(fields({ retry_policy: { agent_disconnected: { max_attempts: 1, nonsense: true } } })).toEqual([
      'retry_policy.agent_disconnected.nonsense',
    ]);
  });

  it('leaves the SILENTLY-INERT guidance exactly as it was (MAG-100 criterion 4)', () => {
    // Criterion 4's other half. Widening the list must not dilute the one message
    // that explains WHY a carefully-configured rule would never fire.
    for (const key of ['machine', 'voicemail', 'answering_machine']) {
      const message = messageFor({ retry_policy: { [key]: { max_attempts: 2 } } }, `retry_policy.${key}`);
      expect(message, key).toContain('never fire');
      expect(message, key).toContain('voicemail');
      expect(message, key).toContain('connected');
    }
  });
});

// ===========================================================================
// MAG-103 — `invalid` was accepted by both services and read by neither
//
// Core's `resolveRetryDecision` returns `suppressed` for `invalid` BEFORE the
// line that reads `policy?.[outcome]`, so no rule on the key — not even core's
// own `DEFAULT_RETRY_POLICY.invalid` — can ever be observed for that outcome. An
// operator could configure a retry, see it stored, and never have it fire.
// ===========================================================================
describe('the retry policy: `invalid` is refused as inert (MAG-103)', () => {
  it('refuses the key', () => {
    expect(fields({ retry_policy: { invalid: { max_attempts: 3 } } })).toEqual([
      'retry_policy.invalid',
    ]);
    // Refused whatever the rule says, including the `{max_attempts: 0}` that
    // §2.4's block used to carry — the key is inert at any value.
    expect(fields({ retry_policy: { invalid: { max_attempts: 0 } } })).toEqual([
      'retry_policy.invalid',
    ]);
  });

  it('explains WHY it can never fire, and does not reuse the answering-machine copy', () => {
    const message = messageFor({ retry_policy: { invalid: { max_attempts: 3 } } }, 'retry_policy.invalid');

    // The whole value of naming the key separately. `invalid` is a REAL outcome
    // that happens constantly — it is simply never retried — so the `machine`
    // wording ("never a call outcome", answering-machine detection) would be
    // actively wrong and would send the operator to the voicemail disposition
    // for a problem that has nothing to do with voicemail.
    expect(message).toContain('suppressed');
    expect(message).toContain('does not become good');
    expect(message).not.toContain('answering-machine detection');
    expect(message).not.toContain('never a call outcome');
  });

  it('drops `invalid` from the valid-key list an unknown key is shown', () => {
    // Criterion 4's other half: the list must not keep advertising a key the
    // validator now refuses, or the error tells the operator to use it.
    const message = messageFor(
      { retry_policy: { nobody_home: { max_attempts: 1 } } },
      'retry_policy.nobody_home',
    );

    expect(message).not.toContain('invalid');
    expect(message).toContain('no_answer');
  });

  it('KEEPS `connected`, which looks identical in the wizard but is live', () => {
    /**
     * The load-bearing non-change. Both `invalid` and `connected` render as
     * "fixed at 0" in cusui, so the tempting fix is to refuse both. `connected`
     * has NO short-circuit in core — it falls through to the ordinary policy
     * lookup, so a rule genuinely overrides the built-in `{max_attempts: 0}`.
     * Refusing it would delete a live lever, and this asserts we did not.
     */
    expect(fields({ retry_policy: { connected: { max_attempts: 2, delay_minutes: 30 } } })).toEqual([]);
  });
});

// ===========================================================================
// `canceled` — a dial we stopped before anyone picked up
//
// Added after the 2026-09-08 pilot, where a ring an agent cancelled was
// classified `abandoned` and put dials no customer ever heard into the
// compliance-facing bucket. Core now classifies it as its own outcome (distinct
// from `no_answer`, where the customer never picked up, and from `abandoned`,
// where they picked up and reached nobody) and routes it to
// `resolveOurFaultRedial`, which reads the CAMPAIGN's `retry_policy.canceled`
// for a stricter cap and for the delay. So this is a live lever and not a
// fallback — `DEFAULT_RETRY_POLICY.canceled` is the half nothing reads.
//
// ⚠️ Literal key names again, for MAG-100's reason: the "accepts every real
// outcome key" case iterates `RETRY_POLICY_OUTCOMES` itself and would pass
// unchanged either side of this fix.
// ===========================================================================
describe('the retry policy: `canceled` (pilot 2026-09-08)', () => {
  it("accepts 'canceled', which core produces and acts on", () => {
    expect(fields({ retry_policy: { canceled: { delay_minutes: 0, max_attempts: 3 } } })).toEqual([]);
  });

  it('names the key in the valid list an unknown key is told about', () => {
    // Same criterion as MAG-100's: the error for a genuinely unknown key must
    // enumerate a set that includes the thing the operator needs, or it sends
    // them back to a list that omits it.
    const message = messageFor(
      { retry_policy: { hung_up_early: { max_attempts: 1 } } },
      'retry_policy.hung_up_early',
    );

    expect(message).toContain('canceled');
    // …and still the originals, so widening did not truncate the list.
    expect(message).toContain('no_answer');
    expect(message).toContain('agent_disconnected');
  });

  it('VALIDATES the rule rather than waving the key through', () => {
    /**
     * `toEqual([])` above is satisfied by acceptance and equally by the
     * validator never traversing the key — an allowlist bypass would be green
     * on both. These can only pass if `canceled` reaches `validateRetryRule`
     * exactly as `busy` does.
     */
    expect(fields({ retry_policy: { canceled: { delay_minutes: 0 } } })).toEqual([
      'retry_policy.canceled.max_attempts',
    ]);
    expect(fields({ retry_policy: { canceled: { max_attempts: 2.5 } } })).toEqual([
      'retry_policy.canceled.max_attempts',
    ]);
    expect(fields({ retry_policy: { canceled: { max_attempts: 1, delay_minutes: 43_201 } } })).toEqual([
      'retry_policy.canceled.delay_minutes',
    ]);
    expect(fields({ retry_policy: { canceled: 3 } })).toEqual(['retry_policy.canceled']);
    expect(fields({ retry_policy: { canceled: { max_attempts: 1, nonsense: true } } })).toEqual([
      'retry_policy.canceled.nonsense',
    ]);
  });

  it('accepts the retire-on-first-cancel lever, which is the one worth a rule', () => {
    // `max_attempts: 0` is the reason an operator reaches for this key at all —
    // it retires a contact on the first cancelled dial, which is the lowering-only
    // asymmetry the header describes. Kept because it is a real setting, NOT as
    // evidence about the inert lists: see the note on the test below.
    expect(fields({ retry_policy: { canceled: { max_attempts: 3 } } })).toEqual([]);
    expect(fields({ retry_policy: { canceled: { max_attempts: 0 } } })).toEqual([]);
  });

  it('names the one-L spelling when an operator writes the British `cancelled`', () => {
    // ── This replaces a test that could not fail ─────────────────────────────
    //
    // The previous version claimed to prove `canceled` had landed on neither
    // inert list, by asserting the key is accepted. It could not: those sets are
    // consulted ONLY on the `!known.has(key)` branch, so once `canceled` is in
    // `RETRY_POLICY_OUTCOMES`, parking it on an inert set as well is a silent
    // no-op and the assertion stays green either way. It also never read a
    // message, despite saying "says so with the message it gets". The first test
    // in this block already covers `toEqual([])` for a valid rule.
    //
    // This is the load-bearing version, and the MAG-100 `answering_machine`
    // analog: almost every other vocabulary in this service is British —
    // jobs, schedules, automations, `NON_BILLABLE_STATUSES` — while core spells
    // this outcome with one L, matching `webrtc_calls.status`. So `cancelled` is
    // the word this codebase itself taught the operator, and a generic
    // "not a call outcome" plus a valid-keys list makes them diff by eye to find
    // that the answer is one letter away.
    expect(fields({ retry_policy: { cancelled: { max_attempts: 3 } } })).toEqual([
      'retry_policy.cancelled',
    ]);

    const message = messageFor(
      { retry_policy: { cancelled: { max_attempts: 3 } } },
      'retry_policy.cancelled',
    );
    // Names the fix, not just the problem.
    expect(message).toContain('canceled');
    expect(message).toContain('did you mean');
    // And NOT the answering-machine copy: that explains a rule can never fire
    // because AMD is off, which is untrue here and would send the operator to the
    // disposition screen for nothing.
    expect(message).not.toContain('answering-machine');
    expect(message).not.toContain('voicemail');
  });
});

describe('the calling window', () => {
  it('accepts HH:MM and HH:MM:SS, because Postgres renders TIME as the latter', () => {
    expect(fields({ calling_window_start: '09:00', calling_window_end: '20:00' })).toEqual([]);
    // A campaign read back from core and patched straight through carries the
    // seconds form; rejecting it would break edit-then-save.
    expect(fields({ calling_window_start: '09:00:00', calling_window_end: '20:00:00' })).toEqual([]);
  });

  it('rejects a malformed time rather than letting Postgres raise 22007', () => {
    // A `22007` inside the insert surfaces to the operator as a masked 500 with no
    // field to correct.
    for (const bad of ['9am', '24:00', '09:60', '', '9:00', 'noon']) {
      expect(fields({ calling_window_start: bad }), bad).toEqual(['calling_window_start']);
    }
  });

  it('rejects start == end, which core reads as PERMANENTLY CLOSED', () => {
    const message = messageFor(
      { calling_window_start: '09:00', calling_window_end: '09:00' },
      'calling_window_end',
    );

    // `nextOpenAt` returns null — "no opening exists" — not a 24-hour window. A
    // saveable campaign that can never place a call is a support ticket whose
    // cause is invisible on every screen.
    expect(message).toContain('never dial');
    // And the message offers the thing the operator actually meant.
    expect(message).toContain('00:00');
  });

  it('sees start == end across the two time FORMATS', () => {
    // `'09:00'` and `'09:00:00'` are the same instant and the naive string
    // comparison would call them different — letting the campaign through.
    expect(fields({ calling_window_start: '09:00', calling_window_end: '09:00:00' })).toEqual([
      'calling_window_end',
    ]);
  });

  it('ACCEPTS a window that wraps midnight — core supports it explicitly', () => {
    // `start > end` is handled in core's predicate. Rejecting it here would
    // outlaw evening campaigns in markets that run them.
    expect(fields({ calling_window_start: '22:00', calling_window_end: '06:00' })).toEqual([]);
  });

  it('cannot check start against end when only one is patched, and does not pretend to', () => {
    // Master holds no campaign copy, so a PATCH carrying one side has nothing to
    // compare against. Inventing the other half is how a second writable campaign
    // starts.
    expect(fields({ calling_window_start: '09:00' })).toEqual([]);
    expect(fields({ calling_window_end: '09:00' })).toEqual([]);
  });

  it('takes calling_days as ISO-8601 1–7', () => {
    expect(fields({ calling_days: [1, 2, 3, 4, 5] })).toEqual([]);
    expect(fields({ calling_days: [6, 7] })).toEqual([]);
  });

  it('REFUSES 0 rather than reading it as Sunday', () => {
    const message = messageFor({ calling_days: [0, 1] }, 'calling_days[0]');

    /**
     * The column's default `{1,2,3,4,5}` is Mon–Fri under BOTH Postgres `dow`
     * (0=Sun) and `isodow` (1=Mon), so the ambiguity is undetectable by testing
     * the default and would surface as an off-by-one on Sundays months later. A
     * caller sending `0` believes `dow`, so accepting it means we and they
     * disagree about which days the campaign runs. Core pins the same definition
     * in `calling-hours.ts` and names this validator as its mirror.
     */
    expect(message).toContain('1 = Monday');
    expect(message).toContain('0 is not a valid day');
  });

  it('rejects 8 and a non-integer day', () => {
    expect(fields({ calling_days: [8] })).toEqual(['calling_days[0]']);
    expect(fields({ calling_days: [1.5] })).toEqual(['calling_days[0]']);
    expect(fields({ calling_days: ['monday'] })).toEqual(['calling_days[0]']);
  });

  it('rejects an EMPTY calling_days — the campaign would never dial', () => {
    expect(messageFor({ calling_days: [] }, 'calling_days')).toContain('never dial');
  });

  it('rejects a non-array calling_days', () => {
    expect(fields({ calling_days: 5 })).toEqual(['calling_days']);
  });
});

describe('default_timezone — and the abbreviation Intl will not catch', () => {
  it('accepts Area/Location zones and exactly UTC', () => {
    for (const zone of ['America/New_York', 'Asia/Kolkata', 'Europe/London', 'UTC', 'America/Argentina/Buenos_Aires']) {
      expect(isUsableTimezone(zone), zone).toBe(true);
    }
  });

  it('REFUSES a bare abbreviation, which Intl accepts without error', () => {
    /**
     * The ratified rule, and the reason it needs a shape gate rather than a
     * try/catch: `new Intl.DateTimeFormat(undefined, { timeZone: 'EST' })` does
     * NOT throw. ICU resolves `EST` to `America/Panama`, which observes no DST —
     * so an `EST` campaign places every call **an hour early for half the year**
     * and tests clean whenever anyone checks, because whoever checks is unlikely
     * to do it across a DST boundary.
     *
     * Asserted here that Intl really does accept it, so the test proves the gap
     * it exists to close rather than asserting the fix in isolation.
     */
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: 'EST' })).not.toThrow();
    for (const abbrev of ['EST', 'PST', 'IST', 'GMT', 'CET', 'UTC+5']) {
      expect(isUsableTimezone(abbrev), abbrev).toBe(false);
    }
  });

  it('refuses a well-shaped zone that does not exist', () => {
    // The shape gate alone would pass this, so both gates are required.
    expect(isUsableTimezone('Made/Up')).toBe(false);
    expect(isUsableTimezone('America/Nowhere_At_All')).toBe(false);
  });

  it('refuses a non-string, an empty string and an over-long one', () => {
    expect(isUsableTimezone(undefined)).toBe(false);
    expect(isUsableTimezone(5)).toBe(false);
    expect(isUsableTimezone('')).toBe(false);
    expect(isUsableTimezone(`America/${'x'.repeat(100)}`)).toBe(false);
  });

  it('reports it as a field issue, with the DST reason in the message', () => {
    const message = messageFor({ default_timezone: 'EST' }, 'default_timezone');

    // At dial time an unreadable zone means the campaign's own config is broken,
    // and core's per-contact gate can only park the contact and log — it cannot
    // pause a campaign. So the rejection belongs at this boundary, and the message
    // has to explain the half-the-year part or 'EST' looks reasonable.
    expect(message).toContain('IANA');
    expect(message).toContain('daylight saving');
  });
});

describe('withCampaignConfigDefaults — fixing inert-by-default without deleting a configuration', () => {
  it('fills in the three built-in codes when no catalog was sent', () => {
    /**
     * `agency_campaigns.disposition_catalog` is `JSONB NOT NULL DEFAULT '[]'` and
     * nothing ever seeded it: master never sent the field, so EVERY campaign the
     * platform has made carried an empty catalog, `requiresDisposition` returned
     * false for all of them, and any submission core did receive answered
     * `unknown_disposition_code` with `allowed_codes: []`. Disposition was inert
     * platform-wide.
     */
    const out = withCampaignConfigDefaults({ name: 'Q3' }) as Record<string, unknown>;

    expect(out['disposition_catalog']).toEqual([...DEFAULT_DISPOSITION_CATALOG]);
    expect((out['disposition_catalog'] as unknown[]).map((e) => (e as { code: string }).code)).toEqual([
      'voicemail',
      'callback',
      'do_not_call',
    ]);
  });

  it('LEAVES an explicit empty catalog empty — that is a configuration, not an omission', () => {
    /**
     * The distinction the whole mechanism rests on. An empty catalog means
     * "outcome-driven retry, no human write-up", which core supports on purpose
     * and `MAG-88` preserves explicitly. A default is only consulted when the
     * caller expressed no opinion, and `[]` is an opinion.
     *
     * The alternative that was nearly built — core force-merging built-ins on read
     * so the effective catalog is never empty — would have deleted this
     * configuration platform-wide.
     */
    const out = withCampaignConfigDefaults({ disposition_catalog: [] }) as Record<string, unknown>;

    expect(out['disposition_catalog']).toEqual([]);
  });

  it('leaves an operator-supplied catalog alone', () => {
    const supplied = [{ code: 'sale', label: 'Sale' }];
    const out = withCampaignConfigDefaults({ disposition_catalog: supplied }) as Record<string, unknown>;

    expect(out['disposition_catalog']).toBe(supplied);
  });

  it('does NOT default retry_policy, so a later change to the defaults reaches old campaigns', () => {
    const out = withCampaignConfigDefaults({ name: 'Q3' }) as Record<string, unknown>;

    // Core's `DEFAULT_RETRY_POLICY` falls back PER KEY at read time. Sending an
    // explicit copy from master would freeze today's values into every campaign
    // row and make a later change invisible to every existing campaign.
    expect('retry_policy' in out).toBe(false);
  });

  it('does not mutate the request body it was given', () => {
    const body = { name: 'Q3' };
    const out = withCampaignConfigDefaults(body);

    // The caller forwards this body to core; a surprise mutation of a request
    // object is how a proxy starts lying about what it sent.
    expect(body).toEqual({ name: 'Q3' });
    expect(out).not.toBe(body);
  });

  it('returns a fresh copy of each default entry, not the shared constant', () => {
    const a = withCampaignConfigDefaults({}) as { disposition_catalog: unknown[] };
    const b = withCampaignConfigDefaults({}) as { disposition_catalog: unknown[] };

    // A shared object reference would let one request's serialisation or a later
    // in-place edit reach every other campaign created by this process.
    expect(a.disposition_catalog[0]).not.toBe(b.disposition_catalog[0]);
    expect(a.disposition_catalog[0]).toEqual(b.disposition_catalog[0]);
  });

  it('passes a non-object body straight through', () => {
    expect(withCampaignConfigDefaults(null)).toBeNull();
    expect(withCampaignConfigDefaults('x')).toBe('x');
  });

  it('produces a catalog its own validator accepts', () => {
    // The default and the rules ship in one file, so a default that fails
    // validation is a 400 on every campaign create — and it is the one case the
    // two halves can disagree about.
    const out = withCampaignConfigDefaults({ name: 'Q3' });

    expect(validateAgencyCampaignConfig(out)).toEqual([]);
  });

  it('gives each built-in the flag that makes it work', () => {
    const byCode = new Map(DEFAULT_DISPOSITION_CATALOG.map((e) => [e.code, e as Record<string, unknown>]));

    // The codes are conventions — nothing in core compares against these strings,
    // which is why their presence is not validated. The FLAGS are what the retry
    // engine, the scheduler and suppression actually read.
    expect(byCode.get('voicemail')!['retry']).toEqual({ delay_minutes: 240, max_attempts: 2 });
    expect(byCode.get('callback')!['requires_datetime']).toBe(true);
    expect(byCode.get('do_not_call')!['suppress']).toBe(true);
  });

  it("do_not_call matches core's BUILT_IN_DISPOSITIONS exactly — no terminal flag", () => {
    /**
     * Cross-repo contract, unchecked by the compiler (`AD-P3-M-06` follow-up):
     * core's `BUILT_IN_DISPOSITIONS` (`magic-voice-core/src/agency/disposition-policy.ts`)
     * declares `do_not_call` as `{ code: 'do_not_call', label: 'Do not call',
     * suppress: true }` — no `terminal`. Core's header states it is exported
     * *precisely* so master and cusui copy from that one place; this pins master's
     * copy against it so the two cannot drift silently, the same discipline
     * `agency-billing-contract.test.ts` uses for the wire↔rate-card mapping.
     *
     * `terminal: true` was dropped deliberately: core's `resolveDispositionDecision`
     * checks `suppress` FIRST and returns before `terminal` is ever read (§2.4's
     * precedence order), so the flag could never fire on this code — a flag whose
     * effect is unreachable behind an earlier-checked one is the "inert config"
     * shape this project keeps finding. The default now states only what is true.
     */
    const doNotCall = DEFAULT_DISPOSITION_CATALOG.find((e) => e.code === 'do_not_call');

    expect(doNotCall).toEqual({ code: 'do_not_call', label: 'Do not call', suppress: true });
    expect(doNotCall).not.toHaveProperty('terminal');
  });
});

describe('issuesToDetails', () => {
  it('keys messages by field for the wizard', () => {
    const details = issuesToDetails([
      { field: 'calling_days', message: 'a' },
      { field: 'default_timezone', message: 'b' },
    ]);

    expect(details).toEqual({ calling_days: 'a', default_timezone: 'b' });
  });

  it('keeps the FIRST message for a repeated field', () => {
    // Two messages cannot both render next to one field, and the earlier rule is
    // the more structural one.
    expect(issuesToDetails([
      { field: 'calling_days', message: 'first' },
      { field: 'calling_days', message: 'second' },
    ])).toEqual({ calling_days: 'first' });
  });
});
