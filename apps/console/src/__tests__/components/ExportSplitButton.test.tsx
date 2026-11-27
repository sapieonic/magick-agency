import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ExportSplitButton, type ExportSplitButtonProps } from '../../components/agency/callLog/ExportSplitButton';

/**
 * The Call log's split Export CSV (`docs/call-log.md` §10): where focus goes around Export with
 * fields. The menu's keyboard behaviour and the page's use of it are
 * `AgencyCampaignAttemptsPage.test.tsx`'s.
 */

afterEach(cleanup);

function props(overrides: Partial<ExportSplitButtonProps> = {}): ExportSplitButtonProps {
  return { onExport: vi.fn(), onExportWithFields: vi.fn(), exporting: false, disabled: false, title: 'Export', ...overrides };
}

describe('ExportSplitButton: focus around Export with fields', () => {
  it('choosing the item puts focus on the arrow, so the dialog opens from it', () => {
    const p = props();
    render(<ExportSplitButton {...p} />);
    const arrow = screen.getByRole('button', { name: 'More export options' });
    fireEvent.click(arrow);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export with fields…' }));
    expect(p.onExportWithFields).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(arrow);
  });

  it('when the dialog closes, focus returns to the arrow, waiting until the arrow is enabled', () => {
    const { rerender } = render(<ExportSplitButton {...props({ withFieldsOpen: true, disabled: true, exporting: true })} />);
    const arrow = screen.getByRole('button', { name: 'More export options' });
    (document.activeElement as HTMLElement | null)?.blur();

    // Closed while the download is still settling: the arrow is disabled and cannot take focus.
    rerender(<ExportSplitButton {...props({ withFieldsOpen: false, disabled: true, exporting: true })} />);
    expect(document.activeElement).not.toBe(arrow);

    rerender(<ExportSplitButton {...props({ withFieldsOpen: false, disabled: false })} />);
    expect(document.activeElement).toBe(arrow);

    // Once: a later enable does not pull focus back.
    screen.getByRole('button', { name: 'Export CSV' }).focus();
    rerender(<ExportSplitButton {...props({ withFieldsOpen: false, disabled: true })} />);
    rerender(<ExportSplitButton {...props({ withFieldsOpen: false, disabled: false })} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Export CSV' }));
  });

  it('never takes focus when the dialog was not open', () => {
    const { rerender } = render(<ExportSplitButton {...props({ disabled: true })} />);
    rerender(<ExportSplitButton {...props({ disabled: false })} />);
    expect(document.activeElement).toBe(document.body);
  });
});
