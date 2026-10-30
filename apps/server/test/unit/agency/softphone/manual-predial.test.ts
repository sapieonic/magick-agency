import { describe, it, expect, vi } from 'vitest';
import {
  normalizeDialledNumber,
  pickRosterContact,
  runManualPredial,
  selectCallerId,
  validateOverrideNote,
  type ManualPredialInput,
} from '../../../../src/agency/softphone/manual-predial.js';
import { SOFTPHONE_SETTINGS_DEFAULTS } from '../../../../src/db/repositories/agency.repository.js';
import type { AgencyCampaignRecord, AgencyContactRecord } from '../../../../src/db/models/agency.model.js';

/*
 * The soft phone's pre-dial (docs/softphone.md §4.1 step 2, SP1, SP2): every
 * refusal, every override, the note bounds, the caller-ID selection order and the
 * number's normalisation. Pure apart from the two injected reads.
 */

const NOW = new Date('2026-10-30T10:00:00Z'); // a Friday, 15:30 in Kolkata

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
    ...over,
  };
}

function deps(opts: { matches?: AgencyContactRecord[]; dnc?: unknown } = {}) {
  return {
    dnc: { checkEntry: vi.fn().mockResolvedValue(opts.dnc ?? { result: 'clear' }) },
    findRosterMatches: vi.fn().mockResolvedValue(opts.matches ?? []),
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

  it('is skipped for an untagged call', async () => {
    const d = deps();
    const r = await runManualPredial(input({ tag: null, accountNumbers: ['+15550000001'] }), d);
    expect(r.ok).toBe(true);
    expect(d.findRosterMatches).not.toHaveBeenCalled();
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
  it('checks tenant, account and the tag', async () => {
    const d = deps();
    await runManualPredial(input(), d);
    expect(d.dnc.checkEntry).toHaveBeenCalledWith('t1', '+919811100001', { accountId: 'a1', campaignId: 'camp-1' });
    const u = deps();
    await runManualPredial(input({ tag: null, accountNumbers: ['+15550000001'] }), u);
    expect(u.dnc.checkEntry).toHaveBeenCalledWith('t1', '+919811100001', { accountId: 'a1', campaignId: null });
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
