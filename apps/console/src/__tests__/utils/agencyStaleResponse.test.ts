import { describe, it, expect } from 'vitest';
import {
  decideDispositionResponse,
  decideDispositionSuccess,
  decideListResponse,
  describeDiscard,
} from '../../utils/agencyStaleResponse';

/**
 * The cross-contact leak at the §A.13.6 / §A.13.7 seam (spec `bcc2890`).
 *
 * Read the pad simulation below before the assertions. The decision function on
 * its own is three lines and looks obviously right; what these tests have to
 * demonstrate is that applying it actually keeps **customer A's note out of
 * customer B's field** — which is a property of the pad, not of a predicate.
 */

const A = 'attempt-customer-a';
const B = 'attempt-customer-b';

/**
 * The smallest thing that can exhibit the bug: a pad holding notes for whichever
 * attempt is currently on the station, plus the §A.13.6 error clauses.
 *
 * `applyError` is written the way the spec reads clause by clause — preserve the
 * note, re-enable submit, render inline — with the guard as its first line. Take
 * the guard out and the leak comes back, which is what makes this a useful
 * fixture rather than a restatement of the function under test.
 */
class PadSimulator {
  currentAttemptId: string | null = null;
  notes = '';
  inlineError: string | null = null;
  submitDisabled = false;
  readonly diagnostics: string[] = [];

  /** A new `reserved` always wins (§A.8.4): fresh pad, fresh empty notes. */
  reserve(attemptId: string): void {
    this.currentAttemptId = attemptId;
    this.notes = '';
    this.inlineError = null;
    this.submitDisabled = false;
  }

  submit(attemptId: string, notes: string): { attemptId: string; notes: string } {
    this.notes = notes;
    this.submitDisabled = true;
    return { attemptId, notes };
  }

  /** The §A.13.6 failure path, guard first. */
  applyError(inFlight: { attemptId: string; notes: string }, message: string): void {
    const decision = decideDispositionResponse(
      { attemptId: inFlight.attemptId },
      this.currentAttemptId,
    );
    if (decision.action === 'discard') {
      this.diagnostics.push(
        describeDiscard({ attemptId: inFlight.attemptId }, this.currentAttemptId, decision.reason),
      );
      return;
    }
    // "the note text is preserved" — correct for the attempt it belongs to, and
    // the exact clause that leaks when it fires against a different one.
    this.notes = inFlight.notes;
    this.inlineError = message;
    this.submitDisabled = false;
  }
}

describe('the leak, and that the guard closes it', () => {
  it("does not restore customer A's note into customer B's notes field", () => {
    const pad = new PadSimulator();

    // 1. Agent works customer A and submits.
    pad.reserve(A);
    const inFlight = pad.submit(A, "A said don't call before 6pm, spouse is ill");

    // 2. A new `reserved` for customer B arrives — correctly, per §A.8.4.
    pad.reserve(B);

    // 3. A's 400 lands.
    pad.applyError(inFlight, 'This disposition needs a note.');

    // THE assertion. "No error rendered" passes with the contamination present,
    // so the thing to assert is the notes field itself.
    expect(pad.notes).toBe('');
    expect(pad.notes).not.toContain('spouse is ill');

    // And the rest of the clauses must not have fired either.
    expect(pad.inlineError).toBeNull();
    expect(pad.submitDisabled).toBe(false);
  });

  it('leaves no trace of A anywhere on B — no error, no re-enable, no digits', () => {
    const pad = new PadSimulator();
    pad.reserve(A);
    const inFlight = pad.submit(A, 'A: promised a callback Tuesday');
    pad.reserve(B);
    pad.applyError(inFlight, "'sale' is not in this campaign's catalog");

    expect(pad).toMatchObject({
      currentAttemptId: B,
      notes: '',
      inlineError: null,
    });
  });

  it('logs the discard, because "my disposition never confirmed" is a support question', () => {
    const pad = new PadSimulator();
    pad.reserve(A);
    const inFlight = pad.submit(A, 'note');
    pad.reserve(B);
    pad.applyError(inFlight, 'boom');

    expect(pad.diagnostics).toHaveLength(1);
    expect(pad.diagnostics[0]).toContain(A);
    expect(pad.diagnostics[0]).toContain('attempt_changed');
  });

  it('STILL preserves the note on a same-attempt 400 — the normal path is intact', () => {
    // The guard must not be a blanket suppression. This is the case §A.13.6 is
    // actually written for: the note is the agent's only artefact of an
    // eight-minute call and nothing may clear it on an error path.
    const pad = new PadSimulator();
    pad.reserve(A);
    const inFlight = pad.submit(A, 'A: billing dispute, escalating');
    pad.applyError(inFlight, 'This disposition needs a note.');

    expect(pad.notes).toBe('A: billing dispute, escalating');
    expect(pad.inlineError).toBe('This disposition needs a note.');
    expect(pad.submitDisabled).toBe(false);
    expect(pad.diagnostics).toHaveLength(0);
  });
});

describe('decideDispositionResponse', () => {
  it('applies when the station is still on the same attempt', () => {
    expect(decideDispositionResponse({ attemptId: A }, A)).toEqual({ action: 'apply' });
  });

  it('discards when a different attempt is now on the station', () => {
    expect(decideDispositionResponse({ attemptId: A }, B)).toEqual({
      action: 'discard',
      reason: 'attempt_changed',
    });
  });

  it('applies when there is no attempt at all', () => {
    // Null is deliberately not a discard: with nothing on the station there is no
    // other contact's field to contaminate, and the agent may still be looking at
    // the wrap-up panel for the attempt that just ended. Discarding here would
    // hide a real failure from the only person who can act on it. The rule
    // protects customer B; it does not suppress customer A's errors.
    expect(decideDispositionResponse({ attemptId: A }, null)).toEqual({ action: 'apply' });
  });

  it('is symmetric — it does not matter which attempt is "newer"', () => {
    // The guard compares identity, not ordering. There is no sequence number on
    // the wire to compare, and inventing one would be a second source of truth.
    expect(decideDispositionResponse({ attemptId: B }, A).action).toBe('discard');
  });
});

describe('decideDispositionSuccess', () => {
  it('applies a success for the attempt still on the station', () => {
    expect(decideDispositionSuccess({ attemptId: A }, { attempt_id: A }, A))
      .toEqual({ action: 'apply' });
  });

  it('discards a success that lands after a new reservation', () => {
    // Otherwise A's confirmation disables B's pad and clears B's notes — the same
    // leak wearing a 200.
    expect(decideDispositionSuccess({ attemptId: A }, { attempt_id: A }, B))
      .toEqual({ action: 'discard', reason: 'attempt_changed' });
  });

  it('discards a body whose attempt_id disagrees with what we submitted', () => {
    // Should never happen; that is why it is asserted rather than assumed.
    expect(decideDispositionSuccess({ attemptId: A }, { attempt_id: B }, A))
      .toEqual({ action: 'discard', reason: 'attempt_id_mismatch' });
  });

  it('checks the body before the station, so a mismatch is named precisely', () => {
    const decision = decideDispositionSuccess({ attemptId: A }, { attempt_id: 'ghost' }, B);
    expect(decision).toEqual({ action: 'discard', reason: 'attempt_id_mismatch' });
  });
});

describe('why the error path cannot read attempt_id off the response', () => {
  it('is guarded by the captured id, since the 400 body carries none', () => {
    // `AgencyActionErrorResponse` is `{ error, code, message, allowed_codes? }`.
    // The failing path — the one that leaks — has nothing in its body to key off,
    // so the id must be captured when the request is issued.
    const errorBody: Record<string, unknown> = {
      error: 'Validation failed',
      code: 'unknown_disposition_code',
      message: "'sale' is not in this campaign's catalog",
      allowed_codes: ['interested', 'callback'],
    };
    expect(errorBody).not.toHaveProperty('attempt_id');

    // Which is exactly why the guard's input is an `InFlightDisposition`.
    expect(decideDispositionResponse({ attemptId: A }, B).action).toBe('discard');
  });
});

/**
 * The read-side twin: a LIST response landing for a query nobody is asking any
 * more.
 *
 * ── Why this belongs beside the disposition guard ──────────────────────────
 * One property, two shapes. Above it protects customer B's notes field from
 * customer A's failed submit; here it protects a filtered list from a page fetched
 * under a filter the reader has moved off. The list case is duller and no less
 * real: every agency spine list is a filtered keyset read, so changing a filter
 * twice quickly is routine traffic, and the slow first response landing last
 * leaves rows that do not match the controls above them — which reads as a broken
 * filter rather than as a race, so the reader's next move is to distrust the whole
 * screen.
 *
 * The two callers are the interesting part, and they are asymmetric on purpose:
 *
 *  - a **first page** increments the counter and holds the new value: it is a new
 *    question;
 *  - a **"load more"** captures the counter WITHOUT incrementing: it is a
 *    continuation of the question already on screen.
 *
 * That asymmetry is the whole defect keyset pagination is prone to. Appending a
 * page fetched under the old filter beneath the new filter's first page produces a
 * list that is internally inconsistent, and both halves of the code look correct
 * in isolation.
 */
describe('decideListResponse — a list read that has been overtaken', () => {
  it('applies a response that is still the newest', () => {
    expect(decideListResponse({ seq: 4 }, 4)).toEqual({ action: 'apply' });
  });

  it('discards a response overtaken by a newer read', () => {
    // The routine case: a second filter change fired while the first was still in
    // flight.
    expect(decideListResponse({ seq: 3 }, 4)).toEqual({
      action: 'discard',
      reason: 'superseded',
    });
  });

  it('discards a "load more" whose filter changed under it', () => {
    /**
     * The append path, and the one this function exists for. The counter was
     * CAPTURED at 7 rather than incremented, a filter change moved it to 8, and
     * the page that comes back belongs to a query that is no longer on screen.
     * Applying it would put page 2 of the old filter beneath page 1 of the new.
     */
    const captured = { seq: 7 };
    expect(decideListResponse(captured, 8).action).toBe('discard');
  });

  it('applies a "load more" that nothing overtook', () => {
    // The ordinary case, asserted so a guard that discarded everything would fail
    // here rather than silently making "Load more" do nothing.
    expect(decideListResponse({ seq: 7 }, 7)).toEqual({ action: 'apply' });
  });

  it('discards a response from a counter that has wrapped past it in either direction', () => {
    /**
     * Inequality rather than `<`. The counter only ever increases in practice, but
     * "is this the response to the request we are waiting for" is the question
     * being asked — and a `<` comparison would apply a response from a generation
     * the caller cannot account for, which is the one outcome a guard must never
     * have.
     */
    expect(decideListResponse({ seq: 9 }, 2).action).toBe('discard');
  });
});
