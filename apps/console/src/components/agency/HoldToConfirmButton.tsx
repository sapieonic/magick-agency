import { useCallback, useEffect, useRef, useState } from 'react';
import { trackAgencyHoldAbandoned } from '../../analytics/events';
import styles from './HoldToConfirmButton.module.css';

/**
 * Hang up, with a deliberate second signal (§A.7.1.1, `AD-P2-U-02`).
 *
 * Phase 1 shipped a plain button, which means the most destructive control on the
 * screen — sitting in the corner an agent's cursor rests in — fired on a single
 * click, 200 times a shift, on calls to real people.
 *
 * **Not a confirm dialog.** A dialog costs a decision and two clicks 200 times a
 * day; agents learn to dismiss it reflexively, at which point it protects nothing
 * and costs everything. A press-and-hold is one continuous gesture,
 * self-cancelling, visibly instructive, and impossible to trigger with a jogged
 * trackpad.
 *
 * ── The numbers are fixed, and stability is worth more than tuning ────────────
 * **500ms.** Below ~500ms the gesture is inside the range of an ordinary click on a
 * stiff trackpad and protects nothing; above ~800ms the button reads as broken. An
 * agent who has learned the length of this gesture must not find it changed after
 * a release, so it is not configurable and not a per-agent preference.
 *
 * **Completion fires on the timer, not on release.** At 500ms the hang-up is sent
 * with the finger still down and the subsequent release is ignored. "Hold, *then*
 * release" adds a second uncertain step, and agents answer uncertainty by holding
 * for two seconds "to be sure" — turning a 500ms gesture into a 2s one, 200 times
 * a day.
 *
 * ── Why the keyboard path is not a held key ──────────────────────────────────
 * Key-repeat rate is an OS setting the user can disable entirely, so a held key is
 * not a reliable clock and on some machines produces exactly one event. The
 * keyboard equivalent is therefore **`E` twice within 1.5s** — and it drives the
 * *same fill element*, in reverse, so the fill always means one thing: **an
 * end-call gesture is in progress**, whichever hand started it.
 *
 * ── One re-decision against §A.7.1.1, deliberately ──────────────────────────
 * The spec says the button is "disabled" after firing and while ending. It is
 * **`aria-disabled`, never `disabled`**. §A.13.9 measured what `disabled` does to a
 * focused control in a real browser: focus drops to `<body>`, and **re-enabling
 * does not restore it**. An agent who fired this with `E`,`E` has focus on this
 * button by definition, so a real `disabled` would strand them at the top of the
 * document at the exact moment a call is ending — and no restore-after-response
 * effect can recover it. The intent of "disabled" (it cannot fire twice) is met by
 * the handler guard.
 */

/** Fixed by §A.7.1.1. Not configurable — see the note above. */
export const HOLD_MS = 500;
/** The `E`,`E` window. Also fixed. */
export const DOUBLE_KEY_MS = 1500;
/** How long we wait for `released` before admitting we cannot confirm the end. */
export const RELEASE_TIMEOUT_MS = 3000;

export const HANGUP_FAILED_COPY = "We couldn't end the call. Try again.";
export const HANGUP_HINT_COPY = 'Press and hold to end the call, or press E twice.';

export type Phase =
  /** Nothing in progress. */
  | 'idle'
  /** Pointer is down, the 500ms fill is running. */
  | 'holding'
  /** First `E` seen, the 1.5s window is running down. */
  | 'armed'
  /** Fired. Waiting for `released`, which is the only authoritative end. */
  | 'ending'
  /** No `released` within 3s. The agent may try again — we never retry for them. */
  | 'failed';

/**
 * Everything about this button that is copy or identity rather than mechanism.
 *
 * ── Why this is a prop and not a second component ───────────────────────────
 * The retry dialog needs the same gesture for the same reason the console does:
 * an irreversible act, one continuous self-cancelling motion, impossible to
 * trigger with a jogged trackpad. What it does NOT need is a second
 * implementation of a 500ms fill, a double-key window and a phase machine that
 * were each argued for line by line above — a copy of this file with different
 * strings is how one of those numbers quietly becomes 300ms on one surface.
 *
 * So the mechanism stays single-definition and the words move out. Every field
 * has a default that reproduces the hang-up button EXACTLY, so the console's
 * call site is unchanged and cannot be changed by editing this type.
 */
export interface HoldToConfirmCopy {
  /**
   * Distinguishes this instance's DOM ids and test ids from every other one on
   * the page. The hint node is addressed by `aria-describedby`, so two buttons
   * sharing a prefix would give one of them a description pointing at the
   * other's — which reads correctly in a browser and is wrong to a screen
   * reader, i.e. exactly the class of fault nobody notices.
   */
  idPrefix: string;
  /** Label per phase. Read as a sentence about the gesture, not as a button name. */
  labels: Record<Phase, string>;
  /** The persistent hint under the button. Names BOTH input paths. */
  hint: string;
  /** Shown when the confirmation never arrives. Never auto-retried. */
  failedCopy: string;
  /**
   * Where the `E`,`E` keydown listener lives.
   *
   * **`window`** for the console: `E` is a global shortcut (§A.9) and an agent
   * whose focus is in the contact panel still has to be able to end a call.
   *
   * **`self`** everywhere else, and it is not a lesser option — a page-wide key
   * that creates a campaign because a supervisor was typing outside a text field
   * is a worse failure than any it prevents. Scoped to the button, the gesture
   * is still fully keyboard-operable (Tab to it, `E`, `E`) and cannot fire from
   * anywhere the user is not already looking.
   */
  shortcutScope: 'window' | 'self';
  /**
   * Who closes the loop after the gesture fires.
   *
   * **`external`** — the truth arrives out of band and may never arrive at all,
   * so an unanswered gesture becomes `failed` after {@link RELEASE_TIMEOUT_MS}.
   * That is the console: `released` on the socket is the authoritative end of a
   * call and the HTTP response is only an acknowledgement.
   *
   * **`caller`** — the caller is awaiting a promise and owns both outcomes, so
   * there is no timeout. A three-second deadline on an awaited request says "we
   * couldn't" while the request is still in flight, and on a create that is a
   * lie about whether a campaign now exists. The caller re-arms by changing
   * `attemptId`.
   */
  confirmation: 'external' | 'caller';
  /** Which control an abandoned hold is reported as. */
  analyticsControl: 'hangup' | 'retry_campaign';
}

export const HANGUP_COPY: HoldToConfirmCopy = {
  idPrefix: 'hangup',
  labels: {
    idle: 'Hang up',
    holding: 'Hold to end…',
    armed: 'Press E again to end',
    ending: 'Ending…',
    failed: 'Hang up',
  },
  hint: HANGUP_HINT_COPY,
  failedCopy: HANGUP_FAILED_COPY,
  shortcutScope: 'window',
  confirmation: 'external',
  analyticsControl: 'hangup',
};

export interface HoldToConfirmButtonProps {
  /**
   * The subject this button acts on. **Changing it is what resets the button**, so
   * the one-shot-per-subject rule and "the label returns to Hang up only on the
   * next `reserved`" are the same mechanism rather than two.
   *
   * On the console this is the attempt id, which is where the name comes from. A
   * caller with no attempt passes whatever identifies the single thing it is
   * about to do, and changes it to re-arm the button after a refusal — with
   * `confirmation: 'caller'` that is the only thing that returns it to `idle`.
   */
  attemptId: string | null;
  /** False from `reserved` onward is never correct — live from `reserved` (§A.7.1). */
  enabled: boolean;
  /** Visible stated reason when there is nothing to hang up. */
  disabledReason?: string | null;
  /** Fire-and-forget on the socket. The authoritative end is `released`. */
  onConfirm: () => void;
  /**
   * Words and identity. Omitted — the console's only call site — this is the
   * hang-up button, byte for byte.
   */
  copy?: HoldToConfirmCopy;
}

export function HoldToConfirmButton({
  attemptId,
  enabled,
  disabledReason = null,
  onConfirm,
  copy = HANGUP_COPY,
}: HoldToConfirmButtonProps) {
  const hintId = `${copy.idPrefix}-hint`;
  const [phase, setPhase] = useState<Phase>('idle');
  const fillRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const windowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;
  /**
   * Analytics-only: when the pointer-hold gesture started, so an abandoned hold
   * (released before `HOLD_MS`) can report how long it was actually held.
   * `'holding'` only — the `E`,`E` keyboard path runs on a different clock
   * (`DOUBLE_KEY_MS`) that this bucketing does not describe.
   */
  const holdStartRef = useRef<number | null>(null);

  const clearTimer = (ref: typeof holdTimer) => {
    if (ref.current !== null) clearTimeout(ref.current);
    ref.current = null;
  };

  /**
   * The fill resets with **no transition**. An animated reset implies the action is
   * still pending, which is the opposite of what a cancel means.
   */
  const resetFill = useCallback(() => {
    const node = fillRef.current;
    if (!node) return;
    node.style.transition = 'none';
    node.style.transform = 'scaleX(0)';
  }, []);

  /** Runs the fill from `from` to `to` over `ms`, linearly. */
  const runFill = useCallback((from: number, to: number, ms: number) => {
    const node = fillRef.current;
    if (!node) return;
    node.style.transition = 'none';
    node.style.transform = `scaleX(${from})`;
    // Reading a layout property commits the starting frame, so the transition
    // below animates from `from` rather than jumping straight to `to`.
    void node.offsetWidth;
    // **Linear.** An eased fill lies about how much time is left. And it is
    // animated even under `prefers-reduced-motion`: this is a progress indicator
    // for a destructive action, not decoration — removing it removes the only
    // feedback that the gesture is working.
    node.style.transition = `transform ${ms}ms linear`;
    node.style.transform = `scaleX(${to})`;
  }, []);

  /** The shared timer/fill/phase reset, with no analytics of its own. */
  const resetHold = useCallback(() => {
    clearTimer(holdTimer);
    clearTimer(windowTimer);
    resetFill();
    setPhase((current) => (current === 'holding' || current === 'armed' ? 'idle' : current));
  }, [resetFill]);

  const cancel = useCallback(() => {
    // Silent and instant. Nothing is announced on cancel — a live region firing on
    // every abandoned hold is noise that trains the user to ignore it.
    //
    // Analytics only, and read from `phaseRef` rather than inside the `setPhase`
    // updater below: an updater can run more than once for one state change
    // (e.g. under Strict Mode), and this must fire exactly once per abandonment.
    if (phaseRef.current === 'holding' && holdStartRef.current !== null) {
      const heldMs = Date.now() - holdStartRef.current;
      trackAgencyHoldAbandoned({
        control: copy.analyticsControl,
        held_ms_bucket: heldMs < 200 ? 'under_200' : heldMs < 400 ? '200_400' : '400_500',
      });
    }
    resetHold();
  }, [resetHold, copy.analyticsControl]);

  const fire = useCallback(() => {
    clearTimer(holdTimer);
    clearTimer(windowTimer);
    resetFill();
    setPhase('ending');
    onConfirm();
    // The button must not pretend the call is over. `released` is the
    // authoritative end (§A.3.1) — never `ended`, never `status: 'completed'`.
    //
    // This said "the hangup frame is fire-and-forget on the socket", which was
    // the wrong reason for the right behaviour: nothing read that frame, so the
    // timeout below was the only thing that ever fired and `failed` was the true
    // outcome of every hang-up (`MAG-112`). The reason now is that the HTTP
    // response acknowledges the request while the terminal state still arrives on
    // the socket — so waiting for `released` remains correct.
    //
    // `caller` confirmation skips the deadline entirely: the caller is awaiting
    // a promise and reports both outcomes itself, so a timer here would race a
    // request that is still in flight and announce a failure that has not
    // happened. It re-arms by changing `attemptId`.
    if (copy.confirmation === 'external') {
      releaseTimer.current = setTimeout(() => setPhase('failed'), RELEASE_TIMEOUT_MS);
    }
  }, [onConfirm, resetFill, copy.confirmation]);

  /**
   * One-shot per attempt, and the reset. A new `reserved` brings a new
   * `attemptId`; nothing else returns the label to "Hang up".
   *
   * This is also what guards a hold and an `E`,`E` racing each other: both land in
   * `ending`, and `ending` accepts no input.
   */
  useEffect(() => {
    clearTimer(holdTimer);
    clearTimer(windowTimer);
    clearTimer(releaseTimer);
    resetFill();
    setPhase('idle');
  }, [attemptId, resetFill]);

  /**
   * A `released` frame arriving mid-hold takes the button away under the
   * agent. That resets the hold rather than racing it — but silently, via
   * `resetHold` rather than `cancel`: the call ending out from under the
   * agent (a customer hangup, a supervisor release) is not the agent
   * abandoning their own gesture, and routing it through `cancel` recorded
   * every such call as a false `agency_hold_abandoned`.
   */
  useEffect(() => {
    if (!enabled) resetHold();
  }, [enabled, resetHold]);

  useEffect(
    () => () => {
      clearTimer(holdTimer);
      clearTimer(windowTimer);
      clearTimer(releaseTimer);
    },
    [],
  );

  const startHold = () => {
    if (!enabled || phase === 'ending') return;
    holdStartRef.current = Date.now();
    setPhase('holding');
    runFill(0, 1, HOLD_MS);
    holdTimer.current = setTimeout(fire, HOLD_MS);
  };

  /**
   * `E` is a global shortcut (§A.9), so the listener is on the window rather than
   * the button — an agent whose focus is in the contact panel still needs it. The
   * suppression rule lives here too: **all single-key shortcuts are suppressed
   * while focus is inside a text input**, because a note containing the letter "e"
   * must not end the call.
   */
  useEffect(() => {
    if (!enabled) return undefined;
    // `self` scope binds to the button; until it has mounted there is nothing to
    // bind to, and `buttonRef` is filled on the same commit that runs this.
    const target: Window | HTMLElement | null =
      copy.shortcutScope === 'window' ? window : buttonRef.current;
    if (!target) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const inTextInput =
        tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true;

      if (event.key === 'Escape') {
        cancel();
        return;
      }
      if (inTextInput || event.ctrlKey || event.metaKey || event.altKey) {
        // Focus entering a text input is itself a cancel (§A.7.1.1): an agent who
        // has gone to type is no longer ending a call.
        if (inTextInput && phaseRef.current === 'armed') cancel();
        return;
      }
      if (event.key !== 'e' && event.key !== 'E') return;
      if (phaseRef.current === 'ending') return;

      event.preventDefault();
      if (phaseRef.current === 'armed') {
        fire();
        return;
      }
      // First press — or a fresh press after the window lapsed, which simply
      // restarts it rather than ending the call.
      setPhase('armed');
      // The SAME fill element, run in reverse: full to empty over the window. One
      // meaning for one element.
      runFill(1, 0, DOUBLE_KEY_MS);
      clearTimer(windowTimer);
      windowTimer.current = setTimeout(cancel, DOUBLE_KEY_MS);
    };

    target.addEventListener('keydown', onKeyDown as EventListener);
    return () => target.removeEventListener('keydown', onKeyDown as EventListener);
  }, [enabled, cancel, fire, runFill, copy.shortcutScope]);

  // The window losing focus cancels: a hold the agent has walked away from is not
  // a hold.
  useEffect(() => {
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, [cancel]);

  const inert = !enabled || phase === 'ending';

  return (
    <div className={styles.wrap}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.button}
        data-phase={phase}
        // NEVER `disabled` — see the re-decision note at the top of this file.
        aria-disabled={inert || undefined}
        aria-keyshortcuts="e"
        aria-describedby={hintId}
        onPointerDown={startHold}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onKeyDown={(event) => {
          // `Esc` on the button cancels the hold (§A.9) without bubbling into a
          // page-level handler that might also close something.
          //
          // Gated on there being a gesture to cancel. Unconditionally, this
          // swallowed Escape in `idle` too — and once this control lives inside
          // a modal, tab-to-the-primary-action then Escape is the natural way to
          // dismiss, so the dialog simply stopped closing while focus was here.
          // Overlay click and Cancel still worked, which is exactly the kind of
          // "mostly fine" that goes unreported.
          //
          // In `holding`/`armed` the stop is still right: Escape means "not
          // that", and it should abandon the gesture rather than also closing
          // the dialog around it.
          const phase = phaseRef.current;
          if (event.key === 'Escape' && (phase === 'holding' || phase === 'armed')) {
            event.stopPropagation();
          }
        }}
      >
        {/* Geometry is frozen: the fill is an overlay driven by `transform`, so
            nothing about the button's box changes during the gesture. A control
            that resizes mid-press is a misclick, and a misclick here hangs up on a
            human being. */}
        <span
          ref={fillRef}
          className={styles.fill}
          data-testid={`${copy.idPrefix}-fill`}
          aria-hidden="true"
        />
        <span className={styles.label}>{copy.labels[phase]}</span>
      </button>

      {/* Persistent hint node, not a live region — the hold announces nothing. */}
      <span id={hintId} className={styles.hint}>
        {copy.hint}
      </span>

      {/*
        Inline, in the action bar, and the console NEVER retries automatically: a
        retry landing after a new `reserved` hangs up a different customer. The same
        shape §A.13.6 forbids for a stale disposition response, written twice
        because the two are implemented in different files.
      */}
      {phase === 'failed' ? (
        <span className={styles.error} role="alert" data-testid={`${copy.idPrefix}-failed`}>
          {copy.failedCopy}
        </span>
      ) : null}

      {!enabled && disabledReason ? (
        <span className={styles.blockedReason}>{disabledReason}</span>
      ) : null}
    </div>
  );
}
