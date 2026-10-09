import styles from './QueuedBreakPill.module.css';

/**
 * "Break after this call — Lunch ✕" (§A.13.4).
 *
 * Makes a deferred action visible. A break requested while `on_call` is queued
 * and applied at the end of wrap-up, and the failure mode without this pill is
 * specific and known: the agent presses Break, sees nothing change, and presses
 * it again.
 *
 * **This is a warning, not a receipt.** Core reports the queue with `peek`, never
 * `take` (`agency.routes.ts`, `wrapup-manager.ts`), and `releaseAgent` applies the
 * break the moment wrap-up ends whether or not this pill was ever on screen. So the
 * subject is not "we recorded your request" but "you are about to be taken out of
 * the pool" — which is why the ✕ issues a real `POST /break/cancel` and is not a
 * local dismiss, and why nothing here may hide the pill on the agent's behalf.
 *
 * **Fed by `pending_state` from three places, and the response is only the fastest
 * one.** It arrives on the HTTP body that queues the break (immediate feedback for
 * the agent's own click), on every `agent_state` transition, and on `ready` after a
 * reconnect — the last of which is the only source a console that reloaded
 * mid-wrap-up has. `useAgencyConsole` reconciles the three; the frames win.
 *
 * **The rail deliberately does not change.** The agent is on a call; the rail is
 * the call's state. Tinting it is the obvious "helpful" thing to do and would
 * mean the most important 64px on the screen is describing something that has not
 * happened yet.
 */
export interface QueuedBreakPillProps {
  /** Label of the queued reason, e.g. "Lunch". */
  reasonLabel: string;
  /** True while the cancel request is in flight. */
  cancelling: boolean;
  /** Set when the last cancel attempt failed. */
  cancelFailed: boolean;
  onCancel: () => void;
}

export function QueuedBreakPill({
  reasonLabel,
  cancelling,
  cancelFailed,
  onCancel,
}: QueuedBreakPillProps) {
  /**
   * **Focus must survive re-render**, and the way this achieves it is by removing
   * the failure mode rather than recovering from it.
   *
   * The spec allows either defence — "it is not re-created (keyed/stable
   * identity), or focus is captured and restored across the update". Two facts
   * make the first one the only honest choice here:
   *
   *  1. **The node is never re-created.** This console re-renders whenever a frame
   *     lands (a heartbeat, a `campaign_state`, anything), and React keeps the
   *     same DOM node across those renders because the element's identity and
   *     position are stable. Nothing here is conditionally swapped for a
   *     different element or re-keyed.
   *  2. **The ✕ is never `disabled`.** This is the subtle half. In real browsers,
   *     disabling a focused element **blurs it** — so `disabled={cancelling}`
   *     would drop focus to `<body>` on the agent's own click, exactly on the path
   *     where the spec requires focus to stay put. `aria-disabled` plus a guard in
   *     the handler conveys the same thing to assistive tech while the element
   *     remains focusable, so focus cannot be lost in the first place.
   *
   * A restore effect was tried and removed: it could not be honestly tested
   * (happy-dom does not blur on disable, so the unit test passed with the effect
   * deleted and proved nothing), and once the button is never disabled there is no
   * loss left to recover from. Dead code that looks like a safety net is worse
   * than no safety net, because a reviewer reads it and assumes the property is
   * defended. The designer later confirmed in a real browser that `disabled` on a
   * focused button moves focus to `<body>` and **re-enabling does not restore
   * it** — so a restore-after-response effect could never have worked either:
   * focus would already have been on `<body>` for the length of the request.
   *
   * ── ⚠️ DO NOT GENERALISE THIS TO THE RAIL (§A.13.9) ─────────────────────────
   * There are **two** focus-loss mechanisms and they look like one bug:
   *
   *  (a) **the node is replaced by a re-render** — the rail rewrites every 250ms
   *      whether or not anyone interacted, so a focused control inside it is
   *      genuinely re-created and its focus genuinely must be captured and
   *      restored. That is `AD-P2-U-04` and that handling has to stay.
   *  (b) **the node is disabled** — this component's case, fixed structurally by
   *      never disabling it.
   *
   * Having solved (b) by removing the failure mode, the tempting conclusion is
   * that (a) is the same problem already handled. It is not: nothing here
   * prevents a node being replaced, because nothing here replaces one.
   */
  return (
    <div className={styles.wrap}>
      {/*
        The chip is text the agent reads; only the ✕ is a target. Making the whole
        chip clickable would put a destructive action under a label someone is
        trying to read mid-call.
      */}
      <span className={styles.chip} data-testid="queued-break-chip">
        <span className={styles.chipText}>Break after this call — {reasonLabel}</span>
        <button
          type="button"
          className={styles.cancel}
          // A real accessible name, not a bare glyph.
          aria-label="Cancel queued break"
          // NOT `disabled`: disabling a focused element blurs it in real
          // browsers, which would drop a keyboard agent to `<body>` mid-call on
          // their own click. See the note above.
          aria-disabled={cancelling || undefined}
          data-cancelling={cancelling ? 'true' : undefined}
          onClick={() => {
            if (cancelling) return;
            onCancel();
          }}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </span>
      {/*
        On failure the pill KEEPS its text and the error renders beside it: the
        break is still queued, which is the truth, and the agent's next action
        (press ✕ again) is the right one. Never in the rail — the rail is the
        call's state, and a transient error there would break that rule for the
        one case where the agent can least afford a distraction.

        No third live region: this rides the console's existing assertive region,
        the same channel as a rejected disposition, because it is the direct
        result of a button the agent just pressed.
      */}
      {cancelFailed && <span className={styles.error}>Couldn't cancel. Try again.</span>}
    </div>
  );
}
