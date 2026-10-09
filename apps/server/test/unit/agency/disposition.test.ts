import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// The disposition submit rules.
//
// The pure half: the catalog, the ownership rule, and the field validation the
// catalog drives. The route's ordering and the idempotent write are exercised in
// `disposition-route.test.ts`, against the real handler.
// ---------------------------------------------------------------------------

import {
  AUTO_DISPOSITION_CODE,
  checkActor,
  dispositionRefusal,
  resolveDisposition,
  validateDispositionFields,
} from '../../../src/agency/disposition.js';
import type { AgencyDisposition } from '@magick-agency/contracts/agency';
import type { AgencyCallAttemptRecord } from '../../../src/db/models/agency.model.js';

const CATALOG: AgencyDisposition[] = [
  { code: 'sale', label: 'Sale', is_success: true },
  { code: 'not_interested', label: 'Not interested', terminal: true },
  { code: 'complaint', label: 'Complaint', requires_note: true },
  { code: 'callback', label: 'Callback', requires_datetime: true },
];

function attempt(patch: Partial<AgencyCallAttemptRecord> = {}): AgencyCallAttemptRecord {
  return {
    id: 'att-1', campaign_id: 'camp-1', contact_id: 'contact-1',
    tenant_id: 't1', account_id: 'a1', attempt_number: 1,
    webrtc_call_id: 'call-1', caller_id: '+14155550100',
    reserved_agent_id: 'sess-1', state: 'ended', outcome: 'connected',
    disposition_code: null, notes: null, callback_at: null,
    dispositioned_by_user_id: null, dispositioned_at: null, dispositioned_on_behalf: false,
    dialed_at: new Date(), answered_at: new Date(), bridged_at: new Date(),
    ended_at: new Date(), talk_seconds: 42, wrapup_seconds: 30,
    wrapup_started_at: null, wrapup_ended_at: null, wrapup_resolution: null,
    abandon_reason: null,
    created_at: new Date(), updated_at: new Date(),
    ...patch,
  };
}

const NOW = new Date('2026-08-11T10:00:00.000Z');
const FUTURE = '2026-08-12T09:00:00.000Z';
const PAST = '2026-08-10T09:00:00.000Z';

describe('resolveDisposition', () => {
  it('echoes the valid codes when one is unknown', () => {
    const res = resolveDisposition(CATALOG, 'nope');
    expect(res.ok).toBe(false);
    // The echo is what lets a console holding a stale catalog recover in one
    // round trip instead of making the agent re-bootstrap mid-shift.
    expect(res.ok === false && res.allowed)
      .toEqual(['sale', 'not_interested', 'complaint', 'callback']);
  });

  it('degrades a malformed catalog to "no valid codes" rather than throwing', () => {
    // The column is CHECKed to be a JSON array; nothing constrains its elements.
    // A 500 here would read to the agent as the server being broken, on the one
    // interaction whose purpose is recording what was said to a customer.
    for (const bad of [null, undefined, {}, 'sale', [null, 3, { label: 'no code' }]] as unknown[]) {
      const res = resolveDisposition(bad as AgencyDisposition[], 'sale');
      expect(res.ok, `accepted a code from a malformed catalog: ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('does not match a non-string code', () => {
    // A JSON body can carry anything. `find` on a number would simply miss, but
    // an implementation that coerced would let `{"disposition_code": 0}` through.
    for (const code of [0, false, null, {}, ['sale']] as unknown[]) {
      expect(resolveDisposition(CATALOG, code).ok).toBe(false);
    }
  });
});

describe('checkActor — the ownership rule, steps 1 to 4', () => {
  it('1: no agent_user_id is a missing_actor refusal, not an anonymous write', () => {
    for (const body of [{}, { agent_user_id: '' }, { agent_user_id: '   ' }, { agent_user_id: 7 }]) {
      const res = checkActor('u-agent', body as never);
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.code).toBe('missing_actor');
    }
  });

  it('1 takes precedence over 3: on_behalf does not excuse an unattributed write', () => {
    // Order matters. A supervisor flag with no actor would otherwise record a
    // disposition attributable to nobody — which is the one thing step 1 exists
    // to prevent, and the flag makes it *more* likely, not less.
    const res = checkActor('u-agent', { on_behalf: true } as never);
    expect(res.ok === false && res.code).toBe('missing_actor');
  });

  it('2: the reserved agent writing up their own call', () => {
    const res = checkActor('u-agent', { agent_user_id: 'u-agent' });
    expect(res).toEqual({ ok: true, onBehalf: false, actorUserId: 'u-agent' });
  });

  it('3: a mismatch with on_behalf is allowed and RECORDED as on-behalf', () => {
    const res = checkActor('u-agent', { agent_user_id: 'u-super', on_behalf: true });
    expect(res.ok).toBe(true);
    // The flag has to survive into the row: a supervisor's write-up that looked
    // like the agent's own would silently rewrite whose conversation it was.
    expect(res.ok === true && res.onBehalf).toBe(true);
    expect(res.ok === true && res.actorUserId).toBe('u-super');
  });

  it('4: a mismatch without on_behalf is not_your_attempt', () => {
    const res = checkActor('u-agent', { agent_user_id: 'u-other' });
    expect(res.ok === false && res.code).toBe('not_your_attempt');
  });

  it('4: only a literal `true` asserts on_behalf', () => {
    // The public API layer sets a boolean. A truthy string arriving from a hand-rolled client
    // must not be enough to reach another agent's attempt — this is the one check
    // standing between "any role above agent" and someone else's call record.
    for (const flag of ['true', 1, {}, 'yes'] as unknown[]) {
      const res = checkActor('u-agent', { agent_user_id: 'u-other', on_behalf: flag });
      expect(res.ok === false && res.code, `on_behalf accepted ${JSON.stringify(flag)}`)
        .toBe('not_your_attempt');
    }
  });

  it('an attempt with no reserved agent is nobody\'s, and still reachable on behalf', () => {
    expect(checkActor(null, { agent_user_id: 'u-agent' }).ok).toBe(false);
    expect(checkActor(null, { agent_user_id: 'u-super', on_behalf: true }).ok).toBe(true);
  });
});

describe('dispositionRefusal', () => {
  it('refuses an attempt that never reached the agent', () => {
    // Keyed on `bridged_at`, not the outcome: the outcome is a classification
    // that can be absent or late, while `bridged_at` is the instant media
    // actually joined the two parties. A call that rang out has no conversation
    // to write up and never will.
    expect(dispositionRefusal(attempt({ bridged_at: null, outcome: 'no_answer' })))
      .toBe('attempt_not_dispositionable');
  });

  it('refuses an auto-closed attempt DISTINCTLY from an already-dispositioned one', () => {
    // Different facts, and only one of them is the agent's doing — the console
    // says "this call was auto-closed" rather than "you already did this".
    expect(dispositionRefusal(attempt({ disposition_code: AUTO_DISPOSITION_CODE })))
      .toBe('attempt_not_dispositionable');
    // An ordinary incumbent code is NOT refused here: same-code is an idempotent
    // success and different-code is the write's 409, both decided at the write.
    expect(dispositionRefusal(attempt({ disposition_code: 'sale' }))).toBeNull();
  });

  it('allows a bridged attempt that is still live', () => {
    // Not gated on `ended`. An agent submitting as the call ends would otherwise
    // race the teardown and be refused for a conversation that really happened.
    expect(dispositionRefusal(attempt({ state: 'bridged', ended_at: null, outcome: null }))).toBeNull();
  });
});

describe('validateDispositionFields', () => {
  it('requires a note when the catalog says so, and whitespace is not a note', () => {
    const entry = CATALOG[2]!;
    expect(validateDispositionFields(entry, {}, NOW)).toEqual({ ok: false, code: 'note_required' });
    expect(validateDispositionFields(entry, { notes: '' }, NOW)).toEqual({ ok: false, code: 'note_required' });
    // Without the trim, `requires_note` is satisfiable with a space: the check
    // passes and the record holds nothing, which is the failure it exists to stop.
    expect(validateDispositionFields(entry, { notes: '   \n\t ' }, NOW))
      .toEqual({ ok: false, code: 'note_required' });
    expect(validateDispositionFields(entry, { notes: 'Escalated to billing' }, NOW).ok).toBe(true);
  });

  it('requires a datetime when the catalog says so', () => {
    const entry = CATALOG[3]!;
    expect(validateDispositionFields(entry, {}, NOW)).toEqual({ ok: false, code: 'datetime_required' });
    expect(validateDispositionFields(entry, { callback_at: '' }, NOW))
      .toEqual({ ok: false, code: 'datetime_required' });
    expect(validateDispositionFields(entry, { callback_at: null }, NOW))
      .toEqual({ ok: false, code: 'datetime_required' });
  });

  it('rejects an unparseable or past callback', () => {
    const entry = CATALOG[3]!;
    for (const bad of ['tuesday', '2026-13-45', 12345, {}] as unknown[]) {
      expect(validateDispositionFields(entry, { callback_at: bad }, NOW))
        .toEqual({ ok: false, code: 'invalid_callback_at' });
    }
    // A callback in the past is a promise already broken: the contact would be
    // immediately dialable, so the customer told "Tuesday" is called right now.
    expect(validateDispositionFields(entry, { callback_at: PAST }, NOW))
      .toEqual({ ok: false, code: 'invalid_callback_at' });
    expect(validateDispositionFields(entry, { callback_at: NOW.toISOString() }, NOW))
      .toEqual({ ok: false, code: 'invalid_callback_at' });
  });

  it('parses a future callback', () => {
    const res = validateDispositionFields(CATALOG[3]!, { callback_at: FUTURE }, NOW);
    expect(res.ok).toBe(true);
    expect(res.ok === true && res.callbackAt?.toISOString()).toBe(FUTURE);
  });

  it('accepts a callback on a code that does not require one', () => {
    // Not an error: an agent recording a callback time on any code is agreeing a
    // time with a customer, and refusing it would drop the agreement.
    const res = validateDispositionFields(CATALOG[0]!, { callback_at: FUTURE }, NOW);
    expect(res.ok === true && res.callbackAt).not.toBeNull();
  });

  it('leaves notes null when none were supplied, so a replay cannot erase them', () => {
    // `recordDisposition` COALESCEs a null note onto the existing one. If this
    // returned `''` for an absent field, a retry that omitted notes would wipe
    // what the agent typed on the first attempt.
    const res = validateDispositionFields(CATALOG[0]!, {}, NOW);
    expect(res.ok === true && res.notes).toBeNull();
  });
});
