import { describe, expect, it } from 'vitest';
import {
  AGENCY_CALL_ORIGIN_LABELS,
  AGENCY_LISTEN_END_REASON_LABELS,
  AGENCY_LISTEN_HISTORY_DEFAULT_LIMIT,
  AGENCY_LISTEN_HISTORY_MAX_LIMIT,
  AGENCY_LISTEN_HISTORY_MERGE_GAP_MS,
} from '../src/api/agency/listen-history';
import { AGENCY_CALL_ORIGINS, AGENCY_LISTEN_END_REASONS, AGENCY_LISTEN_RECONNECT_WINDOW_MS } from '../src/agency/listen';

/** The listening history's vocabulary (docs/listening.md §12, LS19). */
describe('listening history', () => {
  it('has words for exactly the end reasons, each a sentence-case phrase without a code in it', () => {
    expect(Object.keys(AGENCY_LISTEN_END_REASON_LABELS).sort()).toEqual([...AGENCY_LISTEN_END_REASONS].sort());
    for (const [reason, words] of Object.entries(AGENCY_LISTEN_END_REASON_LABELS)) {
      expect(words, reason).toMatch(/^[A-Z][a-z]/);
      expect(words, reason).not.toContain('_');
    }
  });

  it('has words for exactly the call origins', () => {
    expect(Object.keys(AGENCY_CALL_ORIGIN_LABELS).sort()).toEqual([...AGENCY_CALL_ORIGINS].sort());
    expect(AGENCY_CALL_ORIGIN_LABELS).toEqual({ campaign: 'Dialler', manual: 'Soft phone', inbound: 'Inbound' });
  });

  it('merges sessions up to twice the console\'s reconnect window apart', () => {
    expect(AGENCY_LISTEN_HISTORY_MERGE_GAP_MS).toBe(2 * AGENCY_LISTEN_RECONNECT_WINDOW_MS);
  });

  it('pages within its ceiling', () => {
    expect(AGENCY_LISTEN_HISTORY_DEFAULT_LIMIT).toBeLessThanOrEqual(AGENCY_LISTEN_HISTORY_MAX_LIMIT);
  });
});
