import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ConfirmDialog } from '../../components/super-admin/feature-flags/ConfirmDialog';

afterEach(() => cleanup());

function renderDialog(over: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = over.onConfirm ?? vi.fn();
  const onClose = over.onClose ?? vi.fn();
  render(
    <ConfirmDialog
      title="Turn off My Flag?"
      body="My Flag is currently live."
      confirmLabel="Turn off"
      danger={over.danger}
      onConfirm={onConfirm}
      onClose={onClose}
    />,
  );
  return { onConfirm, onClose };
}

describe('ConfirmDialog', () => {
  it('renders as an alertdialog with the title and body', () => {
    renderDialog();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('Turn off My Flag?')).toBeTruthy();
    expect(screen.getByText('My Flag is currently live.')).toBeTruthy();
  });

  it('confirms via the labelled action', () => {
    const { onConfirm, onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Cancel and Close call onClose without confirming', () => {
    const { onConfirm, onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('uses a danger-styled confirm by default and a primary one when danger=false', () => {
    const { rerender } = render(
      <ConfirmDialog title="t" body="b" confirmLabel="Go" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Go' }).className).toContain('btn-danger');
    rerender(
      <ConfirmDialog title="t" body="b" confirmLabel="Go" danger={false} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Go' }).className).toContain('btn-primary');
  });
});
