import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { FlagDialog } from '../../components/super-admin/feature-flags/FlagDialog';

afterEach(() => cleanup());

function renderDialog(props: Partial<Parameters<typeof FlagDialog>[0]> = {}) {
  const onClose = props.onClose ?? vi.fn();
  render(
    <FlagDialog title="My Dialog" onClose={onClose} {...props}>
      <button>A</button>
      <button>B</button>
    </FlagDialog>,
  );
  return { onClose };
}

describe('FlagDialog — semantics', () => {
  it('exposes a labelled modal dialog by default', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledby = dialog.getAttribute('aria-labelledby');
    expect(labelledby).toBeTruthy();
    expect(document.getElementById(labelledby!)?.textContent).toBe('My Dialog');
  });

  it('can render as an alertdialog', () => {
    renderDialog({ role: 'alertdialog' });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});

describe('FlagDialog — dismissal', () => {
  it('closes on Escape', () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on the header close button', () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on overlay (backdrop) mousedown but not on panel mousedown', () => {
    const { onClose } = renderDialog();
    const panel = screen.getByRole('dialog');
    const overlay = panel.parentElement as HTMLElement;
    fireEvent.mouseDown(panel);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('FlagDialog — focus management', () => {
  it('moves initial focus into the dialog', () => {
    renderDialog();
    // First focusable in DOM order is the header Close button.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  it('respects child autoFocus instead of stealing focus', () => {
    render(
      <FlagDialog title="Auto" onClose={vi.fn()}>
        <input aria-label="first" autoFocus />
        <button>B</button>
      </FlagDialog>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('first'));
  });

  it('traps Tab from the last focusable back to the first', () => {
    renderDialog();
    const last = screen.getByRole('button', { name: 'B' });
    act(() => last.focus());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  it('traps Shift+Tab from the first focusable to the last', () => {
    renderDialog();
    const first = screen.getByRole('button', { name: 'Close' });
    act(() => first.focus());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'B' }));
  });

  it('restores focus to the trigger when closed', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          {open && (
            <FlagDialog title="X" onClose={() => setOpen(false)}>
              <button>Inside</button>
            </FlagDialog>
          )}
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    act(() => trigger.focus());
    fireEvent.click(trigger);
    // Focus has moved into the dialog.
    expect(document.activeElement).not.toBe(trigger);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });
});
