import { describe, expect, it } from 'vitest';
import {
  CLIP_SLOT_LABELS,
  MISSED_REASON_LABELS,
  RECORDING_UPLOAD_REFUSAL_COPY,
  STICKY_MODE_LABELS,
  recordingLength,
  recordingUsedBy,
} from '../../utils/inbound/inboundCopy';
import { AGENCY_INBOUND_SLOT_STANDARD, AGENCY_INBOUND_STANDARD_WORDS, AGENCY_INBOUND_CLIP_SLOTS } from '../../types/inbound';

/**
 * The route editor's words say what callers actually hear (`docs/inbound.md` §3.4, §4.3): a
 * message with no recording of the account's is our standard recording (its words quoted from the
 * contract the server plays and speaks), the hold is the built-in tone, and "Wait for their agent"
 * says that an agent who is away sends the caller to the team at once.
 */

describe('what each clip slot plays with no recording of the account’s', () => {
  it('quotes our standard recording’s exact words, and never claims silence, a standard voice or no hold sound', () => {
    for (const slot of AGENCY_INBOUND_CLIP_SLOTS) {
      const copy = CLIP_SLOT_LABELS[slot];
      const standard = AGENCY_INBOUND_SLOT_STANDARD[slot];
      if (standard) {
        expect(copy.none).toBe('Our standard recording');
        expect(copy.hint).toContain(`“${AGENCY_INBOUND_STANDARD_WORDS[standard]}”`);
      }
      expect(`${copy.hint} ${copy.none}`).not.toMatch(/standard voice|Standard spoken|No hold music|No greeting|No notice|Contact support/);
    }
    expect(CLIP_SLOT_LABELS.hold.none).toBe('Built-in hold tone');
  });
});

describe('the sticky modes', () => {
  it('“Wait for their agent” says an agent who is away sends the caller to the team at once', () => {
    expect(STICKY_MODE_LABELS.strict.label).toBe('Wait for their agent');
    expect(STICKY_MODE_LABELS.strict.hint).toMatch(/offline, on a break or on the phone app, the team answers at once/);
    expect(STICKY_MODE_LABELS.strict.label).not.toMatch(/Only/);
  });
});

describe('the Missed reason for a caller nobody took', () => {
  it('is “Nobody free to answer”, which covers no agent at all as well as a long wait', () => {
    expect(MISSED_REASON_LABELS.overflow).toBe('Nobody free to answer');
  });
});

describe('recordings in words', () => {
  it('a length as m:ss, at least a second', () => {
    expect(recordingLength(4.4)).toBe('0:04');
    expect(recordingLength(75)).toBe('1:15');
    expect(recordingLength(0.3)).toBe('0:01');
    expect(recordingLength(null)).toBe('');
  });

  it('the routes that play one', () => {
    expect(recordingUsedBy([])).toBe('');
    expect(recordingUsedBy([{ name: 'Main' }])).toBe('Used by “Main”');
    expect(recordingUsedBy([{ name: 'A' }, { name: 'B' }, { name: 'C' }])).toBe('Used by “A”, “B” and “C”');
  });

  it('every upload refusal has words, in British English', () => {
    for (const text of Object.values(RECORDING_UPLOAD_REFUSAL_COPY)) {
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/\b(color|canceled|dialed)\b/);
    }
  });
});
