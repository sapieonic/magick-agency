import { describe, it, expect } from 'vitest';
import {
  classifySubmitOutcome,
  confirmationCopy,
  handleSubmitResponse,
} from '../../utils/agencyDispositionSubmit';
import { advisoryAgentState } from '../../utils/agencyStaleResponse';

/**
 * The API's frozen disposition shape.
 *
 * Two of these are cases a console gets wrong by reading the status code
 * literally, and one is the field that drops a live call if read directly.
 */

const A = 'attempt-a';
const B = 'attempt-b';

describe('a re-submitted SAME code is a success, not an error', () => {
  it('treats an idempotent 200 as saved', () => {
    // The agent presses Submit, the network blips, the console retries. A strict
    // 409 would show them an error for an action that succeeded — on the one
    // interaction whose whole purpose is recording what was said to a customer.
    expect(classifySubmitOutcome({ status: 200, body: { attempt_id: A, disposition_code: 'sale' } }))
      .toEqual({ kind: 'saved', nextAttemptAt: null });
  });

  it('does NOT render a replay as "already submitted"', () => {
    // Deliberately indistinguishable: from the agent's side it WAS a success, and a
    // "you already did this" state tells them their retry failed when it did
    // exactly what they wanted.
    const first = classifySubmitOutcome({ status: 200, body: { attempt_id: A, disposition_code: 'sale' } });
    const replay = classifySubmitOutcome({ status: 200, body: { attempt_id: A, disposition_code: 'sale' } });
    expect(replay).toEqual(first);
    expect(replay.kind).toBe('saved');
  });

  it('accepts any 2xx as saved', () => {
    for (const status of [200, 201, 204]) {
      expect(classifySubmitOutcome({ status, body: {} }).kind).toBe('saved');
    }
  });
});

describe('a DIFFERENT code is a conflict, because a record is not silently rewritable', () => {
  it('classifies a 409 as a conflict', () => {
    const outcome = classifySubmitOutcome({
      status: 409,
      body: { error: 'Conflict', code: 'already_dispositioned', message: 'Already dispositioned', disposition_code: 'not_interested' },
    });
    expect(outcome).toEqual({ kind: 'conflict', recordedCode: 'not_interested' });
  });

  it('classifies already_dispositioned as a conflict whatever the status', () => {
    expect(classifySubmitOutcome({
      status: 400,
      body: { code: 'already_dispositioned', message: 'x' },
    }).kind).toBe('conflict');
  });

  it('does not pretend to know the recorded code when the body omits it', () => {
    const outcome = classifySubmitOutcome({ status: 409, body: { code: 'already_dispositioned', message: 'x' } });
    expect(outcome).toEqual({ kind: 'conflict', recordedCode: undefined });
  });
});

describe('validation rejections keep their code and allowed_codes', () => {
  it('surfaces the code the pad keys its copy off', () => {
    const outcome = classifySubmitOutcome({
      status: 400,
      body: { error: 'Validation failed', code: 'note_required', message: 'This disposition needs a note.' },
    });
    expect(outcome).toEqual({
      kind: 'rejected',
      code: 'note_required',
      message: 'This disposition needs a note.',
      allowedCodes: undefined,
    });
  });

  it('carries allowed_codes so a stale catalog recovers in one round trip', () => {
    const outcome = classifySubmitOutcome({
      status: 400,
      body: {
        code: 'unknown_disposition_code',
        message: "'sale' is not in this campaign's catalog",
        allowed_codes: ['interested', 'callback', 'voicemail'],
      },
    });
    expect(outcome).toMatchObject({
      kind: 'rejected',
      code: 'unknown_disposition_code',
      allowedCodes: ['interested', 'callback', 'voicemail'],
    });
  });

  it('falls back to a sentence rather than showing nothing for an unknown code', () => {
    const outcome = classifySubmitOutcome({ status: 400, body: {} });
    expect(outcome).toMatchObject({ kind: 'rejected', code: null });
    if (outcome.kind !== 'rejected') return;
    expect(outcome.message.length).toBeGreaterThan(0);
  });

  it('discards non-string entries in allowed_codes rather than rendering them', () => {
    const outcome = classifySubmitOutcome({
      status: 400,
      body: { code: 'unknown_disposition_code', message: 'x', allowed_codes: ['ok', 42, null] },
    });
    expect(outcome).toMatchObject({ allowedCodes: ['ok'] });
  });
});

describe('the saved outcome carries the time the API actually booked', () => {
  it('keeps `next_attempt_at`, so the confirmation can name the callback time', () => {
    // Without it the console can only say "Disposition saved." — and
    // `confirmationCopy`, where the callback copy's "we" lives, had zero callers.
    expect(
      classifySubmitOutcome({
        status: 200,
        body: {
          attempt_id: A,
          disposition_code: 'callback',
          next_attempt_at: '2026-08-12T10:00:00.000Z',
        },
      }),
    ).toEqual({ kind: 'saved', nextAttemptAt: '2026-08-12T10:00:00.000Z' });
  });

  it('reads a missing or non-string value as null rather than failing the save', () => {
    expect(
      classifySubmitOutcome({ status: 200, body: { attempt_id: A, next_attempt_at: 12_345 } }),
    ).toEqual({ kind: 'saved', nextAttemptAt: null });
  });
});

describe('the confirmation copy — always "we"', () => {
  it('states the outcome plainly when nothing is scheduled', () => {
    // `contact_state` is `completed` and `next_attempt_at` null for almost every
    // P2 disposition.
    expect(confirmationCopy({ dispositionLabel: 'Sale', nextAttemptAt: null }))
      .toBe('Saved — Sale.');
  });

  it('says "we" and never "I" when a callback was honoured', () => {
    // A callback re-enters the roster as an ordinary pending contact and whichever
    // agent is available takes it, so "I'll call you back" is a promise the
    // product breaks. This copy is the entire mitigation for that decision.
    const copy = confirmationCopy({
      dispositionLabel: 'Callback',
      nextAttemptAt: '2026-08-12T10:00:00.000Z',
    });
    expect(copy).toContain("We'll call back");
    expect(copy).not.toMatch(/\bI\b|\bI'll\b/);
  });

  it('does not claim THIS agent will make the call', () => {
    const copy = confirmationCopy({ dispositionLabel: 'Callback', nextAttemptAt: '2026-08-12T10:00:00.000Z' });
    expect(copy.toLowerCase()).not.toContain('you will');
    expect(copy.toLowerCase()).not.toContain("you'll call");
    expect(copy.toLowerCase()).not.toContain('your callback');
  });

  it('does not invent a time when next_attempt_at is unparseable', () => {
    const copy = confirmationCopy({ dispositionLabel: 'Callback', nextAttemptAt: 'soon' });
    expect(copy).toBe("Saved — Callback. We'll call back as scheduled.");
  });
});

describe('agent_state on the response is advisory — reading it directly drops a live call', () => {
  /**
   * The field races the socket **by design**: submitting releases the agent, the
   * pacing tick runs every 250ms, so a new call can be reserved and its `reserved`
   * frame delivered *before* the HTTP response lands. Assigning from it
   * unconditionally overwrites a fresh `reserved` with a stale `available` and the
   * panel for a customer already talking disappears.
   */
  const response = { attempt_id: A, agent_state: 'available' } as const;

  it('withholds the hint once a new attempt is on the station', () => {
    // THE case. A's response says `available`; B is already reserved and talking.
    expect(advisoryAgentState({ attemptId: A }, response, B, false)).toBeNull();
  });

  it('withholds the hint once the socket has spoken', () => {
    // A hint is worthless next to the authority.
    expect(advisoryAgentState({ attemptId: A }, response, A, true)).toBeNull();
  });

  it('offers the hint only when the socket has NOT spoken and the attempt still stands', () => {
    expect(advisoryAgentState({ attemptId: A }, response, A, false)).toBe('available');
  });

  it('offers the hint when there is no attempt on the station', () => {
    // Nothing to overwrite, and the agent may still be looking at A's wrap-up.
    expect(advisoryAgentState({ attemptId: A }, response, null, false)).toBe('available');
  });

  it('withholds it when the body names an attempt we did not submit for', () => {
    expect(advisoryAgentState({ attemptId: A }, { attempt_id: 'ghost', agent_state: 'available' }, A, false))
      .toBeNull();
  });

  it('does not hard-code available — break is the correct post-submit state with a queued break', () => {
    expect(advisoryAgentState({ attemptId: A }, { attempt_id: A, agent_state: 'break' }, A, false))
      .toBe('break');
  });
});

/**
 * `handleSubmitResponse` — the stale guard and the classifier, welded in the only
 * safe order (the stale-response rule).
 *
 * The proof the stale-response rule asks for is specific, and it names which assertion matters:
 * "Asserting only that the error does not render passes while the note
 * contamination is still present, **so the notes assertion is the one that
 * matters**." At this tier the equivalent is that the outcome carries no
 * `message` and no `allowedCodes` for the agent to have restored — a `discarded`
 * member with nothing on it is what makes note restoration unrepresentable.
 */
describe('handleSubmitResponse — the guard runs first, always', () => {
  const B = 'attempt-b';

  it('discards A’s 400 when B is on the station, with nothing to restore', () => {
    // The sequence is ordinary, not exotic: submit for A, the API reserves B, A's
    // 400 lands. the stale-response rule requires the new `reserved` to win.
    const outcome = handleSubmitResponse(
      { attemptId: A },
      { status: 400, body: { code: 'note_required', message: 'Notes are required', allowed_codes: ['x'] } },
      B,
    );

    expect(outcome).toEqual({ kind: 'discarded', reason: 'attempt_changed' });
    // The discriminated union is the mechanism: there is no `message` and no
    // `allowedCodes` on this member, so a pad that switches on `kind` CANNOT
    // render A's error over B's pad or restore A's note into B's field. Classify
    // first and this same input yields `{kind:'rejected', message, allowedCodes}`.
    expect('message' in outcome).toBe(false);
    expect('allowedCodes' in outcome).toBe(false);
  });

  it('discards A’s SUCCESS when B is on the station', () => {
    // Both directions, because a confirmation applied to B's pad tells the agent
    // the call they are on has been dispositioned.
    expect(
      handleSubmitResponse({ attemptId: A }, { status: 200, body: { attempt_id: A } }, B),
    ).toEqual({ kind: 'discarded', reason: 'attempt_changed' });
  });

  it('discards a 2xx whose body names an attempt we did not submit for', () => {
    // Should never fire — a mismatched promise or a proxy replaying a body. That
    // is exactly why it is worth asserting.
    expect(
      handleSubmitResponse({ attemptId: A }, { status: 200, body: { attempt_id: 'attempt-z' } }, A),
    ).toEqual({ kind: 'discarded', reason: 'attempt_id_mismatch' });
  });

  it('does NOT discard when the station holds no attempt', () => {
    // Approved deliberately: with nothing on the station there is no other
    // contact's field to contaminate, and the agent may still be looking at the
    // wrap-up panel for the attempt that just ended. The rule protects customer
    // B; it must not suppress customer A's errors.
    const outcome = handleSubmitResponse(
      { attemptId: A },
      { status: 400, body: { code: 'note_required', message: 'Notes are required' } },
      null,
    );
    expect(outcome.kind).toBe('rejected');
  });

  it('applies normally when the response is for the attempt still on the station', () => {
    expect(handleSubmitResponse({ attemptId: A }, { status: 200, body: { attempt_id: A } }, A))
      .toEqual({ kind: 'saved', nextAttemptAt: null });
  });

  it('keeps allowed_codes on a rejection that is NOT stale', () => {
    // The one-round-trip recovery must survive the guard: discarding too eagerly
    // would turn a stale catalog back into a support ticket.
    const outcome = handleSubmitResponse(
      { attemptId: A },
      { status: 400, body: { code: 'unknown_disposition_code', message: 'nope', allowed_codes: ['sale'] } },
      A,
    );
    expect(outcome).toMatchObject({ kind: 'rejected', allowedCodes: ['sale'] });
  });

  it('tolerates a 2xx with no attempt_id rather than throwing the confirmation away', () => {
    // Absence is not evidence of a mismatched body, and discarding on it would
    // lose a genuine confirmation over a field the console does not need.
    expect(handleSubmitResponse({ attemptId: A }, { status: 200, body: {} }, A))
      .toEqual({ kind: 'saved', nextAttemptAt: null });
  });

  it('still discards a conflict for a superseded attempt', () => {
    // 409 takes the same guard as every other status — the classifier is reached
    // through exactly one door.
    expect(
      handleSubmitResponse({ attemptId: A }, { status: 409, body: { code: 'already_dispositioned' } }, B),
    ).toEqual({ kind: 'discarded', reason: 'attempt_changed' });
  });
});

/**
 * The API's `callback_requested_at`. The API
 * defers a callback outside the contact's calling window to the next window
 * open; `next_attempt_at` is then the time it will really dial, and the request
 * comes back separately. "When they differ, the console should say what will
 * happen rather than what was asked."
 */
describe('a callback moved into calling hours', () => {
  const REQUESTED = '2026-08-15T22:00:00.000Z';
  const DIALLED = '2026-08-17T04:30:00.000Z';

  it('carries the asked-for time alongside the booked one', () => {
    expect(
      classifySubmitOutcome({
        status: 200,
        body: { attempt_id: A, next_attempt_at: DIALLED, callback_requested_at: REQUESTED },
      }),
    ).toEqual({ kind: 'saved', nextAttemptAt: DIALLED, callbackRequestedAt: REQUESTED });
  });

  it('names the time it will really call, and says why it moved', () => {
    const moved = confirmationCopy({
      dispositionLabel: 'Callback',
      nextAttemptAt: DIALLED,
      callbackRequestedAt: REQUESTED,
    });
    const asIs = confirmationCopy({ dispositionLabel: 'Callback', nextAttemptAt: DIALLED });
    expect(moved).toContain('the next time inside calling hours');
    // The named time is the DIALLED one — the same words the unmoved copy uses.
    expect(moved.startsWith(asIs.replace(/\.$/, ''))).toBe(true);
    expect(moved).not.toMatch(/\bI\b|\bI'll\b/);
  });

  it('says nothing extra when the request was honoured as asked', () => {
    expect(
      confirmationCopy({ dispositionLabel: 'Callback', nextAttemptAt: DIALLED, callbackRequestedAt: DIALLED }),
    ).toBe(confirmationCopy({ dispositionLabel: 'Callback', nextAttemptAt: DIALLED }));
  });

  it('ignores an unparseable request rather than claiming a move', () => {
    expect(
      confirmationCopy({ dispositionLabel: 'Callback', nextAttemptAt: DIALLED, callbackRequestedAt: 'soon' }),
    ).toBe(confirmationCopy({ dispositionLabel: 'Callback', nextAttemptAt: DIALLED }));
  });
});
