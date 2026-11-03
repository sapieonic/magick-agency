import { useEffect, useMemo, useState } from 'react';
import { useLatestRef } from './useLatestRef';
import type { AgencyRedialResponse } from '@magick-agency/contracts/agency';
import type { LiveAttempt } from './agencyStation/types';
import type { WrapupAnchor } from '../utils/agencyWrapup';
import type { AgencyReservedAttempt } from '../types/agency';

/**
 * Wrap-up redial: what the console carries from the wrap-up the agent pressed
 * Redial on to the redial's own wrap-up — the notes draft and the contact panel —
 * when the redial's `reserved` frame never reached this console.
 *
 * ── Why the panel cannot carry it then ───────────────────────────────────────
 * The usual path needs nothing from here: `reserved` puts the redial on screen
 * with `attempt.redial.of_attempt_id`, the panel is retained through its wrap-up,
 * and the notes hook reads the link off that panel. But a redial can fail before
 * its `reserved` is sent (the dispatcher refuses it, a pre-dial check fails after
 * the take): the server then sends `released` and a `wrapup` for the NEW attempt
 * to a console that never saw it. The station drops the old panel on that wrap-up
 * (`stationReducer`'s `wrapup` rule: a panel held for another attempt is a
 * finished call's), so without this the agent writes up the same customer on an
 * empty panel, and their draft stays under the old attempt's key.
 *
 * ── How the new attempt is known ─────────────────────────────────────────────
 * The 200 names it (`attempt_id`, `redial_of_attempt_id`). The frames can beat the
 * 200, so until it lands a wrap-up on a DIFFERENT attempt, with no call live, while
 * the request for the pressed one is still out, is read as the redial's: the agent
 * is held for the redial from the take on, and a refused redial reopens the wrap-up
 * on the attempt it was pressed on, never on another. The inference is withdrawn
 * as soon as a call goes live (that call's own `reserved` carries the link) and
 * when the server refuses the press. A request that got no usable answer keeps it:
 * that redial may have been placed.
 */
export interface RedialCarry {
  /** The attempt Redial was pressed on — the draft's owner. */
  fromAttemptId: string;
  /** The redial's attempt, whose wrap-up is on screen. */
  toAttemptId: string;
  /**
   * The panel the agent was looking at when they pressed, restated for the
   * redial's attempt (same customer, same context), or null when there was none
   * (a console reloaded mid-wrap-up has no panel to carry).
   */
  panel: AgencyReservedAttempt | null;
}

/** What `useWrapupRedial` reports about a press, so the carry can follow it. */
export interface RedialCarryRecorder {
  pressed: (fromAttemptId: string) => void;
  placed: (response: AgencyRedialResponse) => void;
  /** Answered without a placement: a refusal, or no usable answer at all. */
  settled: (fromAttemptId: string, refused: boolean) => void;
}

interface CarryRecord {
  from: string;
  /** From the 200. Null until it lands. */
  to: string | null;
  panel: AgencyReservedAttempt | null;
  /** No call has gone live since the press, and the 200 has not named the attempt. */
  inferable: boolean;
  number: number | null;
  remaining: number | null;
}

export function useRedialCarry(options: {
  wrapup: WrapupAnchor | null;
  live: LiveAttempt | null;
  /** The panel on screen now; captured at the press. */
  panel: AgencyReservedAttempt | null;
}): { carry: RedialCarry | null; recorder: RedialCarryRecorder } {
  const { wrapup, live, panel } = options;
  const [record, setRecord] = useState<CarryRecord | null>(null);

  // Read at the press, from the render the press was made on.
  const panelRef = useLatestRef(panel);

  const recorder = useMemo<RedialCarryRecorder>(
    () => ({
      pressed: (from) =>
        setRecord({ from, to: null, panel: panelRef.current, inferable: true, number: null, remaining: null }),
      placed: (response) =>
        setRecord((prev) =>
          prev && prev.from === response.redial_of_attempt_id
            ? {
                ...prev,
                to: response.attempt_id,
                inferable: false,
                number: response.redial_number,
                remaining: response.redial_remaining,
              }
            : prev,
        ),
      settled: (from, refused) =>
        // A refusal means nothing was placed: forget the press. With no usable answer
        // the redial may still have been placed, and the inference holds exactly as
        // it did while the request was out — nothing but this redial can open a
        // wrap-up on another attempt without a call going live first.
        setRecord((prev) => (refused && prev && prev.from === from && prev.to === null ? null : prev)),
    }),
    [panelRef],
  );

  // A call went live: it carries its own link, and any later wrap-up is not one
  // this press could have produced without passing through it.
  const callLive = live !== null;
  useEffect(() => {
    if (!callLive) return;
    setRecord((prev) => (prev && prev.inferable ? { ...prev, inferable: false } : prev));
  }, [callLive]);

  const onScreen = live === null && wrapup !== null ? wrapup.attemptId : null;
  let carry: RedialCarry | null = null;
  if (record && onScreen !== null && onScreen !== record.from) {
    const confirmed = record.to === onScreen;
    const inferred = record.to === null && record.inferable;
    if (confirmed || inferred) {
      const pressedOn = record.panel;
      carry = {
        fromAttemptId: record.from,
        toAttemptId: onScreen,
        panel: pressedOn
          ? {
              ...pressedOn,
              attempt_id: onScreen,
              // The server numbers the redial as it numbers any new attempt on the
              // contact (one past the newest), and the pressed attempt is the newest.
              attempt_number: pressedOn.attempt_number + 1,
              redial: {
                of_attempt_id: record.from,
                number: record.number ?? (pressedOn.redial?.number ?? 0) + 1,
                remaining: wrapup?.redialRemaining ?? record.remaining ?? 0,
              },
            }
          : null,
      };
    }
  }

  return { carry, recorder };
}
