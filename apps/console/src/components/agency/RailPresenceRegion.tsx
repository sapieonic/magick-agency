import { elapsedSince, formatDuration } from '../../utils/agencyClock';
import { useRepaintTick } from '../../hooks/useRepaintTick';
import type { AgencyAgentState } from '../../types/agency';
import styles from './RailPresenceRegion.module.css';

/**
 * The rail's right-hand region: the presence control and the break elapsed time
 *.
 *
 * ── Why this is its own component ────────────────────────────────────────────
 * This region is **rewritten four times a second** to advance the break elapsed
 * time, for a reason that has nothing to do with what the agent is doing. `End
 * break` lives inside it and is the **only** control in the break state. Measured
 * in the designer's prototype: focus survived **less than 250ms, every time** — so
 * a keyboard agent could not hold focus on it at all, and tabbing to it and
 * pressing `Enter` was a race against the repaint.
 *
 * That would have shipped, because the `A` shortcut still worked: the state is
 * fully operable, so nothing looks broken unless you are navigating by focus.
 *
 * ── The two mechanisms, and why only one applies here ────────────────────────
 * Focus is lost in two unrelated ways and conflating them yields either dead code
 * or an undefended bug:
 *
 *  **(a) the node is replaced** by a re-render — the case this component is about.
 *      Fixed by stable identity: the button below is rendered at a fixed position,
 *      is never re-keyed, never conditionally swapped for a different element
 *      type, and its *label* changes rather than its identity. React therefore
 *      reuses the same DOM node across every repaint, and focus lives in the DOM.
 *  **(b) the node is disabled** — the browser blurs a focused element on disable,
 *      and re-enabling does **not** restore it. Fixed by never disabling:
 *      `aria-disabled` plus a handler guard.
 *
 * Both are applied here. (b) is applied even though this control has no pending
 * state of its own today, because `busy` will arrive the moment the presence call
 * is made optimistic and the obvious implementation is `disabled={busy}`.
 *
 * ── The fix that is NOT acceptable ───────────────────────────────────────────
 * **Do not stop the re-render.** The elapsed time must keep advancing: a
 * five-minute break that reads as four is the defect this repaint exists
 * to prevent, so freezing the region trades an accessibility bug for a correctness
 * one. Both properties have to hold together, which is why the tests assert the
 * timer is still moving in the same breath as asserting focus held — a test that
 * only checks focus passes when someone "fixes" it by freezing.
 */
export interface RailPresenceRegionProps {
  agentState: AgencyAgentState;
  /** `agent_state.since`, ISO-8601 from the server. The elapsed-time anchor. */
  since: string | null;
  /** Corrected-clock offset. Server instants are converted before use. */
  clockOffsetMs: number;
  /** Label of the break reason in effect, for the rail's sub-text. */
  breakReasonLabel?: string | null;
  /**
   * LF6, LF20, LF26: the break reason's limit, in minutes, when it has one (the bootstrap's
   * `break_reasons`, found by code). With one, the region counts down to it and then says how far
   * over the break is; without (no limit of its own, a reserved reason), it counts up, as ever.
   */
  breakLimitMinutes?: number | null;
  /** True while a presence request is in flight. */
  busy: boolean;
  onGoAvailable: () => void;
  onEndBreak: () => void;
}

/**
 *: **state comes from `agent_state`; the control is a verb.**
 *
 * Not a toggle. A switch forces the agent to answer "which way is on" from
 * peripheral vision at the moment they least want to think, and it puts state in
 * two places. The rail is where state lives; the control says what pressing it
 * will do.
 */
function presenceAction(agentState: AgencyAgentState): { label: string; kind: 'available' | 'end_break' } | null {
  if (agentState === 'offline') return { label: 'Go available', kind: 'available' };
  if (agentState === 'break') return { label: 'End break', kind: 'end_break' };
  // `available` has no presence button — the only presence action there is Break,
  // which lives in the action bar. `reserved`/`on_call`/`wrapup` have none at all:
  // Break queues instead.
  return null;
}

export function RailPresenceRegion({
  agentState,
  since,
  clockOffsetMs,
  breakReasonLabel,
  breakLimitMinutes = null,
  busy,
  onGoAvailable,
  onEndBreak,
}: RailPresenceRegionProps) {
  // Only tick while there is something to advance. `enabled` gates the interval
  // rather than the render, so turning it off cannot change the DOM shape and
  // therefore cannot cost focus.
  const onBreak = agentState === 'break';
  useRepaintTick(onBreak);

  const action = presenceAction(agentState);

  // Recomputed from the server anchor on every repaint — never decremented, never
  // counted from a local start instant. A five-minute break must not read as four.
  const elapsedMs = onBreak ? elapsedSince(since, clockOffsetMs, Date.now()) : null;
  const time = breakTime(elapsedMs, breakLimitMinutes);

  return (
    <div className={styles.region}>
      {onBreak && (
        <span className={styles.elapsed} data-over={time.over ? 'true' : undefined} data-testid="break-time">
          {breakReasonLabel ? `${breakReasonLabel} · ` : ''}
          {/*
            `data-testid` rather than a label lookup: this string changes four
            times a second and the tests need to prove it is still changing.
          */}
          <span data-testid="break-elapsed">{time.text}</span>
        </span>
      )}

      {/*
        ONE button element, at a fixed position, whose label changes between
        states. Rendering `offline` and `break` as two sibling branches would let
        React unmount one and mount the other on a state change — and the whole
        point of this component is that the node survives.

        It is rendered as `null` only where there is genuinely no presence action,
        which is a state change the agent caused and where focus moving is correct.
      */}
      {action && (
        <button
          type="button"
          className={styles.presence}
          // NOT `disabled` — see the note above on mechanism (b).
          aria-disabled={busy || undefined}
          data-busy={busy ? 'true' : undefined}
          data-action={action.kind}
          onClick={() => {
            if (busy) return;
            if (action.kind === 'available') onGoAvailable();
            else onEndBreak();
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

/**
 * What the break's clock reads (LF26). No limit: the time on break, counting up. A limit: the time
 * left, counting down ("4:21 left"), and once it has run out how far over the break is, in whole
 * minutes begun ("over by 3 min": a minute and a second over is two), which the region shows in the
 * warning tone. Both from the same server anchor, so the countdown and the floor's long-break risk
 * cross the limit together.
 */
export function breakTime(elapsedMs: number | null, limitMinutes: number | null): { text: string; over: boolean } {
  if (elapsedMs === null) return { text: '—', over: false };
  if (limitMinutes === null) return { text: formatDuration(elapsedMs), over: false };
  const leftMs = limitMinutes * 60_000 - elapsedMs;
  if (leftMs > 0) return { text: `${formatDuration(leftMs)} left`, over: false };
  const overMinutes = Math.max(1, Math.ceil(-leftMs / 60_000));
  return { text: `over by ${overMinutes} min`, over: true };
}
