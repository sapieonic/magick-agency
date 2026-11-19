import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_DELAY_LABELS,
  ANALYSIS_DELAY_MESSAGES,
  ANALYSIS_STATUS_COLORS,
  ANALYSIS_STATUS_MESSAGES,
  ANALYSIS_STATUS_LABELS,
  ANALYSIS_STATUS_TOOLTIPS,
  SENTIMENT_LABELS,
  getSentimentColor,
  needsAnalysisStatusCard,
  shownAnalysisDelay,
} from '../../utils/vocabulary';

describe('analysis vocabulary — sentiment', () => {
  it.each([
    ['positive', '#3fcf9e'],
    ['negative', '#ef6b6b'],
    ['mixed', '#e8a63f'],
    ['neutral', '#6b6b84'],
    ['unknown', '#6b6b84'],
  ])('maps %s to the intended colour or neutral fallback', (label, color) => {
    expect(getSentimentColor(label)).toBe(color);
  });

  it('degrades a missing label to the neutral colour instead of throwing', () => {
    // Callers read the label off optional analysis payloads (`sentiment?.label`,
    // `analysis_sentiment_label`), so absent means "no sentiment yet" — neutral,
    // not a crash. Every call site guards today; this keeps the helper safe if
    // one ever stops.
    expect(getSentimentColor(undefined)).toBe('#6b6b84');
    expect(getSentimentColor(null)).toBe('#6b6b84');
    expect(getSentimentColor('')).toBe('#6b6b84');
  });

  it('maps the complete sentiment vocabulary to plain language', () => {
    expect(SENTIMENT_LABELS).toMatchObject({
      positive: 'Happy', negative: 'Unhappy', mixed: 'Mixed', neutral: 'Neutral',
    });
  });
});

describe('analysis vocabulary — all summary states', () => {
  it.each([
    ['awaiting_recording', 'Waiting for recording', '#e8a63f', 'Waiting for the phone provider to deliver the recording'],
    ['pending', 'Working…', '#e8a63f', 'The AI summary is still being written'],
    ['completed', 'Ready', '#3fcf9e', 'The AI summary of this call is ready'],
    ['failed', 'Unavailable', '#ef6b6b', 'The AI summary could not be created'],
    ['skipped', 'Not run', '#6b6b84', 'No AI summary was made for this call'],
    ['expired', 'Recording never arrived', '#6b6b84', 'The phone provider never delivered a recording'],
    ['deleted', 'Deleted', '#6b6b84', 'The transcript and summary were deleted'],
  ])('maps %s to its exact label, colour and tooltip', (status, label, color, tooltip) => {
    expect(ANALYSIS_STATUS_LABELS[status]).toBe(label);
    expect(ANALYSIS_STATUS_COLORS[status]).toBe(color);
    expect(ANALYSIS_STATUS_TOOLTIPS[status]).toBe(tooltip);
  });

  it('degrades gracefully for an unknown status without throwing', () => {
    expect(() => needsAnalysisStatusCard('future_summary_state')).not.toThrow();
    expect(needsAnalysisStatusCard('future_summary_state')).toBe(true);
    expect(ANALYSIS_STATUS_LABELS.future_summary_state).toBeUndefined();
    expect(ANALYSIS_STATUS_COLORS.future_summary_state).toBeUndefined();
  });
});

describe('analysis vocabulary — a summary held up by the AI service', () => {
  it('says it is delayed and will be written, never that it is being written', () => {
    expect(ANALYSIS_DELAY_MESSAGES.vendor_unavailable).toBe(
      'Summary delayed: the AI service is not available right now. '
      + 'It will be written automatically when it is back.',
    );
    expect(ANALYSIS_DELAY_MESSAGES.vendor_unavailable).not.toBe(ANALYSIS_STATUS_MESSAGES.pending);
    expect(ANALYSIS_DELAY_LABELS.vendor_unavailable).toBe('Delayed');
  });

  it.each([
    ['pending', 'vendor_unavailable', 'vendor_unavailable'],
    ['pending', null, null],
    ['pending', undefined, null],
    ['pending', 'a_reason_this_console_predates', null],
    ['failed', 'vendor_unavailable', null],
    ['awaiting_recording', 'vendor_unavailable', null],
    [null, 'vendor_unavailable', null],
  ])('status %s with delay %s shows %s', (status, delay, shown) => {
    expect(shownAnalysisDelay(status, delay)).toBe(shown);
  });
});
