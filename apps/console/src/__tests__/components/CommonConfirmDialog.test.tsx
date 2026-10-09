import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';

/**
 * The SHARED confirm dialog (`src/components/common/ConfirmDialog.tsx`), which
 * had no tests of its own while 51 call sites depended on it.
 *
 * `C3`. Adding a third button to a focus trap that wraps first ⇄ last silently
 * changed what one Shift+Tab from the default focus reaches. Focus opens on
 * Cancel, so the wrap-around target is whatever sits LAST in the footer — and
 * once mark-DNC's "Never call again (any campaign, forever)" was appended after
 * the confirm, that reflex landed on an irreversible workspace-wide action that
 * Enter then fires with no further confirmation.
 *
 * These pin the ordering, the wrap target, and the `aria-describedby` that
 * carries the escalation's weight to assistive tech — plus the two-button shape
 * every other caller uses, which must be untouched.
 */

afterEach(cleanup);

const ESCALATION = 'Never call again (any campaign, forever)';
const HINT = 'Only choose this if the customer said never to contact them again.';

function renderDialog(over: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = over.onConfirm ?? vi.fn();
  const onCancel = over.onCancel ?? vi.fn();
  const onSecondary = over.onSecondary ?? vi.fn();
  render(
    <ConfirmDialog
      open
      title="Stop calling this number?"
      message="+919820041772 won’t be called again by Renewals."
      confirmLabel="Don’t call in this campaign"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...over}
    />,
  );
  return { onConfirm, onCancel, onSecondary };
}

/** The escalation shape: both props supplied, which is what reveals the slot. */
function renderWithEscalation(over: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onSecondary = over.onSecondary ?? vi.fn();
  return {
    ...renderDialog({
      secondaryLabel: ESCALATION,
      secondaryHint: HINT,
      ...over,
      onSecondary,
    }),
    onSecondary,
  };
}

function footerButtons(): string[] {
  return Array.from(document.querySelectorAll('button')).map((b) => b.textContent ?? '');
}

describe('the shared ConfirmDialog — the two-button shape every other caller uses', () => {
  it('renders Cancel and Confirm only, with no escalation slot and no hint', () => {
    renderDialog();

    expect(footerButtons()).toEqual(['Cancel', 'Don’t call in this campaign']);
    expect(screen.queryByTestId('confirm-secondary-hint')).toBeNull();
  });

  it('omits the escalation when only one of the two props is supplied', () => {
    // `showSecondary = Boolean(secondaryLabel && onSecondary)` — a caller that
    // passes a label but no handler must not get a dead button in the trap.
    cleanup();
    renderDialog({ secondaryLabel: ESCALATION });
    expect(footerButtons()).toEqual(['Cancel', 'Don’t call in this campaign']);

    cleanup();
    renderDialog({ onSecondary: vi.fn() });
    expect(footerButtons()).toEqual(['Cancel', 'Don’t call in this campaign']);
  });

  it('still confirms, cancels, and closes on Escape', () => {
    const { onConfirm, onCancel } = renderDialog();

    fireEvent.click(screen.getByText('Don’t call in this campaign'));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});

describe('the shared ConfirmDialog — where the irreversible escalation sits', () => {
  it('puts the escalation BETWEEN Cancel and the confirm, never last', () => {
    renderWithEscalation();

    // Order is a safety property here, not a layout preference: the trap wraps
    // to the last element, so the last element must not be the escalation.
    expect(footerButtons()).toEqual([
      'Cancel',
      ESCALATION,
      'Don’t call in this campaign',
    ]);
  });

  it('opens focus on Cancel', async () => {
    renderWithEscalation();

    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Cancel');
    });
  });

  it('wraps Shift+Tab from the default focus onto the CAMPAIGN-SCOPED confirm', async () => {
    // The defect, stated as a test: this reflex used to land on the permanent
    // workspace-wide action, where Enter fires it natively.
    renderWithEscalation();
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'));

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });

    expect(document.activeElement?.textContent).toBe('Don’t call in this campaign');
    expect(document.activeElement?.textContent).not.toBe(ESCALATION);
  });

  it('wraps Tab from the last control back onto Cancel', async () => {
    renderWithEscalation();
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'));

    // Forward from the confirm (last) must return to Cancel, not overshoot into
    // the escalation.
    screen.getByText('Don’t call in this campaign').focus();
    fireEvent.keyDown(document, { key: 'Tab' });

    expect(document.activeElement?.textContent).toBe('Cancel');
  });

  it('fires the escalation only from the escalation button', () => {
    const { onConfirm, onSecondary } = renderWithEscalation();

    fireEvent.click(screen.getByText('Don’t call in this campaign'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onSecondary).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(ESCALATION));
    expect(onSecondary).toHaveBeenCalledTimes(1);
  });

  it('honours secondaryDisabled without disabling the default action', () => {
    renderWithEscalation({ secondaryDisabled: true });

    expect((screen.getByText(ESCALATION) as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByText('Don’t call in this campaign') as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe('the shared ConfirmDialog — the escalation announces its own weight', () => {
  it('points the escalation button at its hint with aria-describedby', () => {
    renderWithEscalation();

    const hint = screen.getByTestId('confirm-secondary-hint');
    const button = screen.getByText(ESCALATION);

    // Without this the "different and permanent" signal was colour and a border
    // — nothing at all to a screen reader.
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(hint.getAttribute('id')).toBe(describedBy);
    expect(hint.textContent).toBe(HINT);
  });

  it('does not point at a hint that is not there', () => {
    // A dangling `aria-describedby` is worse than none: it resolves to nothing
    // and the reader announces the button bare anyway.
    renderDialog({ secondaryLabel: ESCALATION, onSecondary: vi.fn() });

    expect(screen.queryByTestId('confirm-secondary-hint')).toBeNull();
    expect(screen.getByText(ESCALATION).getAttribute('aria-describedby')).toBeNull();
  });

  it('leaves the ordinary confirm undescribed', () => {
    renderWithEscalation();

    expect(
      screen.getByText('Don’t call in this campaign').getAttribute('aria-describedby'),
    ).toBeNull();
  });
});
