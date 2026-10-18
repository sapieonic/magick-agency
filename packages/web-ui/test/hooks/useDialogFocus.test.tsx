import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useRef, useState } from 'react';
import { trapTab, useDialogFocus } from '../../src/hooks/useDialogFocus';

/**
 * The one focus implementation `Modal`, `ConfirmDialog` and the console's
 * `useDialogA11y` / `useModalFocus` share.
 */
function Dialog({
  open,
  onEscape,
  autofocus = false,
  useInitialRef = false,
}: {
  open: boolean;
  onEscape?: () => void;
  autofocus?: boolean;
  useInitialRef?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialRef = useRef<HTMLButtonElement>(null);
  useDialogFocus({ open, dialogRef, onEscape, initialFocusRef: useInitialRef ? initialRef : undefined });
  if (!open) return null;
  return (
    <div ref={dialogRef}>
      <button type="button">first</button>
      <input aria-label="field" data-autofocus={autofocus ? 'true' : undefined} />
      <button type="button" ref={initialRef}>last</button>
    </div>
  );
}

function Harness(props: { onEscape?: () => void; autofocus?: boolean; useInitialRef?: boolean }) {
  const [open, setOpen] = useState(false);
  const [ticks, setTicks] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setOpen((o) => !o)}>trigger</button>
      <button type="button" onClick={() => setTicks((t) => t + 1)}>rerender {ticks}</button>
      {/* An inline callback: a new identity every render. */}
      <Dialog open={open} onEscape={props.onEscape ? () => props.onEscape!() : undefined} autofocus={props.autofocus} useInitialRef={props.useInitialRef} />
    </>
  );
}

function byText(container: HTMLElement, text: string): HTMLElement {
  return [...container.querySelectorAll<HTMLElement>('button, input')].find(
    (el) => el.textContent === text || el.getAttribute('aria-label') === text,
  )!;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function openDialog(container: HTMLElement) {
  const trigger = byText(container, 'trigger');
  trigger.focus();
  fireEvent.click(trigger);
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  return trigger;
}

describe('useDialogFocus', () => {
  it('moves focus to the first control, wraps Tab at both edges, and restores focus on close', async () => {
    const { container } = render(<Harness />);
    const trigger = await openDialog(container);
    const first = byText(container, 'first');
    const last = byText(container, 'last');
    expect(document.activeElement).toBe(first);

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.click(trigger);
    expect(document.activeElement).toBe(trigger);
  });

  it('prefers a data-autofocus control, and an explicit ref over both', async () => {
    const marked = render(<Harness autofocus />);
    await openDialog(marked.container);
    expect(document.activeElement).toBe(byText(marked.container, 'field'));
    cleanup();

    const ref = render(<Harness autofocus useInitialRef />);
    await openDialog(ref.container);
    expect(document.activeElement).toBe(byText(ref.container, 'last'));
  });

  it('calls onEscape, and an inline callback does not re-arm the open effect', async () => {
    const onEscape = vi.fn();
    const { container } = render(<Harness onEscape={onEscape} />);
    await openDialog(container);

    // Focus moves inside the dialog; a re-render with a new callback must not
    // pull it back to the first control after the autofocus delay.
    const field = byText(container, 'field');
    field.focus();
    fireEvent.click(byText(container, 'rerender 0'));
    field.focus();
    await act(async () => { await vi.advanceTimersByTimeAsync(60); });
    expect(document.activeElement).toBe(field);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});

describe('trapTab', () => {
  it('reports a non-Tab key as unhandled and leaves it alone', () => {
    const event = new KeyboardEvent('keydown', { key: 'Enter' });
    expect(trapTab(event, document.body)).toBe(false);
  });
});
