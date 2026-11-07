import { describe, it, expect, vi } from 'vitest';
import {
  assignedElsewhere,
  normalizeDialledNumber,
  pickRosterContact,
  runManualPredial,
  selectCallerId,
  validateOverrideNote,
  type ManualPredialInput,
  softphoneCarrier,
} from '../../../../src/agency/softphone/manual-predial.js';
import { SOFTPHONE_SETTINGS_DEFAULTS } from '../../../../src/db/repositories/agency.repository.js';
import type { AgencyCampaignRecord, AgencyContactRecord } from '../../../../src/db/models/agency.model.js';

/*
 * The soft phone's pre-dial (docs/softphone.md §4.1 step 2, SP1, SP2): every
 * refusal, every override, the note bounds, the caller-ID selection order and the
 * number's normalisation. Pure apart from the two injected reads.
 */

const NOW = new Date('2026-10-30T10:00:00Z'); // a Friday, 15:30 in Kolkata
const AGENT = 'agent-1';
const OTHER_AGENT = 'agent-2';

const tag = (over: Partial<AgencyCampaignRecord> = {}): AgencyCampaignRecord => ({
  id: 'camp-1', tenant_id: 't1', account_id: 'a1', name: 'Q4',
  caller_ids: ['+919000000001', '+919000000002'], telephony_provider: 'voicelink',
  calling_window_start: '00:00:00', calling_window_end: '24:00:00', calling_days: [1, 2, 3, 4, 5, 6, 7],
  default_timezone: 'UTC', record_calls: true, analysis_profile_id: 'prof-tag',
  disposition_catalog: [], status: 'draft',
  ...over,
} as unknown as AgencyCampaignRecord);

const contact = (id: string, state: string, over: Partial<AgencyContactRecord> = {}): AgencyContactRecord =>
  ({ id, state, timezone: null, phone_e164: '+919811100001', attempt_count: 0, ...over } as unknown as AgencyContactRecord);

function input(over: Partial<ManualPredialInput> = {}): ManualPredialInput {
  return {
    tenantId: 't1', accountId: 'a1', to: '9811100001', defaultCountryCode: '91',
    tag: tag(), accountNumbers: [], settings: { ...SOFTPHONE_SETTINGS_DEFAULTS }, now: NOW,
    actor: { userId: AGENT, supervise: false },
    ...over,
  };
}

function deps(opts: {
  matches?: AgencyContactRecord[]; dnc?: unknown; inFlight?: AgencyContactRecord | null;
  dedicated?: ReadonlyMap<string, string>;
} = {}) {
  return {
    dnc: { checkEntry: vi.fn().mockResolvedValue(opts.dnc ?? { result: 'clear' }) },
    findRosterMatches: vi.fn().mockResolvedValue(opts.matches ?? []),
    findInFlightInAccount: vi.fn().mockResolvedValue(opts.inFlight ?? null),
    findDedicatedCallerIds: vi.fn().mockResolvedValue(opts.dedicated ?? new Map()),
  };
}

const ENTRY = { id: 'dnc-1', scope: 'campaign' as const, reason: 'asked', created_at: new Date('2026-10-01T00:00:00Z') };

describe('the number', () => {
  it('normalises a local number in the default region, and an E.164 one as typed', () => {
    expect(normalizeDialledNumber('98111 00001', '91')).toBe('+919811100001');
    expect(normalizeDialledNumber('09811100001', '91')).toBe('+919811100001');
    expect(normalizeDialledNumber('+1 (415) 555-0100', '91')).toBe('+14155550100');
    expect(normalizeDialledNumber('4155550100', '1')).toBe('+14155550100');
  });

  it('drops a bracketed trunk (0) directly after a country code, and nothing else', () => {
    expect(normalizeDialledNumber('+44 (0)20 7946 0018', '91')).toBe('+442079460018');
    expect(normalizeDialledNumber('+91 (0) 98204 61733', '91')).toBe('+919820461733');
    expect(normalizeDialledNumber('+44(0)2079460018', '91')).toBe('+442079460018');
    // A bracketed area code, or a (0) anywhere else, is formatting as before.
    expect(normalizeDialledNumber('+1 (415) 555-0100', '91')).toBe('+14155550100');
    expect(normalizeDialledNumber('+44 20 (0)7946 0018', '91')).toBe('+4420079460018');
    expect(normalizeDialledNumber('(0)98204 61733', '91')).toBe('+919820461733');
  });

  it('refuses what is not dialable', async () => {
    for (const to of ['', 'abc', '123', '+0123456789', 42, null]) {
      const r = await runManualPredial(input({ to }), deps());
      expect(r.ok ? null : r.refusal.code, String(to)).toBe('invalid_number');
    }
  });
});

describe('override notes (10–500 characters after trimming)', () => {
  it('accepts the bounds, trimmed', () => {
    expect(validateOverrideNote('  0123456789  ', 'dnc_note')).toEqual({ ok: true, note: '0123456789' });
    expect(validateOverrideNote('x'.repeat(500), 'hours_note')).toEqual({ ok: true, note: 'x'.repeat(500) });
    expect(validateOverrideNote(undefined, 'dnc_note')).toEqual({ ok: true, note: null });
  });

  it('counts characters (code points), as the database CHECK does, not UTF-16 units', () => {
    // Nine characters, ten UTF-16 units: the CHECK refuses it, so must this.
    expect(validateOverrideNote('12345678😀', 'dnc_note').ok).toBe(false);
    expect(validateOverrideNote('123456789😀', 'dnc_note')).toEqual({ ok: true, note: '123456789😀' });
    // 500 characters, 501 units: within the CHECK, so within this.
    expect(validateOverrideNote(`${'x'.repeat(499)}😀`, 'dnc_note').ok).toBe(true);
    expect(validateOverrideNote(`${'x'.repeat(500)}😀`, 'dnc_note').ok).toBe(false);
  });

  it('refuses outside them, and a non-string', () => {
    for (const raw of ['012345678', '          ', 'x'.repeat(501), 7, {}]) {
      const r = validateOverrideNote(raw, 'dnc_note');
      expect(r.ok ? null : r.refusal.code).toBe('override_note_invalid');
    }
  });

  it('a bad note is refused even when its refusal would not fire', async () => {
    const r = await runManualPredial(input({ overrides: { hours_note: 'short' } }), deps());
    expect(r.ok ? null : r.refusal).toMatchObject({
      code: 'override_note_invalid', details: [{ path: 'overrides.hours_note' }],
    });
  });
});

describe('caller ID: the allowed set and the selection order', () => {
  it('tagged: the campaign pool; a requested one must be in it', () => {
    expect(selectCallerId({ tag: tag(), accountNumbers: ['+15550000000'], settingsDefault: null, requested: '+919000000002' }))
      .toEqual({ ok: true, callerId: '+919000000002' });
    const refused = selectCallerId({ tag: tag(), accountNumbers: ['+15550000000'], settingsDefault: null, requested: '+15550000000' });
    expect(refused.ok ? null : refused.refusal).toEqual({
      code: 'caller_id_not_allowed', allowed_codes: ['+919000000001', '+919000000002'],
    });
  });

  it('tagged, none requested: the round-robin pick from the pool (never the settings default)', () => {
    const r = selectCallerId({ tag: tag(), accountNumbers: [], settingsDefault: '+919000000002', requested: undefined });
    expect(r.ok && ['+919000000001', '+919000000002'].includes(r.callerId)).toBe(true);
    const junk = selectCallerId({ tag: tag({ caller_ids: ['', '  '] }), accountNumbers: [], settingsDefault: null, requested: undefined });
    expect(junk.ok ? null : junk.refusal.code).toBe('caller_id_not_allowed');
  });

  it('untagged: the account numbers; settings default when allowed, else the account default (first)', () => {
    const numbers = ['+15550000001', '+15550000002'];
    expect(selectCallerId({ tag: null, accountNumbers: numbers, settingsDefault: '+15550000002', requested: undefined }))
      .toEqual({ ok: true, callerId: '+15550000002' });
    // A stale settings default (no longer assigned) falls to the account default.
    expect(selectCallerId({ tag: null, accountNumbers: numbers, settingsDefault: '+19999999999', requested: undefined }))
      .toEqual({ ok: true, callerId: '+15550000001' });
    expect(selectCallerId({ tag: null, accountNumbers: numbers, settingsDefault: null, requested: '+15550000002' }))
      .toEqual({ ok: true, callerId: '+15550000002' });
    const none = selectCallerId({ tag: null, accountNumbers: [], settingsDefault: null, requested: undefined });
    expect(none.ok ? null : none.refusal).toEqual({ code: 'caller_id_not_allowed', allowed_codes: [] });
  });
});

describe('caller ID: a matched contact whose owner has a dedicated number (DN4)', () => {
  const POOL = ['+919000000001', '+919000000002', '+919000000003'];
  const tagged = tag({ caller_ids: POOL });
  const DEDICATED = new Map([[OTHER_AGENT, '+919000000002'], ['agent-9', '+919000000003']]);
  const owned = (owner: string | null, state = 'pending') => contact('c1', state, { assigned_user_id: owner });

  it('the default is the owner\'s number (the agent dialling need not be the owner)', async () => {
    const d = deps({ matches: [owned(OTHER_AGENT)], dedicated: DEDICATED });
    const r = await runManualPredial(input({ tag: tagged }), d);
    expect(r.ok && r.plan.callerId).toBe('+919000000002');
    expect(d.findDedicatedCallerIds).toHaveBeenCalledWith('camp-1');
  });

  it('a requested different in-set number is replaced by the owner\'s number (what both clients send by default)', async () => {
    // Both clients send the tag's caller_ids[0] by default; the owner's number wins.
    for (const requestedCallerId of ['+919000000001', ' +919000000003 ', ' +919000000002 ']) {
      const r = await runManualPredial(input({ tag: tagged, requestedCallerId }),
        deps({ matches: [owned(OTHER_AGENT)], dedicated: DEDICATED }));
      expect(r.ok && r.plan.callerId, requestedCallerId).toBe('+919000000002');
    }
    expect(selectCallerId({
      tag: tagged, accountNumbers: [], settingsDefault: null, requested: '+919000000001',
      dedicated: DEDICATED, ownerUserId: OTHER_AGENT,
    })).toEqual({ ok: true, callerId: '+919000000002' });
  });

  it('an out-of-set number is still refused when the owner has a number, with the campaign\'s whole set', async () => {
    const refused = await runManualPredial(input({ tag: tagged, requestedCallerId: '+15550000000' }),
      deps({ matches: [owned(OTHER_AGENT)], dedicated: DEDICATED }));
    expect(refused.ok ? null : refused.refusal).toEqual({ code: 'caller_id_not_allowed', allowed_codes: POOL });
    const notString = selectCallerId({
      tag: tagged, accountNumbers: [], settingsDefault: null, requested: 42, dedicated: DEDICATED, ownerUserId: OTHER_AGENT,
    });
    expect(notString.ok ? null : notString.refusal).toEqual({ code: 'caller_id_not_allowed', allowed_codes: POOL });
  });

  it('unmatched, unowned, or an owner without a number: the campaign\'s caller IDs allowed, the default from the rotation', async () => {
    for (const matches of [[], [owned(null)], [owned(AGENT)]]) {
      const r = await runManualPredial(input({ tag: tagged }), deps({ matches, dedicated: DEDICATED }));
      // The rotation: the pool minus both dedicated numbers.
      expect(r.ok && r.plan.callerId, JSON.stringify(matches)).toBe('+919000000001');
      // Another agent's dedicated number requested: not dialled for a contact that is not
      // theirs; the rotation's number instead.
      const requested = await runManualPredial(input({ tag: tagged, requestedCallerId: '+919000000003' }), deps({ matches, dedicated: DEDICATED }));
      expect(requested.ok && requested.plan.callerId, JSON.stringify(matches)).toBe('+919000000001');
      const outside = await runManualPredial(input({ tag: tagged, requestedCallerId: '+15550000000' }), deps({ matches, dedicated: DEDICATED }));
      expect(outside.ok ? null : outside.refusal).toEqual({ code: 'caller_id_not_allowed', allowed_codes: POOL });
    }
  });

  it('an unowned contact with another agent\'s dedicated number requested goes out from the rotation', () => {
    // The mobile app's default caller_ids[0], a console hand-pick or a redial resending the
    // old number: none of them dials agent-2's number for a contact that is not agent-2's.
    const rotationOnly = tag({ caller_ids: ['+919000000002', '+919000000001'] });
    for (const ownerUserId of [null, undefined]) {
      expect(selectCallerId({
        tag: rotationOnly, accountNumbers: [], settingsDefault: null, requested: '+919000000002',
        dedicated: new Map([[OTHER_AGENT, '+919000000002']]), ownerUserId,
      })).toEqual({ ok: true, callerId: '+919000000001' });
    }
  });

  it('owned by an agent without a number, with another agent\'s number requested: the rotation', () => {
    expect(selectCallerId({
      tag: tagged, accountNumbers: [], settingsDefault: null, requested: '+919000000002',
      dedicated: DEDICATED, ownerUserId: AGENT,
    })).toEqual({ ok: true, callerId: '+919000000001' });
  });

  it('a requested rotation number is kept', () => {
    const fourNumbers = tag({ caller_ids: [...POOL, '+919000000004'] });
    for (const ownerUserId of [null, AGENT]) {
      expect(selectCallerId({
        tag: fourNumbers, accountNumbers: [], settingsDefault: null, requested: ' +919000000004 ',
        dedicated: DEDICATED, ownerUserId,
      })).toEqual({ ok: true, callerId: '+919000000004' });
    }
  });

  it('every number dedicated: the rotation is the whole list (DN3), so the requested number is kept', () => {
    const allDedicated = tag({ caller_ids: ['+919000000002', '+919000000003'] });
    for (const requested of ['+919000000002', '+919000000003']) {
      expect(selectCallerId({
        tag: allDedicated, accountNumbers: [], settingsDefault: null, requested,
        dedicated: DEDICATED, ownerUserId: null,
      })).toEqual({ ok: true, callerId: requested });
    }
    // The owner's number still wins over the request.
    expect(selectCallerId({
      tag: allDedicated, accountNumbers: [], settingsDefault: null, requested: '+919000000003',
      dedicated: DEDICATED, ownerUserId: OTHER_AGENT,
    })).toEqual({ ok: true, callerId: '+919000000002' });
  });

  it('an owner\'s number the campaign no longer has does not count', async () => {
    const r = await runManualPredial(input({ tag: tag({ caller_ids: ['+919000000001', '+919000000003'] }), requestedCallerId: '+919000000001' }),
      deps({ matches: [owned(OTHER_AGENT)], dedicated: DEDICATED }));
    expect(r.ok && r.plan.callerId).toBe('+919000000001');
  });

  it('the refusal order holds: a caller ID outside the set before a match in flight', async () => {
    const r = await runManualPredial(input({ tag: tagged, requestedCallerId: '+15550000000' }),
      deps({ matches: [owned(OTHER_AGENT, 'in_flight')], dedicated: DEDICATED }));
    expect(r.ok ? null : r.refusal).toEqual({ code: 'caller_id_not_allowed', allowed_codes: POOL });
    const inFlight = await runManualPredial(input({ tag: tagged }), deps({ matches: [owned(OTHER_AGENT, 'in_flight')], dedicated: DEDICATED }));
    expect(inFlight.ok ? null : inFlight.refusal.code).toBe('contact_in_flight');
  });

  it('untagged calls never read dedications', async () => {
    const d = deps({ dedicated: DEDICATED });
    const r = await runManualPredial(input({ tag: null, accountNumbers: ['+15550000001'] }), d);
    expect(r.ok && r.plan.callerId).toBe('+15550000001');
    expect(d.findDedicatedCallerIds).not.toHaveBeenCalled();
  });
});

describe('the roster match', () => {
  it('any in_flight match refuses, naming it', () => {
    const r = pickRosterContact('camp-1', [contact('c1', 'pending'), contact('c2', 'in_flight')]);
    expect(r.ok ? null : r.refusal).toEqual({ code: 'contact_in_flight', campaign_id: 'camp-1', contact_id: 'c2' });
  });

  it('else the oldest pending, else the oldest of any state', () => {
    expect(pickRosterContact('camp-1', [contact('c1', 'completed'), contact('c2', 'pending'), contact('c3', 'pending')]))
      .toMatchObject({ ok: true, contact: { id: 'c2' } });
    expect(pickRosterContact('camp-1', [contact('c1', 'completed'), contact('c2', 'suppressed')]))
      .toMatchObject({ ok: true, contact: { id: 'c1' } });
    expect(pickRosterContact('camp-1', [])).toEqual({ ok: true, contact: null });
  });

  it('is skipped for an untagged call, which claims and links nothing', async () => {
    const d = deps();
    const r = await runManualPredial(input({ tag: null, accountNumbers: ['+15550000001'] }), d);
    expect(r.ok && r.plan.contact).toBeNull();
    expect(d.findRosterMatches).not.toHaveBeenCalled();
    expect(d.findInFlightInAccount).toHaveBeenCalledWith('+919811100001');
  });

  it('untagged: the number in flight on any campaign of the account refuses, naming that campaign', async () => {
    const live = contact('c9', 'in_flight', { campaign_id: 'camp-other' } as Partial<AgencyContactRecord>);
    const d = deps({ inFlight: live });
    const r = await runManualPredial(input({ tag: null, accountNumbers: ['+15550000001'] }), d);
    expect(r.ok ? null : r.refusal).toEqual({ code: 'contact_in_flight', campaign_id: 'camp-other', contact_id: 'c9' });
    // Refused before DNC is asked, as a tagged in-flight match is.
    expect(d.dnc.checkEntry).not.toHaveBeenCalled();
  });

  it('tagged: the number in flight on a sibling campaign of the account refuses, naming THAT campaign and contact (MC4)', async () => {
    // A running retry parent (or another roster carrying the number) is ringing the
    // customer; the tag's own match is a pending contact that would otherwise be claimed.
    const sibling = contact('c9', 'in_flight', { campaign_id: 'camp-parent' } as Partial<AgencyContactRecord>);
    const d = deps({ matches: [contact('c1', 'pending')], inFlight: sibling });
    const r = await runManualPredial(input(), d);
    expect(r.ok ? null : r.refusal).toEqual({ code: 'contact_in_flight', campaign_id: 'camp-parent', contact_id: 'c9' });
    expect(d.findRosterMatches).toHaveBeenCalledWith('camp-1', '+919811100001');
    expect(d.findInFlightInAccount).toHaveBeenCalledWith('+919811100001');
    // No override reaches past it, and nothing after it is asked.
    expect(d.dnc.checkEntry).not.toHaveBeenCalled();
  });

  it('tagged: the refusal holds with every override note given, and with no roster match on the tag', async () => {
    const sibling = contact('c9', 'in_flight', { campaign_id: 'camp-parent' } as Partial<AgencyContactRecord>);
    const r = await runManualPredial(
      input({ overrides: { dnc_note: 'customer asked for this call', hours_note: 'customer asked for this call' } }),
      deps({ matches: [], inFlight: sibling }),
    );
    expect(r.ok ? null : r.refusal).toEqual({ code: 'contact_in_flight', campaign_id: 'camp-parent', contact_id: 'c9' });
  });

  it('tagged: the tag\'s own in-flight match is named first, before the account-wide read', async () => {
    const d = deps({
      matches: [contact('c2', 'in_flight')],
      inFlight: contact('c9', 'in_flight', { campaign_id: 'camp-parent' } as Partial<AgencyContactRecord>),
    });
    const r = await runManualPredial(input(), d);
    expect(r.ok ? null : r.refusal).toEqual({ code: 'contact_in_flight', campaign_id: 'camp-1', contact_id: 'c2' });
    expect(d.findInFlightInAccount).not.toHaveBeenCalled();
  });

  it('tagged: a number connected elsewhere on the account is not refused (only in_flight is; decisions §5)', async () => {
    // The account-wide read answers only `in_flight` rows, so a sibling's `connected`
    // contact never reaches it: the dial goes ahead and claims the tag's pending match.
    const d = deps({ matches: [contact('c1', 'pending')], inFlight: null });
    const r = await runManualPredial(input(), d);
    expect(r.ok && r.plan.contact?.id).toBe('c1');
    expect(d.findInFlightInAccount).toHaveBeenCalledWith('+919811100001');
  });

  it('tagged: the account-wide refusal comes before the strict owner check', async () => {
    const d = deps({
      matches: [contact('c1', 'pending', { assigned_user_id: OTHER_AGENT })],
      inFlight: contact('c9', 'in_flight', { campaign_id: 'camp-parent' } as Partial<AgencyContactRecord>),
    });
    const r = await runManualPredial(input({ tag: tag({ assignment_mode: 'strict' }) }), d);
    expect(r.ok ? null : r.refusal.code).toBe('contact_in_flight');
  });
});

describe('contact assignment: a strict campaign\'s contact of another agent', () => {
  const strict = tag({ assignment_mode: 'strict' });
  const owned = (owner: string | null) => contact('c1', 'pending', { assigned_user_id: owner });

  it('refuses contact_assigned_elsewhere, before the window and DNC are asked', async () => {
    const d = deps({ matches: [owned(OTHER_AGENT)] });
    const r = await runManualPredial(input({ tag: strict }), d);
    expect(r.ok ? null : r.refusal).toEqual({ code: 'contact_assigned_elsewhere' });
    expect(d.dnc.checkEntry).not.toHaveBeenCalled();
  });

  it('allows the caller\'s own contact and a contact in the pool', async () => {
    for (const owner of [AGENT, null]) {
      const r = await runManualPredial(input({ tag: strict }), deps({ matches: [owned(owner)] }));
      expect(r.ok && r.plan.contact?.id, String(owner)).toBe('c1');
    }
  });

  it('allows a supervisor (the API layer checked agency.supervise)', async () => {
    const r = await runManualPredial(
      input({ tag: strict, actor: { userId: AGENT, supervise: true } }),
      deps({ matches: [owned(OTHER_AGENT)] }),
    );
    expect(r.ok && r.plan.contact?.id).toBe('c1');
  });

  it('does not refuse on a pool or preferred campaign', async () => {
    for (const mode of ['pool', 'preferred'] as const) {
      const r = await runManualPredial(
        input({ tag: tag({ assignment_mode: mode }) }),
        deps({ matches: [owned(OTHER_AGENT)] }),
      );
      expect(r.ok && r.plan.contact?.id, mode).toBe('c1');
    }
  });

  it('judges the contact the guard picked: another agent\'s finished row does not refuse when a pending one is the caller\'s', async () => {
    const r = await runManualPredial(input({ tag: strict }), deps({
      matches: [
        contact('c0', 'completed', { assigned_user_id: OTHER_AGENT }),
        contact('c1', 'pending', { assigned_user_id: AGENT }),
      ],
    }));
    expect(r.ok && r.plan.contact?.id).toBe('c1');
  });

  it('assignedElsewhere: the rule on its own', () => {
    const me = { userId: AGENT, supervise: false };
    expect(assignedElsewhere({ assignment_mode: 'strict' }, { assigned_user_id: OTHER_AGENT }, me)).toBe(true);
    expect(assignedElsewhere({ assignment_mode: 'strict' }, { assigned_user_id: AGENT }, me)).toBe(false);
    expect(assignedElsewhere({ assignment_mode: 'strict' }, { assigned_user_id: null }, me)).toBe(false);
    expect(assignedElsewhere({ assignment_mode: 'strict' }, null, me)).toBe(false);
    expect(assignedElsewhere({ assignment_mode: 'strict' }, { assigned_user_id: OTHER_AGENT }, { ...me, supervise: true })).toBe(false);
    expect(assignedElsewhere({ assignment_mode: 'preferred' }, { assigned_user_id: OTHER_AGENT }, me)).toBe(false);
    expect(assignedElsewhere({ assignment_mode: 'pool' }, { assigned_user_id: OTHER_AGENT }, me)).toBe(false);
  });
});

describe('calling hours (SP2)', () => {
  const closed = tag({ calling_window_start: '09:00:00', calling_window_end: '10:00:00', default_timezone: 'Asia/Kolkata' });

  it('refuses outside the window with the window, its source and the next opening', async () => {
    const r = await runManualPredial(input({ tag: closed }), deps());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toMatchObject({
      code: 'outside_calling_hours',
      window: { start: '09:00:00', end: '10:00:00', timezone: 'Asia/Kolkata' },
      timezone_source: 'campaign_default',
    });
    // Next opening: Saturday 09:00 in Kolkata.
    expect((r.refusal as { next_open_at: string }).next_open_at).toBe('2026-10-31T03:30:00.000Z');
  });

  it('uses the matched contact\'s timezone', async () => {
    // 10:00 UTC is 06:00 in New York: closed there, though open in UTC.
    const utcWindow = tag({ calling_window_start: '09:00:00', calling_window_end: '17:00:00', default_timezone: 'UTC' });
    const r = await runManualPredial(input({ tag: utcWindow }), deps({
      matches: [contact('c1', 'pending', { timezone: 'America/New_York' })],
    }));
    expect(r.ok ? null : r.refusal).toMatchObject({ code: 'outside_calling_hours', timezone_source: 'contact' });
    const open = await runManualPredial(input({ tag: utcWindow }), deps());
    expect(open.ok).toBe(true);
  });

  it('an hours note overrides it, and is stored only when it was needed', async () => {
    const r = await runManualPredial(input({ tag: closed, overrides: { hours_note: 'Customer asked for this time.' } }), deps());
    expect(r.ok && r.plan.hoursOverrideNote).toBe('Customer asked for this time.');
    const unneeded = await runManualPredial(input({ overrides: { hours_note: 'Customer asked for this time.' } }), deps());
    expect(unneeded.ok && unneeded.plan.hoursOverrideNote).toBeNull();
  });

  it('untagged calls have no window', async () => {
    const r = await runManualPredial(input({ tag: null, accountNumbers: ['+15550000001'] }), deps());
    expect(r.ok).toBe(true);
  });
});

describe('DNC (SP1)', () => {
  it('checks tenant, account and the tag; untagged, tenant, account and every campaign of the account', async () => {
    const d = deps();
    await runManualPredial(input(), d);
    expect(d.dnc.checkEntry).toHaveBeenCalledWith('t1', '+919811100001', { accountId: 'a1', campaignId: 'camp-1' });
    const u = deps();
    await runManualPredial(input({ tag: null, accountNumbers: ['+15550000001'] }), u);
    expect(u.dnc.checkEntry).toHaveBeenCalledWith('t1', '+919811100001', { accountId: 'a1', everyCampaignOfAccount: true });
  });

  it('untagged: a campaign-scoped hit refuses dnc_listed with that entry, and a note overrides it', async () => {
    const r = await runManualPredial(
      input({ tag: null, accountNumbers: ['+15550000001'] }),
      deps({ dnc: { result: 'suppressed', entry: ENTRY } }),
    );
    expect(r.ok ? null : r.refusal).toMatchObject({ code: 'dnc_listed', entry: { id: 'dnc-1', scope: 'campaign' } });
    const o = await runManualPredial(
      input({ tag: null, accountNumbers: ['+15550000001'], overrides: { dnc_note: 'The customer rang us asking to be called.' } }),
      deps({ dnc: { result: 'suppressed', entry: ENTRY } }),
    );
    expect(o.ok && o.plan.dncOverride).toEqual({ note: 'The customer rang us asking to be called.', entryId: 'dnc-1' });
    const down = await runManualPredial(
      input({ tag: null, accountNumbers: ['+15550000001'], overrides: { dnc_note: 'The customer rang us asking to be called.' } }),
      deps({ dnc: { result: 'unavailable' } }),
    );
    expect(down.ok ? null : down.refusal.code).toBe('dnc_unavailable');
  });

  it('a hit refuses with the entry; a DNC note overrides it and records the entry id', async () => {
    const r = await runManualPredial(input(), deps({ dnc: { result: 'suppressed', entry: ENTRY } }));
    expect(r.ok ? null : r.refusal).toEqual({
      code: 'dnc_listed',
      entry: { id: 'dnc-1', scope: 'campaign', reason: 'asked', created_at: '2026-10-01T00:00:00.000Z' },
    });
    const o = await runManualPredial(
      input({ overrides: { dnc_note: ' The customer rang us asking to be called. ' } }),
      deps({ dnc: { result: 'suppressed', entry: ENTRY } }),
    );
    expect(o.ok && o.plan.dncOverride).toEqual({ note: 'The customer rang us asking to be called.', entryId: 'dnc-1' });
  });

  it('a lookup failure refuses and is NOT overridable', async () => {
    const r = await runManualPredial(
      input({ overrides: { dnc_note: 'Long enough to be a valid note.' } }),
      deps({ dnc: { result: 'unavailable' } }),
    );
    expect(r.ok ? null : r.refusal.code).toBe('dnc_unavailable');
  });

  it('runs after the window: an out-of-hours dial never asks the DNC store', async () => {
    const d = deps({ dnc: { result: 'unavailable' } });
    const r = await runManualPredial(input({ tag: tag({ calling_window_start: '09:00:00', calling_window_end: '09:00:00' }) }), d);
    expect(r.ok ? null : r.refusal.code).toBe('outside_calling_hours');
    expect(d.dnc.checkEntry).not.toHaveBeenCalled();
  });
});

describe('what the dial uses', () => {
  it('tagged: the tag\'s recording and profile, the claimable contact', async () => {
    const r = await runManualPredial(input(), deps({ matches: [contact('c1', 'pending')] }));
    expect(r.ok && r.plan).toMatchObject({
      destinationE164: '+919811100001', recordingRequested: true, analysisProfileId: 'prof-tag',
      contact: { id: 'c1' }, dncOverride: null, hoursOverrideNote: null,
    });
    const noProfile = await runManualPredial(
      input({ tag: tag({ analysis_profile_id: null, record_calls: false }), settings: { ...SOFTPHONE_SETTINGS_DEFAULTS, analysis_profile_id: 'prof-set', record_calls: true } }),
      deps(),
    );
    expect(noProfile.ok && noProfile.plan).toMatchObject({ recordingRequested: false, analysisProfileId: 'prof-set' });
  });

  it('untagged: the settings\' recording and profile, else null (the account default applies later)', async () => {
    const r = await runManualPredial(
      input({ tag: null, accountNumbers: ['+15550000001'], settings: { ...SOFTPHONE_SETTINGS_DEFAULTS, record_calls: true, analysis_profile_id: 'prof-set' } }),
      deps(),
    );
    expect(r.ok && r.plan).toMatchObject({ recordingRequested: true, analysisProfileId: 'prof-set', contact: null });
    const bare = await runManualPredial(input({ tag: null, accountNumbers: ['+15550000001'] }), deps());
    expect(bare.ok && bare.plan).toMatchObject({ recordingRequested: false, analysisProfileId: null });
  });
});

describe('softphoneCarrier — the carrier account a soft-phone call is placed on', () => {
  const numbers = [
    { phone_number: '+919000000001', provider_name: 'voicelink', telephony_credential_id: null },
    { phone_number: '+14155550111', provider_name: 'plivo', telephony_credential_id: 'cred-1' },
  ];

  it('tagged: the campaign`s carrier and pinned credential, whatever the number list says', () => {
    expect(softphoneCarrier({ telephony_provider: 'plivo', telephony_credential_id: 'cred-9' }, numbers, '+919000000001'))
      .toEqual({ provider: 'plivo', telephonyCredentialId: 'cred-9' });
    expect(softphoneCarrier({ telephony_provider: 'voicelink', telephony_credential_id: null }, [], '+919000000001'))
      .toEqual({ provider: 'voicelink', telephonyCredentialId: null });
  });

  it('untagged: the chosen caller ID`s number decides: a synced number dials its own credential', () => {
    expect(softphoneCarrier(null, numbers, '+14155550111')).toEqual({ provider: 'plivo', telephonyCredentialId: 'cred-1' });
    expect(softphoneCarrier(null, numbers, '+919000000001')).toEqual({ provider: 'voicelink', telephonyCredentialId: null });
  });

  it('untagged, a caller ID not among the numbers (or with no carrier): nothing named, the bridge default', () => {
    expect(softphoneCarrier(null, numbers, '+447700900000')).toEqual({});
    expect(softphoneCarrier(null, [{ phone_number: '+447700900000' }], '+447700900000')).toEqual({});
  });
});
