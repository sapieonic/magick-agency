import { describe, it, expect } from 'vitest';
import { AGENCY_DEFAULT_DISPOSITION_CATALOG, type AgencyCallField, type AgencyDisposition } from '@magick-agency/contracts/agency';
import {
  validateCallFieldValues, CALL_FIELD_TEXT_MAX, storedValuesInForce, submittedCallFields,
} from '../../../../src/agency/softphone/call-fields.js';
import {
  manualDispositionDecision,
  manualNoOutcomeSettlement,
  prepareManualDisposition,
  resolveManualCatalog,
} from '../../../../src/agency/softphone/manual-disposition.js';

/*
 * The soft phone's outcome rules (docs/softphone.md §3, §4.1 step 7, §5): the
 * catalog a call resolves against, the submitted outcome, the call fields against
 * the set in force, and the roster decision with the attempt the call costs.
 */

const NOW = new Date('2026-10-30T10:00:00Z');

const FIELDS: AgencyCallField[] = [
  { key: 'policy_no', label: 'Policy number', type: 'text', required: true },
  { key: 'amount', label: 'Amount', type: 'number' },
  { key: 'plan', label: 'Plan', type: 'choice', options: ['gold', 'silver'] },
  { key: 'consent', label: 'Consent', type: 'boolean' },
  { key: 'follow_up', label: 'Follow-up', type: 'date' },
];

const CATALOG: AgencyDisposition[] = [
  { code: 'sale', label: 'Sale', is_success: true, terminal: true },
  { code: 'call_back', label: 'Call back', requires_datetime: true },
  { code: 'note_me', label: 'Needs a note', requires_note: true },
  { code: 'dnc', label: 'Do not call', suppress: true },
  { code: 'retry_twice', label: 'Retry', retry: { max_attempts: 2, delay_minutes: 60 } },
];

describe('call fields', () => {
  it('accepts every type, and empties', () => {
    const r = validateCallFieldValues(FIELDS, {
      policy_no: 'P-1', amount: 12.5, plan: 'gold', consent: false, follow_up: '2026-11-02',
    }, { requireFilled: true });
    expect(r).toEqual({ ok: true, values: { policy_no: 'P-1', amount: 12.5, plan: 'gold', consent: false, follow_up: '2026-11-02' } });
    expect(validateCallFieldValues(FIELDS, { amount: null, plan: '' }, { requireFilled: false })).toEqual({
      ok: true, values: { amount: null, plan: '' },
    });
    expect(validateCallFieldValues(FIELDS, undefined, { requireFilled: false })).toEqual({ ok: true, values: {} });
  });

  it('refuses unknown keys and wrong types, one detail per key, never dropping them', () => {
    const r = validateCallFieldValues(FIELDS, {
      policy_no: 7, amount: 'ten', plan: 'bronze', consent: 'yes', follow_up: '2026-02-30', nickname: 'x',
    }, { requireFilled: false });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.details.map((d) => d.path).sort()).toEqual([
      'fields.amount', 'fields.consent', 'fields.follow_up', 'fields.nickname', 'fields.plan', 'fields.policy_no',
    ]);
    expect(validateCallFieldValues(FIELDS, { amount: Number.POSITIVE_INFINITY }, { requireFilled: false }).ok).toBe(false);
    expect(validateCallFieldValues(FIELDS, { policy_no: 'x'.repeat(CALL_FIELD_TEXT_MAX + 1) }, { requireFilled: false }).ok).toBe(false);
    expect(validateCallFieldValues(FIELDS, ['nope'], { requireFilled: false })).toEqual({
      ok: false, details: [{ path: 'fields', message: expect.any(String) }],
    });
  });

  it('enforces required only on the outcome', () => {
    expect(validateCallFieldValues(FIELDS, { amount: 1 }, { requireFilled: false }).ok).toBe(true);
    const r = validateCallFieldValues(FIELDS, { amount: 1, policy_no: '   ' }, { requireFilled: true });
    expect(r.ok ? null : r.details).toEqual([{ path: 'fields.policy_no', message: 'Policy number is required' }]);
  });

  it('reads own properties only: a required field keyed like a prototype member is still enforced', () => {
    // A stored set from before the reserved-key refusal (`PUT /settings`).
    const proto = [{ key: 'constructor', label: 'Constructor', type: 'text' as const, required: true }];
    const r = validateCallFieldValues(proto, {}, { requireFilled: true });
    expect(r.ok ? null : r.details).toEqual([{ path: 'fields.constructor', message: 'Constructor is required' }]);
    expect(validateCallFieldValues(proto, { constructor: 'filled' }, { requireFilled: true }).ok).toBe(true);
  });
});

describe('the catalog', () => {
  it('tagged: the campaign\'s, else the built-in, as source campaign', () => {
    expect(resolveManualCatalog({ disposition_catalog: CATALOG }, true, { disposition_catalog: [] }))
      .toEqual({ catalog: CATALOG, source: 'campaign' });
    expect(resolveManualCatalog({ disposition_catalog: [] }, true, { disposition_catalog: CATALOG }))
      .toEqual({ catalog: [...AGENCY_DEFAULT_DISPOSITION_CATALOG], source: 'campaign' });
    expect(resolveManualCatalog(null, true, { disposition_catalog: CATALOG }).source).toBe('campaign');
  });

  it('untagged: the settings\', else the built-in, as source softphone', () => {
    expect(resolveManualCatalog(null, false, { disposition_catalog: CATALOG })).toEqual({ catalog: CATALOG, source: 'softphone' });
    expect(resolveManualCatalog(null, false, { disposition_catalog: [] }))
      .toEqual({ catalog: [...AGENCY_DEFAULT_DISPOSITION_CATALOG], source: 'softphone' });
  });
});

describe('the submitted outcome', () => {
  const base = { catalog: CATALOG, callFields: FIELDS, storedFields: { policy_no: 'P-9' }, now: NOW, submittedFields: undefined };

  it('refuses an unknown code with the codes the catalog accepts', () => {
    const r = prepareManualDisposition({ ...base, code: 'nope' });
    expect(r.ok ? null : r.refusal).toEqual({
      code: 'disposition_invalid', reason: 'unknown_code', allowed_codes: CATALOG.map((d) => d.code),
    });
  });

  it('enforces the entry\'s note and callback rules', () => {
    const noNote = prepareManualDisposition({ ...base, code: 'note_me', notes: '  ' });
    expect(noNote.ok ? null : noNote.refusal).toMatchObject({ code: 'disposition_invalid', reason: 'note_required' });
    const noTime = prepareManualDisposition({ ...base, code: 'call_back' });
    expect(noTime.ok ? null : noTime.refusal).toMatchObject({ reason: 'datetime_required' });
    const past = prepareManualDisposition({ ...base, code: 'call_back', callbackAt: '2026-10-29T10:00:00Z' });
    expect(past.ok ? null : past.refusal).toMatchObject({ reason: 'invalid_callback_at' });
    const ok = prepareManualDisposition({ ...base, code: 'call_back', callbackAt: '2026-11-02T10:00:00Z' });
    expect(ok.ok && ok.prepared.callbackAt?.toISOString()).toBe('2026-11-02T10:00:00.000Z');
  });

  it('requires the required fields on the submitted values, else on the stored ones', () => {
    expect(prepareManualDisposition({ ...base, code: 'sale' }).ok).toBe(true); // stored policy_no
    const blanked = prepareManualDisposition({ ...base, code: 'sale', submittedFields: { policy_no: null } });
    expect(blanked.ok ? null : blanked.refusal.code).toBe('fields_invalid');
    const missingStored = prepareManualDisposition({ ...base, storedFields: {}, code: 'sale' });
    expect(missingStored.ok ? null : missingStored.refusal.code).toBe('fields_invalid');
    const submitted = prepareManualDisposition({ ...base, storedFields: {}, code: 'sale', submittedFields: { policy_no: 'P-2' } });
    expect(submitted.ok && submitted.prepared.fields).toEqual({ policy_no: 'P-2' });
  });

  it('omitted fields, and {} with no call fields in force, leave the stored values alone', () => {
    const omitted = prepareManualDisposition({ ...base, code: 'sale' });
    expect(omitted.ok && omitted.prepared.fields).toBeUndefined();
    // The account has no call fields now; the call has values saved under the old set.
    const noFields = { ...base, callFields: [], storedFields: { policy_no: 'P-9', gone: 'x' } };
    const empty = prepareManualDisposition({ ...noFields, code: 'sale', submittedFields: {} });
    expect(empty.ok).toBe(true);
    expect(empty.ok && empty.prepared.fields).toBeUndefined();
    // Stored values for keys no longer in force are not re-validated (nothing to fix).
    expect(prepareManualDisposition({ ...noFields, code: 'sale' }).ok).toBe(true);
    // With call fields in force, {} is a real clear — here refused: policy_no is required.
    const cleared = prepareManualDisposition({ ...base, code: 'sale', submittedFields: {} });
    expect(cleared.ok ? null : cleared.refusal.code).toBe('fields_invalid');
  });
});

describe('the roster decision', () => {
  const window = { calling_window_start: '09:00:00', calling_window_end: '17:00:00', calling_days: [1, 2, 3, 4, 5], default_timezone: 'UTC' };

  it('charges the placed call: attemptsUsed = stored + 1 (settleFromManual makes the bump)', () => {
    const entry = CATALOG.find((d) => d.code === 'retry_twice')!;
    const placed = manualDispositionDecision({ entry, now: NOW, callbackAt: null, placed: true, contact: { attempt_count: 1, timezone: null }, tag: window });
    expect(placed.decision.contactState).toBe('exhausted');
    const unplaced = manualDispositionDecision({ entry, now: NOW, callbackAt: null, placed: false, contact: { attempt_count: 1, timezone: null }, tag: window });
    expect(unplaced.decision.contactState).toBe('pending');
    expect(unplaced.nextAttemptAt?.toISOString()).toBe('2026-10-30T11:00:00.000Z'); // a retry is not deferred
  });

  it('suppress beats everything; terminal completes', () => {
    const dnc = manualDispositionDecision({
      entry: CATALOG.find((d) => d.code === 'dnc')!, now: NOW, callbackAt: new Date('2026-11-02T10:00:00Z'),
      placed: true, contact: null, tag: null,
    });
    expect(dnc.decision).toMatchObject({ contactState: 'suppressed', suppressedReason: 'dnc' });
    expect(dnc.nextAttemptAt).toBeNull();
    expect(manualDispositionDecision({ entry: CATALOG[0]!, now: NOW, callbackAt: null, placed: true, contact: null, tag: null })
      .decision.contactState).toBe('completed');
  });

  it('a callback lands inside the contact\'s calling window', () => {
    // Saturday 10:00 UTC → the window next opens Monday 09:00 UTC.
    const r = manualDispositionDecision({
      entry: CATALOG.find((d) => d.code === 'call_back')!, now: NOW,
      callbackAt: new Date('2026-10-31T10:00:00Z'), placed: true, contact: { attempt_count: 0, timezone: null }, tag: window,
    });
    expect(r.decision.contactState).toBe('pending');
    expect(r.nextAttemptAt?.toISOString()).toBe('2026-11-02T09:00:00.000Z');
    // Untagged: no window to defer into.
    const u = manualDispositionDecision({
      entry: CATALOG.find((d) => d.code === 'call_back')!, now: NOW,
      callbackAt: new Date('2026-10-31T10:00:00Z'), placed: true, contact: null, tag: null,
    });
    expect(u.nextAttemptAt?.toISOString()).toBe('2026-10-31T10:00:00.000Z');
  });
});

describe('a call that settles with no outcome (§5: the campaign path\'s retry rules)', () => {
  const contact = { attempt_count: 1, our_fault_attempts: 0 };
  const base = { placed: true, bridged: false, policy: {}, contact, now: NOW } as const;

  it('never placed: the claim is given back, nothing charged, whatever the outcome', () => {
    expect(manualNoOutcomeSettlement({ ...base, placed: false, outcome: 'failed' })).toEqual({ kind: 'release' });
    expect(manualNoOutcomeSettlement({ ...base, placed: false, outcome: 'no_answer' })).toEqual({ kind: 'release' });
  });

  it('placed and unanswered: the customer\'s allowance, the policy\'s delay on stored + 1', () => {
    const r = manualNoOutcomeSettlement({ ...base, outcome: 'no_answer' });
    expect(r).toMatchObject({ kind: 'settle', charge: 'attempt', decision: { contactState: 'pending', reason: 'retry_scheduled' } });
    expect(r.kind === 'settle' && r.decision.nextAttemptAt?.toISOString()).toBe('2026-10-30T11:00:00.000Z'); // default 60 min
    const configured = manualNoOutcomeSettlement({ ...base, outcome: 'busy', policy: { busy: { delay_minutes: 15, max_attempts: 2 } } });
    expect(configured).toMatchObject({ charge: 'attempt', decision: { contactState: 'exhausted' } }); // 1 + 1 >= 2
    expect(manualNoOutcomeSettlement({ ...base, outcome: 'invalid' }))
      .toMatchObject({ charge: 'attempt', decision: { contactState: 'suppressed', suppressedReason: 'invalid' } });
  });

  it('placed and ended by our side before the bridge: the our-fault ledger, never the allowance', () => {
    for (const outcome of ['canceled', 'agent_disconnected'] as const) {
      const r = manualNoOutcomeSettlement({ ...base, outcome });
      expect(r).toMatchObject({ kind: 'settle', charge: 'our_fault', decision: { contactState: 'pending' } });
      expect(r.kind === 'settle' && r.decision.nextAttemptAt?.toISOString()).toBe('2026-10-30T10:05:00.000Z');
    }
    expect(manualNoOutcomeSettlement({ ...base, outcome: 'canceled', contact: { attempt_count: 0, our_fault_attempts: 2 } }))
      .toMatchObject({ charge: 'our_fault', decision: { contactState: 'exhausted', reason: 'our_fault_bound_reached' } });
  });

  it('an unbridged orphan is the reaper\'s rule: our fault, back on the roster at once', () => {
    const r = manualNoOutcomeSettlement({ ...base, outcome: 'orphaned' });
    expect(r).toMatchObject({ charge: 'our_fault', decision: { contactState: 'pending' } });
    expect(r.kind === 'settle' && r.decision.nextAttemptAt?.getTime()).toBe(NOW.getTime());
  });

  it('a lapsed bridged call: the allowance, and connected is never retried by default', () => {
    expect(manualNoOutcomeSettlement({ ...base, bridged: true, outcome: 'connected' }))
      .toMatchObject({ charge: 'attempt', decision: { contactState: 'completed', reason: 'outcome_not_retryable' } });
    // A bridged agent drop is a conversation, not our-fault-before-bridge.
    expect(manualNoOutcomeSettlement({ ...base, bridged: true, outcome: 'agent_disconnected' }))
      .toMatchObject({ charge: 'attempt' });
  });
});

describe('what a request\'s fields mean', () => {
  it('submittedCallFields: omitted is unchanged; {} is unchanged only with no call fields in force', () => {
    expect(submittedCallFields(FIELDS, undefined)).toBeUndefined();
    expect(submittedCallFields([], undefined)).toBeUndefined();
    expect(submittedCallFields([], {})).toBeUndefined();
    expect(submittedCallFields(FIELDS, {})).toEqual({});
    // Not an empty object: passed on for validation to refuse or accept.
    expect(submittedCallFields([], { policy_no: 'P' })).toEqual({ policy_no: 'P' });
    expect(submittedCallFields([], null)).toBeNull();
    expect(submittedCallFields([], [])).toEqual([]);
  });

  it('storedValuesInForce keeps only the keys of fields in force', () => {
    expect(storedValuesInForce(FIELDS, { policy_no: 'P', gone: 'x' })).toEqual({ policy_no: 'P' });
    expect(storedValuesInForce([], { policy_no: 'P' })).toEqual({});
  });
});
