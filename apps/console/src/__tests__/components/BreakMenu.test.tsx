import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { BreakMenu, BREAK_UNCONFIGURED_COPY, BREAK_REJECTED_COPY } from '../../components/agency/BreakMenu';
import type { AgencyBreakReason } from '../../types/agency';

/**
 * `BreakMenu` (§A.13.4, §A.13.8, §A.13.9).
 *
 * The two properties most worth holding here are both *negative*: the menu binds
 * no number keys, and it never renders an empty list. Neither is visible in a
 * screenshot, and both are the kind of thing a later "improvement" adds back.
 */

/**
 * Core's six built-ins (`DEFAULT_BREAK_REASONS`, `break-manager.ts` @ `41e102c`),
 * which is what bootstrap actually advertises when a campaign configures none.
 * Note `is_paid` is absent from every one — deliberately, per core: it is a
 * payroll question no default can answer, and the console does not branch on it.
 */
const BUILT_INS: AgencyBreakReason[] = [
  { code: 'break', label: 'Break' },
  { code: 'lunch', label: 'Lunch' },
  { code: 'meeting', label: 'Meeting' },
  { code: 'training', label: 'Training' },
  { code: 'technical_issue', label: 'Technical issue' },
  { code: 'admin', label: 'Admin time' },
];

afterEach(cleanup);

function setup(props: Partial<Parameters<typeof BreakMenu>[0]> = {}) {
  const onSelect = vi.fn();
  const utils = render(<BreakMenu reasons={BUILT_INS} onSelect={onSelect} {...props} />);
  return { onSelect, ...utils };
}

const trigger = () => screen.getByRole('button', { name: /^Break/ });
const items = () => screen.queryAllByRole('menuitem');
const openMenu = () => fireEvent.click(trigger());

describe('what bootstrap advertises is what renders', () => {
  it('offers all six built-in reasons core serves for an unconfigured campaign', () => {
    // §A.13.4 still says the empty catalog is "today's actual behaviour" and that
    // every break request is rejected. That paragraph is STALE — core's
    // `resolveBreakReasons` serves these six when the column is `'[]'`. Built to
    // the code, not the prose.
    setup();
    openMenu();
    expect(items().map((i) => i.textContent)).toEqual([
      'Break',
      'Lunch',
      'Meeting',
      'Training',
      'Technical issue',
      'Admin time',
    ]);
  });

  it('sends the code, never the label', () => {
    const { onSelect } = setup();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Technical issue' }));
    expect(onSelect).toHaveBeenCalledWith('technical_issue');
  });

  it('preserves the server order and does not sort', () => {
    const reasons = [
      { code: 'zulu', label: 'Zulu' },
      { code: 'alpha', label: 'Alpha' },
    ];
    setup({ reasons });
    openMenu();
    expect(items().map((i) => i.textContent)).toEqual(['Zulu', 'Alpha']);
  });
});

describe('the empty catalog — a defensive path, not the expected one', () => {
  it('never renders an empty menu; it disables Break with a stated reason', () => {
    setup({ reasons: [] });
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(BREAK_UNCONFIGURED_COPY)).toBeTruthy();
  });

  it('cannot be opened, so no guessed code can be sent', () => {
    const { onSelect } = setup({ reasons: [] });
    openMenu();
    fireEvent.keyDown(trigger(), { key: 'Enter' });
    expect(items()).toHaveLength(0);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('states an external block instead, when there is one', () => {
    setup({ blockedReason: 'Your campaign has stopped' });
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Your campaign has stopped')).toBeTruthy();
    // The external reason wins — "no break reasons configured" would be a lie.
    expect(screen.queryByText(BREAK_UNCONFIGURED_COPY)).toBeNull();
  });
});

describe('number keys are the disposition pad’s alone', () => {
  it('does nothing on 1–9 with the menu open', () => {
    // §A.13.4: reassigning number keys by context destroys muscle memory. An
    // agent who has learned "3 = voicemail" must not find `3` means "Meeting"
    // whenever a popover happens to be open.
    const { onSelect } = setup();
    openMenu();
    const before = document.activeElement;

    for (const key of ['1', '2', '3', '9']) {
      fireEvent.keyDown(screen.getByRole('menu'), { key });
    }

    expect(onSelect).not.toHaveBeenCalled();
    // Not merely "did not submit" — the highlight must not have MOVED either,
    // which is what a typeahead falling through to digits would do.
    expect(document.activeElement).toBe(before);
    expect(items()[0]?.getAttribute('data-active')).toBe('true');
  });

  it('does not let a label beginning with a digit create a number binding', () => {
    const { onSelect } = setup({
      reasons: [
        { code: 'a', label: 'Alpha' },
        { code: 'first', label: '1st break' },
      ],
    });
    openMenu();
    fireEvent.keyDown(screen.getByRole('menu'), { key: '1' });
    expect(items()[0]?.getAttribute('data-active')).toBe('true');
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('keyboard navigation — arrows, typeahead, Enter', () => {
  it('moves the visible focus, not just an aria attribute', () => {
    // Criterion (d) is asserted on a VISIBLE focus ring, and the global
    // `:focus-visible` rule paints the focused element. `aria-activedescendant`
    // alone would leave the ring on the container and pass an aria-only test.
    setup();
    openMenu();
    expect(document.activeElement).toBe(items()[0]);

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items()[1]);
  });

  it('wraps in both directions', () => {
    setup();
    openMenu();
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items()[5]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items()[0]);
  });

  it('honours Home and End', () => {
    setup();
    openMenu();
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items()[5]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items()[0]);
  });

  it('cycles between two entries sharing a first letter', () => {
    // "Lunch" and "Leave early". A non-wrapping typeahead sticks on the second
    // and the key reads as broken.
    setup({
      reasons: [
        { code: 'break', label: 'Break' },
        { code: 'lunch', label: 'Lunch' },
        { code: 'leave', label: 'Leave early' },
      ],
    });
    openMenu();
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'l' });
    expect(document.activeElement).toBe(items()[1]);
    fireEvent.keyDown(menu, { key: 'l' });
    expect(document.activeElement).toBe(items()[2]);
    fireEvent.keyDown(menu, { key: 'l' });
    expect(document.activeElement).toBe(items()[1]);
  });

  it('ignores typeahead when a modifier is held', () => {
    // Otherwise Cmd+L (the browser's address bar) would silently move the agent's
    // selection on the way past.
    setup();
    openMenu();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'l', metaKey: true });
    expect(document.activeElement).toBe(items()[0]);
  });

  it('selects the active item on Enter', () => {
    const { onSelect } = setup();
    openMenu();
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('lunch');
  });

  it('opens from the trigger on ArrowDown, landing on the first item', () => {
    setup();
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    expect(items()).toHaveLength(6);
    expect(document.activeElement).toBe(items()[0]);
  });

  it('traps Tab inside the popover', () => {
    // §A.13.4: focus is trapped while open. Tabbing out would leave an open
    // popover behind with focus somewhere else on the screen.
    setup();
    openMenu();
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'Tab' });
    expect(document.activeElement).toBe(items()[1]);
    fireEvent.keyDown(menu, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(items()[0]);
  });
});

describe('focus returns to the control that opened the surface', () => {
  it('on Esc', () => {
    // A popover that closes and drops focus to `<body>` strands a keyboard agent
    // at the top of the document — on this screen, past the entire contact panel.
    setup();
    openMenu();
    expect(document.activeElement).not.toBe(trigger());

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    expect(items()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger());
  });

  it('on selection', () => {
    setup();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Lunch' }));
    expect(items()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger());
  });

  it('does not fire the select handler on Esc', () => {
    const { onSelect } = setup();
    openMenu();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('the confirmation rides the focused control, not a third live region', () => {
  it('renames Break to "Break queued — Lunch" when a break is pending', () => {
    // §A.11 caps this screen at exactly two live regions and the pill is neither.
    // A screen reader announces the focused control's new name, so the
    // confirmation is delivered by the focus that is already there.
    const { rerender } = setup();
    rerender(<BreakMenu reasons={BUILT_INS} queuedReasonLabel="Lunch" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Break queued — Lunch' })).toBeTruthy();
  });

  it('reads as plain "Break" when nothing is queued', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Break' })).toBeTruthy();
  });
});

describe('unknown_break_reason — one round trip, not an apology', () => {
  it('re-opens the menu on the codes the campaign will accept', () => {
    const { rerender } = setup();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Lunch' }));
    expect(items()).toHaveLength(0);

    // The parent re-synced from `allowed_codes` and passed the rejection down.
    rerender(
      <BreakMenu
        reasons={[
          { code: 'break', label: 'Break' },
          { code: 'floor_walk', label: 'Floor walk' },
        ]}
        rejection={BREAK_REJECTED_COPY}
        onSelect={vi.fn()}
      />,
    );

    expect(items().map((i) => i.textContent)).toEqual(['Break', 'Floor walk']);
    expect(screen.getByText(BREAK_REJECTED_COPY)).toBeTruthy();
    expect(document.activeElement).toBe(items()[0]);
  });

  it('never says "contact support" — the copy names the recovery', () => {
    expect(BREAK_REJECTED_COPY.toLowerCase()).not.toContain('support');
    expect(BREAK_REJECTED_COPY.toLowerCase()).not.toContain('request id');
    expect(BREAK_REJECTED_COPY).toContain('Pick another');
  });
});

describe('busy is aria-disabled, never disabled — mechanism (b)', () => {
  it('leaves the trigger focusable while a request is in flight', () => {
    // The browser blurs a focused element on disable and re-enabling does NOT
    // restore focus, so `disabled={busy}` drops a keyboard agent to `<body>` for
    // the whole length of the request. Structural assertion: happy-dom does not
    // blur on disable, so this cannot be demonstrated here — only pinned.
    setup({ busy: true });
    const button = trigger() as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
  });

  it('guards the handler instead', () => {
    const { onSelect } = setup({ busy: true });
    openMenu();
    expect(items()).toHaveLength(0);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('uses real disabled for a genuinely unavailable control, so Tab skips it', () => {
    // The other half of the distinction: §A.13.9's tab order requires inactive
    // controls to be `disabled` and skipped rather than reordered. That state
    // does not begin while the control holds focus, so it is safe.
    setup({ reasons: [] });
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
  });
});
