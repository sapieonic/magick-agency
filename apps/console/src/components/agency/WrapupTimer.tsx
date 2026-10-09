import { wrapupView, type WrapupAnchor, type WrapupPanel } from '../../utils/agencyWrapup';
import type { AgencyWrapupHold } from '../../types/agency';
import styles from './WrapupTimer.module.css';

/**
 * The wrap-up countdown, in the rail's right-hand region (§A.13.5, §A.13.5.1).
 *
 * All the arithmetic is in `agencyWrapup`, which is pure so the drift properties
 * can be asserted against a clock that jumps rather than by watching a bar. This
 * component's whole job is the rendering decision the arithmetic hands it — and
 * that decision has exactly one subtlety, which is the reason the module exists
 * separately at all.
 *
 * ── `fraction: null` means there is no bar, NOT a bar of zero width ──────────
 * A held wrap-up renders **no track element**. A track that will never move again
 * is a progress indicator for a process that has no progress: it reads as a
 * countdown that has stalled, so the agent waits for it instead of acting — which
 * is the opposite of what a held window is asking them to do.
 *
 * The asymmetry with a countdown that *reached* zero is deliberate: there the
 * track stays (fraction `0`, not null), because a bar that genuinely ran down to
 * nothing is a true statement about a real timer, and collapsing the geometry at
 * `0:00` would move everything beside it at the worst moment.
 *
 * **So there is no `?? 0` and no `|| 0` anywhere below.** Coalescing the null at
 * the point of use re-introduces the asymmetry one line after the function
 * correctly refused it, and it is the most natural thing in the world to type. The
 * null reaches the render decision intact, where it selects *whether the bar
 * exists* rather than *how wide it is*.
 */

/**
 * Copy for a hold reason. The union has one member today and the fallback lands on
 * the same sentence, which is fine — what matters is that neither path can put a
 * raw enum in front of an agent.
 */
const HOLD_COPY: Record<AgencyWrapupHold, string> = {
  disposition_required: 'Waiting on a disposition',
  // PORT NOTE (magick-agency): core's second hold (CONTRACT-DIFF §1), which cusui
  // lacked. Says who is holding, so the agent does not read it as their own
  // unfinished work or as a hang.
  supervisor_hold: 'Held by your supervisor',
};

/** §A.13.5.1: never "expired", never "overdue", and never a spinner. */
export const WRAPUP_HELD_FALLBACK_COPY = 'Waiting on a disposition';

export interface WrapupTimerProps {
  /** Captured once on the wrap-up frame. Never rebuilt per render. */
  anchor: WrapupAnchor;
  /** Corrected client-clock ms, from `useServerClock`. */
  now: number;
  dispositionSubmitted: boolean;
}

/** Exposed so the page can decide the rail's tone without re-deriving the view. */
export function wrapupPanelOf(
  anchor: WrapupAnchor,
  now: number,
  dispositionSubmitted: boolean,
): WrapupPanel {
  return wrapupView(anchor, now, dispositionSubmitted).panel;
}

export function WrapupTimer({ anchor, now, dispositionSubmitted }: WrapupTimerProps) {
  const view = wrapupView(anchor, now, dispositionSubmitted);

  const heldReason = anchor.heldReason ? HOLD_COPY[anchor.heldReason] : WRAPUP_HELD_FALLBACK_COPY;

  /**
   * **One return, and the nullness of `fraction`/`label` is what decides.**
   *
   * An earlier draft returned early on `view.panel === 'held'` and *also* checked
   * `fraction !== null` further down. That made the fraction check unreachable for
   * the held case — dead code that looked exactly like the defence §A.13.5 asks
   * for. Mutation testing found it: forcing the track to render unconditionally
   * and coalescing the fraction with `?? 0` — the precise defect the spec forbids —
   * left all twenty tests green, because the early return got there first.
   *
   * So the branch is gone. There is now exactly one thing standing between a held
   * wrap-up and a forever-empty track, and breaking it reds the suite.
   */
  const showReason = view.fraction === null || view.holding;

  return (
    <span className={styles.region} data-panel={view.panel}>
      {/*
        The bar is primary and the digits are secondary: a shrinking length is
        legible in peripheral vision and a number is not.

        `aria-hidden` on both, because the rail is this screen's only polite live
        region (§A.11) and a countdown inside it would announce on every repaint —
        four times a second, for the length of every wrap-up of the shift. The two
        licensed announcements (10s and 3s) are the page's, and they are two
        strings rather than a stream.
      */}
      {/*
        `fraction !== null` is the render decision itself, not a type guard bolted
        on afterwards — the null selects WHETHER the bar exists. Written as
        `scaleX(${fraction ?? 0})` this would compile, draw a track, throw nothing,
        and fail no test that merely renders the held state; the defect would be a
        bar that never moves again, which is invisible in review because it looks
        like a bar that happens to be empty right now.
      */}
      {view.fraction !== null ? (
        <span className={styles.track} data-testid="wrapup-track" aria-hidden="true">
          <span
            className={styles.fill}
            data-testid="wrapup-fill"
            // `scaleX`, not `width`: width animates layout and janks on a screen
            // that is also decoding audio, and a stuttering bar reads as an
            // unresponsive UI.
            style={{ transform: `scaleX(${view.fraction})` }}
          />
        </span>
      ) : null}
      {view.label !== null ? (
        <span className={styles.digits} data-testid="wrapup-digits" aria-hidden="true">
          {view.label}
        </span>
      ) : null}
      {/*
        Stated whenever the window is waiting on the agent rather than on a clock —
        which covers both the hold at `0:00` (track still there, draining done) and
        the deadline-less panel (no track at all).

        The hold must NOT count negative and must NOT show an overrun readout: an
        "over by 0:47" is a surveillance surface pointed at the agent, and its
        effect is rushed, low-quality dispositions — the exact data failure the
        wrap-up window exists to prevent.
      */}
      {showReason ? (
        <span className={styles.heldReason} data-testid="wrapup-held-reason">
          {heldReason}
        </span>
      ) : null}
    </span>
  );
}
