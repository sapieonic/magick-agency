import { describe, it, expect } from 'vitest';
import {
  humanizeStatus,
  statusLabel,
  humanizeToken,
  normalizeStatusKey,
  SENTIMENT_LABELS,
} from '../../utils/vocabulary';

describe('vocabulary — humanizeStatus', () => {
  it('humanizes per-call statuses by default', () => {
    expect(humanizeStatus('completed').label).toBe('Connected');
    expect(humanizeStatus('no_answer').label).toBe('No answer');
    expect(humanizeStatus('switched_off').label).toBe('Phone was off');
    expect(humanizeStatus('busy').label).toBe('Line busy');
  });

  it('uses job-scope wording for a group of calls', () => {
    expect(humanizeStatus('completed', 'job').label).toBe('Done');
    expect(humanizeStatus('partially_failed', 'job').label).toBe("Done — some didn't connect");
    expect(humanizeStatus('failed', 'job').label).toBe("Couldn't send");
  });

  /*
    The three live phases are one sentence read left to right: batches go out
    (Sending), then the calls themselves are in flight (Calling), then it is
    over (Done). `dispatched` used to read "Sending…" — the sending word on the
    phase that had FINISHED sending — which left the calling phase unnamed and
    put the chip in direct contradiction with the per-call progress line beside
    it. Pinned as a sequence rather than three separate assertions because the
    ordering is the property that matters.
  */
  it('names the three live phases Sending → Calling → Done', () => {
    expect([
      humanizeStatus('processing', 'job').label,
      humanizeStatus('dispatched', 'job').label,
      humanizeStatus('completed', 'job').label,
    ]).toEqual(['Sending', 'Calling', 'Done']);
  });

  it('never calls a dispatched broadcast done, in label or tooltip', () => {
    const dispatched = humanizeStatus('dispatched', 'job');
    expect(dispatched.label).toBe('Calling');
    expect(dispatched.tone).toBe('active');
    expect(dispatched.tooltip).toBe('Calls are going out and coming back now.');
    expect(dispatched.label).not.toMatch(/done|finish|complete/i);
    expect(dispatched.tooltip).not.toMatch(/done|finish|complete/i);
  });

  it('uses messaging wording for message scope', () => {
    expect(humanizeStatus('delivered', 'message').label).toBe('Delivered');
    expect(humanizeStatus('read', 'message').label).toBe('Read');
    expect(humanizeStatus('undelivered', 'message').label).toBe("Didn't arrive");
  });

  it('never leaks raw snake_case for unknown statuses', () => {
    const out = humanizeStatus('some_weird_status');
    expect(out.label).toBe('Some Weird Status');
    expect(out.label).not.toContain('_');
  });

  it('handles already-spaced and mixed-case input', () => {
    expect(humanizeStatus('In Progress').label).toBe('On the call');
    expect(humanizeStatus('SWITCHED OFF').label).toBe('Phone was off');
  });

  it('handles null/undefined/empty gracefully', () => {
    expect(humanizeStatus(null).label).toBe('Unknown');
    expect(humanizeStatus(undefined).label).toBe('Unknown');
    expect(humanizeStatus('').label).toBe('Unknown');
  });

  it('exposes a tone for color selection', () => {
    expect(humanizeStatus('completed', 'job').tone).toBe('positive');
    expect(humanizeStatus('failed', 'job').tone).toBe('negative');
    expect(humanizeStatus('no_answer').tone).toBe('warning');
    expect(humanizeStatus('queued').tone).toBe('neutral');
    expect(humanizeStatus('ringing').tone).toBe('active');
  });

  it('statusLabel is a shorthand for the label', () => {
    expect(statusLabel('completed', 'job')).toBe('Done');
  });

  it('treats both spellings of cancelled the same', () => {
    expect(humanizeStatus('cancelled').label).toBe('Stopped');
    expect(humanizeStatus('canceled').label).toBe('Stopped');
  });
});

describe('vocabulary — normalizeStatusKey', () => {
  it('lowercases, trims, and collapses underscores/spaces', () => {
    expect(normalizeStatusKey('  No_Answer ')).toBe('no answer');
    expect(normalizeStatusKey('PARTIALLY__FAILED')).toBe('partially failed');
  });
});

describe('vocabulary — humanizeToken', () => {
  it('turns snake_case tokens into friendly labels', () => {
    expect(humanizeToken('first_name')).toBe('First name');
    expect(humanizeToken('amount_due')).toBe('Amount due');
  });

  it('strips braces if present', () => {
    expect(humanizeToken('{{company_name}}')).toBe('Company name');
  });

  it('overrides tokens whose mechanical humanization is not English', () => {
    // "Escalate human" is the raw enum de-underscored; it is not a phrase.
    expect(humanizeToken('escalate_human')).toBe('Escalated to human');
    expect(humanizeToken('Escalate Human')).toBe('Escalated to human');
  });
});

// PORT NOTE (magick-agency): "uses no jargon for campaign types" and "uses plain
// language for sources" are deleted with `TYPE_LABELS` / `SOURCE_LABELS`.
describe('vocabulary — label maps', () => {


  it('maps sentiment to friendly words', () => {
    expect(SENTIMENT_LABELS.positive).toBe('Happy');
    expect(SENTIMENT_LABELS.negative).toBe('Unhappy');
  });
});
