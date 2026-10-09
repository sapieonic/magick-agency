import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import {
  HoldToConfirmButton,
  HOLD_MS,
  DOUBLE_KEY_MS,
  RELEASE_TIMEOUT_MS,
  HANGUP_FAILED_COPY,
  HANGUP_HINT_COPY,
} from '../../components/agency/HoldToConfirmButton';
import { RETRY_HOLD_COPY } from '../../components/agency/AgencyRetryDialog';

/**
 * `HoldToConfirmButton`.
 *
 * ends by naming exactly what QA can assert, and those five are the spine
 * of this file: a 400ms press ends nothing; a 500ms press ends exactly once; a
 * press interrupted at 300ms by `Esc` ends nothing and leaves no residual fill;
 * `E`,`E` at 1.4s apart ends once and at 1.6s apart ends nothing; and a `released`
 * arriving 250ms into a hold cancels rather than races.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function setup(props: Partial<Parameters<typeof HoldToConfirmButton>[0]> = {}) {
  const onConfirm = vi.fn();
  const utils = render(
    <HoldToConfirmButton attemptId="attempt-a" enabled onConfirm={onConfirm} {...props} />,
  );
  return { onConfirm, ...utils };
}

const button = () => screen.getByRole('button');
const fill = () => screen.getByTestId('hangup-fill');
const label = () => button().textContent;

describe('the five assertions names', () => {
  it('a 400ms press ends nothing', () => {
    const { onConfirm } = setup();
    fireEvent.pointerDown(button());
    advance(400);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a 500ms press ends exactly once', () => {
    const { onConfirm } = setup();
    fireEvent.pointerDown(button());
    advance(HOLD_MS);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('a press interrupted at 300ms by Esc ends nothing and leaves no residual fill', () => {
    const { onConfirm } = setup();
    fireEvent.pointerDown(button());
    advance(300);
    fireEvent.keyDown(window, { key: 'Escape' });
    advance(1000);

    expect(onConfirm).not.toHaveBeenCalled();
    expect(fill().style.transform).toBe('scaleX(0)');
    // The reset carries NO transition: an animated reset implies the action is
    // still pending, which is the opposite of what a cancel means.
    expect(fill().style.transition).toBe('none');
    expect(label()).toBe('Hang up');
  });

  it('E,E at 1.4s apart ends once', () => {
    const { onConfirm } = setup();
    fireEvent.keyDown(window, { key: 'e' });
    advance(1400);
    fireEvent.keyDown(window, { key: 'e' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('E,E at 1.6s apart ends nothing', () => {
    const { onConfirm } = setup();
    fireEvent.keyDown(window, { key: 'e' });
    advance(1600);
    fireEvent.keyDown(window, { key: 'e' });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a released frame at 250ms into a hold cancels rather than races', () => {
    const { onConfirm, rerender } = setup();
    fireEvent.pointerDown(button());
    advance(250);

    // `released` took the call away; the page drops `enabled`.
    rerender(<HoldToConfirmButton attemptId="attempt-a" enabled={false} onConfirm={onConfirm} />);
    advance(1000);

    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('completion fires on the timer, not on release', () => {
  it('fires with the finger still down', () => {
    // "Hold, THEN release" adds a second uncertain step, and agents answer
    // uncertainty by holding for two seconds "to be sure" — turning a 500ms
    // gesture into a 2s one, 200 times a day.
    const { onConfirm } = setup();
    fireEvent.pointerDown(button());
    advance(HOLD_MS);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(label()).toBe('Ending…');
  });

  it('ignores the subsequent release', () => {
    const { onConfirm } = setup();
    fireEvent.pointerDown(button());
    advance(HOLD_MS);
    fireEvent.pointerUp(button());
    advance(100);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(label()).toBe('Ending…');
  });

  it('a 499ms press ends nothing — the boundary is exact', () => {
    const { onConfirm } = setup();
    fireEvent.pointerDown(button());
    advance(HOLD_MS - 1);
    expect(onConfirm).not.toHaveBeenCalled();
    advance(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('everything that cancels, silently and instantly', () => {
  it.each([
    ['pointer-up', () => fireEvent.pointerUp(button())],
    ['pointer-leave', () => fireEvent.pointerLeave(button())],
    ['pointer-cancel', () => fireEvent.pointerCancel(button())],
    ['window blur', () => fireEvent.blur(window)],
  ])('%s', (_name, act_) => {
    const { onConfirm } = setup();
    fireEvent.pointerDown(button());
    advance(200);
    act_();
    advance(1000);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(fill().style.transform).toBe('scaleX(0)');
  });
});

describe('the label says what is happening, and resets only on a new attempt', () => {
  it('reads Hang up at rest', () => {
    setup();
    expect(label()).toBe('Hang up');
  });

  it('reads Hold to end… during the hold', () => {
    setup();
    fireEvent.pointerDown(button());
    advance(200);
    expect(label()).toBe('Hold to end…');
  });

  it('gives a visible instruction after the first E', () => {
    // Phase 1 gave the keyboard path no feedback at all. Without this the agent
    // has pressed a key and nothing has happened.
    setup();
    fireEvent.keyDown(window, { key: 'e' });
    expect(label()).toBe('Press E again to end');
  });

  it('runs the SAME fill in reverse for the keyboard window', () => {
    // One element, one meaning: the fill always says "an end-call gesture is in
    // progress", whichever hand started it.
    setup();
    fireEvent.keyDown(window, { key: 'e' });
    expect(fill().style.transform).toBe('scaleX(0)');
    expect(fill().style.transition).toBe(`transform ${DOUBLE_KEY_MS}ms linear`);
  });

  it('holds Ending… until a NEW attempt arrives, not until the next render', () => {
    const { onConfirm, rerender } = setup();
    fireEvent.pointerDown(button());
    advance(HOLD_MS);
    expect(label()).toBe('Ending…');

    // An unrelated re-render — a heartbeat, a campaign_state — must not reset it.
    rerender(<HoldToConfirmButton attemptId="attempt-a" enabled onConfirm={onConfirm} />);
    expect(label()).toBe('Ending…');

    // A new `reserved` does.
    rerender(<HoldToConfirmButton attemptId="attempt-b" enabled onConfirm={onConfirm} />);
    expect(label()).toBe('Hang up');
  });

  it('is one-shot per attempt — a second gesture cannot fire again', () => {
    const { onConfirm } = setup();
    fireEvent.pointerDown(button());
    advance(HOLD_MS);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(button());
    advance(HOLD_MS);
    fireEvent.keyDown(window, { key: 'e' });
    fireEvent.keyDown(window, { key: 'e' });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('the fill animates linearly over exactly the gesture duration', () => {
  it('runs 0 → 1 over the hold', () => {
    // Linear because an eased fill lies about how much time is left.
    setup();
    fireEvent.pointerDown(button());
    expect(fill().style.transform).toBe('scaleX(1)');
    expect(fill().style.transition).toBe(`transform ${HOLD_MS}ms linear`);
  });

  it('is still animated — no reduced-motion opt-out in the markup', () => {
    // It is a progress indicator for a destructive action, not decoration.
    // Removing it removes the only feedback that the gesture is working.
    setup();
    fireEvent.pointerDown(button());
    expect(fill().style.transition).toContain('linear');
  });
});

describe('E is suppressed inside a text input', () => {
  it('does not arm when typing a note containing "e"', () => {
    // The single most common way a shortcut system becomes unusable.
    const { onConfirm } = setup();
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    fireEvent.keyDown(textarea, { key: 'e' });
    fireEvent.keyDown(textarea, { key: 'e' });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(label()).toBe('Hang up');
    textarea.remove();
  });

  it('cancels an armed window when focus moves into a text input', () => {
    // An agent who has gone to type is no longer ending a call.
    const { onConfirm } = setup();
    fireEvent.keyDown(window, { key: 'e' });
    expect(label()).toBe('Press E again to end');

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'x' });

    expect(label()).toBe('Hang up');
    fireEvent.keyDown(window, { key: 'e' });
    expect(onConfirm).not.toHaveBeenCalled();
    textarea.remove();
  });

  it('a third E after the window lapses restarts it rather than ending the call', () => {
    const { onConfirm } = setup();
    fireEvent.keyDown(window, { key: 'e' });
    advance(DOUBLE_KEY_MS + 100);
    expect(label()).toBe('Hang up');

    fireEvent.keyDown(window, { key: 'e' });
    expect(label()).toBe('Press E again to end');
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'e' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('released is the authoritative end, and we never retry for the agent', () => {
  it('admits it could not confirm after 3s and re-enables', () => {
    setup();
    fireEvent.pointerDown(button());
    advance(HOLD_MS);
    expect(screen.queryByTestId('hangup-failed')).toBeNull();

    advance(RELEASE_TIMEOUT_MS);

    expect(screen.getByTestId('hangup-failed').textContent).toBe(HANGUP_FAILED_COPY);
    expect(label()).toBe('Hang up');
  });

  it('does not re-send on its own', () => {
    // A retry landing after a new `reserved` hangs up a DIFFERENT customer. The
    // same shape forbids for a stale disposition response.
    const { onConfirm } = setup();
    fireEvent.pointerDown(button());
    advance(HOLD_MS);
    advance(RELEASE_TIMEOUT_MS + 5000);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('clears the failure when the next attempt arrives', () => {
    const { onConfirm, rerender } = setup();
    fireEvent.pointerDown(button());
    advance(HOLD_MS + RELEASE_TIMEOUT_MS);
    expect(screen.getByTestId('hangup-failed')).toBeTruthy();

    rerender(<HoldToConfirmButton attemptId="attempt-b" enabled onConfirm={onConfirm} />);
    expect(screen.queryByTestId('hangup-failed')).toBeNull();
  });
});

describe('never disabled, and always described', () => {
  it('uses aria-disabled while ending, so a keyboard agent keeps focus', () => {
    // An agent who fired this with `E`,`E` has focus on this button BY DEFINITION.
    // A real `disabled` drops focus to `<body>` and re-enabling does not restore
    // it, so no effect could recover — the only fix is not to disable.
    setup();
    button().focus();
    fireEvent.pointerDown(button());
    advance(HOLD_MS);

    expect((button() as HTMLButtonElement).disabled).toBe(false);
    expect(button().getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button());
  });

  it('uses aria-disabled when there is no call, with a stated reason', () => {
    setup({ enabled: false, disabledReason: 'No call in progress' });
    expect((button() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('No call in progress')).toBeTruthy();
  });

  it('ignores a gesture while there is no call', () => {
    const { onConfirm } = setup({ enabled: false });
    fireEvent.pointerDown(button());
    advance(HOLD_MS);
    fireEvent.keyDown(window, { key: 'e' });
    fireEvent.keyDown(window, { key: 'e' });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('carries a persistent hint rather than announcing the hold', () => {
    // A live region firing on every hold is noise that trains the user to ignore
    // it. Completion is announced by the console's assertive region.
    setup();
    expect(button().getAttribute('aria-describedby')).toBe('hangup-hint');
    expect(screen.getByText(HANGUP_HINT_COPY)).toBeTruthy();
  });

  it('advertises its shortcut', () => {
    setup();
    expect(button().getAttribute('aria-keyshortcuts')).toBe('e');
  });
});

/**
 * The retry dialog reuses this control with two settings changed, and those two
 * are exactly what makes the reuse safe. Neither was pinned anywhere: this file
 * only ever drove the hang-up defaults, and the dialog's own suite covers a
 * successful create — which passes whatever these are set to.
 */
describe('the retry configuration — shortcutScope self, confirmation caller', () => {
  function retry(props: Partial<Parameters<typeof HoldToConfirmButton>[0]> = {}) {
    const onConfirm = vi.fn();
    const utils = render(
      <HoldToConfirmButton
        attemptId="retry-camp-1-0"
        enabled
        onConfirm={onConfirm}
        copy={RETRY_HOLD_COPY}
        {...props}
      />,
    );
    return { onConfirm, ...utils };
  }

  it('does NOT arm from a window-level E — the shortcut is scoped to the button', () => {
    // `'window'` is right on the console, where the agent's hands are on the
    // keyboard and the call is the only thing happening. In a modal it is not:
    // an E typed anywhere on the page — the campaign NAME field is in this very
    // dialog — would arm a control that creates a campaign and dials people.
    const { onConfirm } = retry();

    fireEvent.keyDown(window, { key: 'e' });
    advance(100);
    fireEvent.keyDown(window, { key: 'e' });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(button().textContent).toBe(RETRY_HOLD_COPY.labels.idle);
  });

  it('DOES arm from an E delivered to the button itself', () => {
    // The control half: scoping it to `self` must not disable the shortcut, only
    // narrow where it is heard.
    const { onConfirm } = retry();

    fireEvent.keyDown(button(), { key: 'e' });
    advance(100);
    fireEvent.keyDown(button(), { key: 'e' });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('never times out into `failed` while the caller\'s request is in flight', () => {
    // `confirmation: 'caller'`. With `'external'` this control gives up after
    // RELEASE_TIMEOUT_MS and says "The campaign was not created. Nothing
    // changed." — which, on an awaited POST that creates a campaign and seeds a
    // roster in one transaction, is a claim about the world that may be false.
    // There is no delete route in either service to make it true afterwards.
    const { onConfirm } = retry();

    fireEvent.keyDown(button(), { key: 'e' });
    advance(100);
    fireEvent.keyDown(button(), { key: 'e' });
    expect(onConfirm).toHaveBeenCalledTimes(1);

    advance(RELEASE_TIMEOUT_MS * 3);

    expect(button().textContent).not.toBe(RETRY_HOLD_COPY.failedCopy);
    expect(button().textContent).toBe(RETRY_HOLD_COPY.labels.ending);
    // And it never re-sends on its own.
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('returns to idle when the caller re-arms it with a new attemptId', () => {
    // The only thing that resets a `caller` button, which is why the dialog
    // carries an attempt token.
    const { onConfirm, rerender } = retry();

    fireEvent.keyDown(button(), { key: 'e' });
    advance(100);
    fireEvent.keyDown(button(), { key: 'e' });
    expect(onConfirm).toHaveBeenCalledTimes(1);

    rerender(
      <HoldToConfirmButton
        attemptId="retry-camp-1-1"
        enabled
        onConfirm={onConfirm}
        copy={RETRY_HOLD_COPY}
      />,
    );

    expect(button().textContent).toBe(RETRY_HOLD_COPY.labels.idle);
  });
});

describe('Escape on the button stops propagating only when there is a gesture', () => {
  it('lets Escape through while idle, so a modal around it can still close', () => {
    // Unconditionally stopping meant tab-to-the-primary-action then Escape —
    // the natural dismissal once focus is on the button — was swallowed. Overlay
    // click and Cancel still worked, which is how it went unnoticed.
    const onKeyDown = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <div onKeyDown={onKeyDown}>
        <HoldToConfirmButton attemptId="a" enabled onConfirm={vi.fn()} copy={RETRY_HOLD_COPY} />
      </div>,
    );

    fireEvent.keyDown(button(), { key: 'Escape' });
    expect(onKeyDown).toHaveBeenCalled();
  });

  it('swallows Escape mid-hold, because there Escape means "not that"', () => {
    const onKeyDown = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions
      <div onKeyDown={onKeyDown}>
        <HoldToConfirmButton attemptId="a" enabled onConfirm={vi.fn()} copy={RETRY_HOLD_COPY} />
      </div>,
    );

    fireEvent.pointerDown(button());
    advance(200);
    fireEvent.keyDown(button(), { key: 'Escape' });

    // The hold is abandoned rather than the dialog closed around it.
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(button().textContent).toBe(RETRY_HOLD_COPY.labels.idle);
  });
});
