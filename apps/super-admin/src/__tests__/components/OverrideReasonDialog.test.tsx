import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { OverrideReasonDialog } from '../../components/super-admin/feature-flags/OverrideReasonDialog';

afterEach(() => cleanup());

function renderDialog(over: Partial<Parameters<typeof OverrideReasonDialog>[0]> = {}) {
  const onSubmit = over.onSubmit ?? vi.fn();
  const onClose = over.onClose ?? vi.fn();
  render(
    <OverrideReasonDialog
      title="Set My Flag → On"
      busy={over.busy}
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );
  return { onSubmit, onClose };
}

const saveBtn = () => screen.getByRole('button', { name: /save override/i }) as HTMLButtonElement;

describe('OverrideReasonDialog', () => {
  it('renders the title and focuses the reason field', () => {
    renderDialog();
    expect(screen.getByText('Set My Flag → On')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText(/reason \(required\)/i));
  });

  it('keeps Save disabled until a non-whitespace reason is entered', () => {
    renderDialog();
    expect(saveBtn().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: '   ' } });
    expect(saveBtn().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'real reason' } });
    expect(saveBtn().disabled).toBe(false);
  });

  it('submits the trimmed reason and the raw expiry value', () => {
    const { onSubmit } = renderDialog();
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: '  trimmed  ' } });
    fireEvent.change(screen.getByLabelText(/expires \(optional\)/i), { target: { value: '2027-01-01T09:30' } });
    fireEvent.click(saveBtn());
    expect(onSubmit).toHaveBeenCalledWith('trimmed', '2027-01-01T09:30');
  });

  it('submits an empty expiry string when none is set', () => {
    const { onSubmit } = renderDialog();
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'r' } });
    fireEvent.click(saveBtn());
    expect(onSubmit).toHaveBeenCalledWith('r', '');
  });

  it('disables Save while busy even with a reason', () => {
    renderDialog({ busy: true });
    fireEvent.change(screen.getByLabelText(/reason \(required\)/i), { target: { value: 'r' } });
    expect(saveBtn().disabled).toBe(true);
  });

  it('Cancel and Close both call onClose without submitting', () => {
    const { onSubmit, onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
