import { describe, it, expect } from 'vitest';
import {
  blockReason,
  canSubmit,
  buildSubmitPayload,
  dispositionForNumberKey,
  noteSatisfied,
  EMPTY_DISPOSITION_FORM,
  DISPOSITION_BLOCK_COPY,
} from '../../utils/agencyDispositionForm';
import type { AgencyDisposition } from '../../types/agency';

/**
 * `AD-P2-U-01` criterion (c): *a required note blocks submission client-side and
 * is also enforced server-side.* This file owns the client half. The server half
 * is core's, and the two are not redundant — the client guard exists so an agent
 * is never left pressing a button that will fail.
 */

const CATALOG: AgencyDisposition[] = [
  { code: 'sale', label: 'Sale', is_success: true },
  { code: 'not_interested', label: 'Not interested', terminal: true },
  { code: 'complaint', label: 'Complaint', requires_note: true },
  { code: 'callback', label: 'Callback', requires_datetime: true },
  { code: 'voicemail', label: 'Voicemail' },
];

const NOW = Date.parse('2026-08-11T12:00:00.000Z');

describe('block reasons', () => {
  it('blocks with nothing selected', () => {
    expect(blockReason(CATALOG, EMPTY_DISPOSITION_FORM, NOW)).toBe('no_selection');
  });

  it('allows a plain code with no requirements', () => {
    expect(canSubmit(CATALOG, { ...EMPTY_DISPOSITION_FORM, selectedCode: 'sale' }, NOW)).toBe(true);
  });

  it('treats an unknown code as no selection', () => {
    // A stale catalog after an admin edit: the safe reading is "nothing chosen",
    // not "chosen and valid".
    expect(blockReason(CATALOG, { ...EMPTY_DISPOSITION_FORM, selectedCode: 'ghost' }, NOW))
      .toBe('no_selection');
  });
});

describe('requires_note — criterion (c), client half', () => {
  it('blocks submission while the note is empty', () => {
    expect(blockReason(CATALOG, { ...EMPTY_DISPOSITION_FORM, selectedCode: 'complaint' }, NOW))
      .toBe('note_required');
  });

  it('does not accept whitespace', () => {
    // A note of three spaces satisfying a compliance-adjacent requirement is a
    // bug, and it is exactly what an agent under time pressure will type.
    for (const notes of ['   ', '\t', '\n\n', ' \t \n ']) {
      expect(
        blockReason(CATALOG, { ...EMPTY_DISPOSITION_FORM, selectedCode: 'complaint', notes }, NOW),
        `"${JSON.stringify(notes)}" must not satisfy a required note`,
      ).toBe('note_required');
    }
  });

  it('accepts any non-empty note, with no minimum length', () => {
    // A character floor does not produce better notes, it produces `asdfasdf`.
    expect(canSubmit(
      CATALOG,
      { ...EMPTY_DISPOSITION_FORM, selectedCode: 'complaint', notes: 'x' },
      NOW,
    )).toBe(true);
  });

  it('does not require a note for a code that does not ask for one', () => {
    expect(noteSatisfied(CATALOG[0]!, '')).toBe(true);
    expect(noteSatisfied(null, '')).toBe(true);
  });

  it('re-evaluates cleanly as the field is typed and cleared', () => {
    // The caller re-runs this on every keystroke rather than on blur: a button
    // that stays disabled until blur reads as broken.
    const form = { ...EMPTY_DISPOSITION_FORM, selectedCode: 'complaint' };
    expect(canSubmit(CATALOG, { ...form, notes: '' }, NOW)).toBe(false);
    expect(canSubmit(CATALOG, { ...form, notes: 'a' }, NOW)).toBe(true);
    expect(canSubmit(CATALOG, { ...form, notes: '' }, NOW)).toBe(false);
  });
});

describe('requires_datetime — callback', () => {
  const form = { ...EMPTY_DISPOSITION_FORM, selectedCode: 'callback' };

  it('blocks with no time chosen', () => {
    expect(blockReason(CATALOG, form, NOW)).toBe('datetime_required');
  });

  it('treats an unparseable value as absent rather than as its own error', () => {
    expect(blockReason(CATALOG, { ...form, callbackAt: 'tomorrow-ish' }, NOW))
      .toBe('datetime_required');
  });

  it('refuses a time in the past', () => {
    expect(blockReason(CATALOG, { ...form, callbackAt: '2026-08-11T11:00:00.000Z' }, NOW))
      .toBe('callback_in_past');
  });

  it('refuses the present instant', () => {
    expect(blockReason(CATALOG, { ...form, callbackAt: '2026-08-11T12:00:00.000Z' }, NOW))
      .toBe('callback_in_past');
  });

  it('accepts a future time', () => {
    expect(canSubmit(CATALOG, { ...form, callbackAt: '2026-08-12T10:00:00.000Z' }, NOW)).toBe(true);
  });
});

describe('copy', () => {
  it('has a sentence for every block reason', () => {
    for (const reason of ['no_selection', 'note_required', 'datetime_required', 'callback_in_past'] as const) {
      expect(DISPOSITION_BLOCK_COPY[reason].length).toBeGreaterThan(0);
    }
  });

  it('never says "I" — CR-1, because a callback may not be this agent', () => {
    // D11: a callback re-enters the roster as an ordinary pending contact and
    // whichever agent is available takes it. Copy promising otherwise is a
    // promise the product breaks.
    for (const copy of Object.values(DISPOSITION_BLOCK_COPY)) {
      expect(copy).not.toMatch(/\bI\b|\bI'll\b|\bmy\b/);
    }
  });
});

describe('buildSubmitPayload', () => {
  it('returns null when the form would not pass its own guard', () => {
    // So a caller cannot construct a request the guard would have refused.
    expect(buildSubmitPayload(CATALOG, EMPTY_DISPOSITION_FORM, NOW)).toBeNull();
    expect(buildSubmitPayload(
      CATALOG,
      { ...EMPTY_DISPOSITION_FORM, selectedCode: 'complaint', notes: '  ' },
      NOW,
    )).toBeNull();
  });

  it('sends only the code when there is nothing else', () => {
    expect(buildSubmitPayload(CATALOG, { ...EMPTY_DISPOSITION_FORM, selectedCode: 'sale' }, NOW))
      .toEqual({ disposition_code: 'sale' });
  });

  it('trims the note', () => {
    expect(buildSubmitPayload(
      CATALOG,
      { ...EMPTY_DISPOSITION_FORM, selectedCode: 'complaint', notes: '  billing dispute  ' },
      NOW,
    )).toEqual({ disposition_code: 'complaint', notes: 'billing dispute' });
  });

  it('sends a note on a code that does not require one — the agent meant it', () => {
    expect(buildSubmitPayload(
      CATALOG,
      { ...EMPTY_DISPOSITION_FORM, selectedCode: 'sale', notes: 'upgraded to annual' },
      NOW,
    )).toEqual({ disposition_code: 'sale', notes: 'upgraded to annual' });
  });

  it('omits an empty note rather than sending an empty string', () => {
    // An empty string would overwrite a note already saved through the separate
    // notes route.
    const payload = buildSubmitPayload(
      CATALOG,
      { ...EMPTY_DISPOSITION_FORM, selectedCode: 'sale', notes: '   ' },
      NOW,
    );
    expect(payload).toEqual({ disposition_code: 'sale' });
    expect(payload).not.toHaveProperty('notes');
  });

  it('normalises callback_at to ISO-8601 UTC', () => {
    expect(buildSubmitPayload(
      CATALOG,
      { ...EMPTY_DISPOSITION_FORM, selectedCode: 'callback', callbackAt: '2026-08-12T10:00:00.000Z' },
      NOW,
    )).toEqual({ disposition_code: 'callback', callback_at: '2026-08-12T10:00:00.000Z' });
  });

  it('does not send callback_at for a code that does not take one', () => {
    const payload = buildSubmitPayload(
      CATALOG,
      { ...EMPTY_DISPOSITION_FORM, selectedCode: 'sale', callbackAt: '2026-08-12T10:00:00.000Z' },
      NOW,
    );
    expect(payload).not.toHaveProperty('callback_at');
  });
});

describe('number-key mapping', () => {
  it('maps 1-9 to catalog order, verbatim', () => {
    // The catalog is NEVER re-sorted — not by label, not by success flag. A
    // client-side sort silently remaps every agent's muscle memory the moment an
    // admin renames a code, and both orders look reasonable in review.
    expect(dispositionForNumberKey(CATALOG, '1')?.code).toBe('sale');
    expect(dispositionForNumberKey(CATALOG, '3')?.code).toBe('complaint');
    expect(dispositionForNumberKey(CATALOG, '5')?.code).toBe('voicemail');
  });

  it('preserves an order a sort would change', () => {
    // Alphabetically 'callback' would come first; by success flag 'sale' would.
    // Neither may happen.
    const codes = CATALOG.map((c) => c.code);
    expect(codes.map((_, i) => dispositionForNumberKey(CATALOG, String(i + 1))?.code)).toEqual(codes);
  });

  it('does nothing for a key with no entry behind it', () => {
    // Pressing 7 against a five-code catalog must not wrap around to something.
    expect(dispositionForNumberKey(CATALOG, '7')).toBeNull();
    expect(dispositionForNumberKey(CATALOG, '9')).toBeNull();
  });

  it('ignores 0 and non-digits', () => {
    expect(dispositionForNumberKey(CATALOG, '0')).toBeNull();
    expect(dispositionForNumberKey(CATALOG, 'a')).toBeNull();
    expect(dispositionForNumberKey(CATALOG, 'Enter')).toBeNull();
  });
});
