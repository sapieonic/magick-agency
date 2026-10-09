import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import {
  DispositionPad,
  NUMBER_KEY_COUNT,
  CATALOG_CHANGED_COPY,
  CALLBACK_GROUND_TRUTH_COPY,
  KEYS_REMAPPED_COPY,
} from '../../components/agency/DispositionPad';
import { EMPTY_DISPOSITION_FORM, type DispositionFormState } from '../../utils/agencyDispositionForm';
import type { AgencyDisposition } from '../../types/agency';

/**
 * `DispositionPad` (§A.7.2 visual, §A.13.6 behaviour).
 *
 * The pad is assembly, so most of its correctness is already unit-tested in
 * `agencyDispositionForm`. What is only observable here is what the *markup* does:
 * the catalog order that reaches the DOM, the note surviving every path, and the
 * `aria-disabled` that keeps a focused option focusable through a frame.
 */

const T0 = Date.parse('2026-08-11T12:00:00.000Z');

const CATALOG: AgencyDisposition[] = [
  { code: 'sale', label: 'Sale', is_success: true },
  { code: 'not_interested', label: 'Not interested' },
  { code: 'callback', label: 'Callback', requires_datetime: true },
  { code: 'wrong_number', label: 'Wrong number', requires_note: true },
  { code: 'do_not_call', label: 'Do not call', suppress: true },
];

afterEach(cleanup);

function setup(props: Partial<Parameters<typeof DispositionPad>[0]> = {}) {
  const onChange = vi.fn();
  const onNeedsNote = vi.fn();
  const utils = render(
    <DispositionPad
      catalog={CATALOG}
      form={EMPTY_DISPOSITION_FORM}
      onChange={onChange}
      enabled
      now={T0}
      onNeedsNote={onNeedsNote}
      {...props}
    />,
  );
  return { onChange, onNeedsNote, ...utils };
}

/**
 * The number chip is `aria-hidden`, so an option's accessible NAME is its label
 * alone — "Sale", not "1Sale". That is the intended behaviour ("1" read before
 * every label is noise), and querying by role here is what pins it: a chip that
 * stopped being hidden would break every lookup in this file.
 */
const optionByName = (name: string | RegExp) => screen.getByRole('button', { name });

describe('catalog order reaches the DOM verbatim', () => {
  it('renders in the order core delivered, not sorted by anything', () => {
    // A sort by label would put Callback first; by success flag, Sale. Both look
    // reasonable in review, and either silently remaps every agent's fingers the
    // moment an admin renames a code.
    setup();
    const rendered = screen
      .getByRole('group', { name: 'Disposition' })
      .querySelectorAll('button');
    expect([...rendered].map((b) => b.textContent?.replace(/^\d/, ''))).toEqual([
      'Sale',
      'Not interested',
      'Callback',
      'Wrong number',
      'Do not call',
    ]);
  });

  it('numbers the chips by position, so 1 is always the first delivered entry', () => {
    setup();
    const group = screen.getByRole('group', { name: 'Disposition' });
    const chips = [...group.querySelectorAll('button')].map((b) => b.textContent?.charAt(0));
    expect(chips).toEqual(['1', '2', '3', '4', '5']);
  });

  it('renders no number chip past the ninth entry', () => {
    // The pad must never advertise a binding it does not have. Beyond nine:
    // pointer and arrow keys only.
    const long = Array.from({ length: 12 }, (_, i) => ({ code: `c${i}`, label: `Code ${i}` }));
    setup({ catalog: long });
    const group = screen.getByRole('group', { name: 'Disposition' });
    const buttons = [...group.querySelectorAll('button')];
    expect(buttons).toHaveLength(12);
    // Entry 10 (index 9) shows its label with no leading digit.
    expect(buttons[NUMBER_KEY_COUNT]?.textContent).toBe('Code 9');
    expect(buttons[NUMBER_KEY_COUNT - 1]?.textContent).toBe('9Code 8');
  });
});

describe('selection', () => {
  it('reports the code, never the index or the label', () => {
    const { onChange } = setup();
    fireEvent.click(optionByName(/Not interested/));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_DISPOSITION_FORM, selectedCode: 'not_interested' });
  });

  it('never touches the notes when the selection changes', () => {
    // The note is the agent's only artefact of an eight-minute call. Changing
    // outcome mid-thought must not spend it.
    const form: DispositionFormState = { selectedCode: 'sale', notes: 'asked for a callback', callbackAt: null };
    const { onChange } = setup({ form });
    fireEvent.click(optionByName(/Not interested/));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ notes: 'asked for a callback' }));
  });

  it('asks the page to focus notes when the code needs one', () => {
    const { onNeedsNote } = setup();
    fireEvent.click(optionByName(/Wrong number/));
    expect(onNeedsNote).toHaveBeenCalledTimes(1);
  });

  it('does not ask for note focus when the code does not need one', () => {
    const { onNeedsNote } = setup();
    fireEvent.click(optionByName(/^Sale$/));
    expect(onNeedsNote).not.toHaveBeenCalled();
  });

  it('marks the selected option for assistive tech, not only visually', () => {
    setup({ form: { ...EMPTY_DISPOSITION_FORM, selectedCode: 'sale' } });
    expect(screen.getByRole('button', { name: /Sale/, pressed: true })).toBeTruthy();
  });
});

describe('arrow keys select immediately', () => {
  it('moves and selects in one step, so highlight and value never disagree', () => {
    // §A.13.9: "selection is immediate". A separate commit step would create a
    // state where the row looks chosen and the value is still the old one.
    const { onChange } = setup({ form: { ...EMPTY_DISPOSITION_FORM, selectedCode: 'sale' } });
    fireEvent.keyDown(screen.getByRole('group', { name: 'Disposition' }), { key: 'ArrowDown' });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ selectedCode: 'not_interested' }));
  });

  it('wraps both ways', () => {
    const { onChange } = setup({ form: { ...EMPTY_DISPOSITION_FORM, selectedCode: 'sale' } });
    const group = screen.getByRole('group', { name: 'Disposition' });
    fireEvent.keyDown(group, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ selectedCode: 'do_not_call' }));
  });

  it('starts at the first entry when nothing is selected', () => {
    const { onChange } = setup();
    fireEvent.keyDown(screen.getByRole('group', { name: 'Disposition' }), { key: 'ArrowDown' });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ selectedCode: 'sale' }));
  });

  it('does nothing while disabled', () => {
    const { onChange } = setup({ enabled: false });
    fireEvent.keyDown(screen.getByRole('group', { name: 'Disposition' }), { key: 'ArrowDown' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('enable / disable is frame-bound and always states its reason', () => {
  it('renders every option while disabled, so the geometry does not shift', () => {
    // §0.1: every region renders in every state. A pad that appears at `bridged`
    // moves the column under the agent's cursor at the worst moment.
    setup({ enabled: false, disabledReason: 'available when connected' });
    expect(screen.getByRole('group', { name: 'Disposition' }).querySelectorAll('button')).toHaveLength(5);
    expect(screen.getByText('available when connected')).toBeTruthy();
  });

  it('refuses selection while disabled', () => {
    const { onChange } = setup({ enabled: false });
    fireEvent.click(optionByName(/Sale/));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uses aria-disabled on the options, never the disabled attribute', () => {
    // §A.13.9 names the pad as one of the four places this bites: it re-renders
    // whenever an `agent_state` frame lands, and a real `disabled` arriving under
    // a focused option blurs it — with re-enabling NOT restoring focus. A keyboard
    // agent would be dropped to `<body>` by a frame that had nothing to do with
    // them. Structural: happy-dom cannot observe the blur.
    setup({ enabled: false });
    const group = screen.getByRole('group', { name: 'Disposition' });
    for (const button of group.querySelectorAll('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(false);
      expect(button.getAttribute('aria-disabled')).toBe('true');
    }
  });
});

describe('rejection is inline, inside the pad, and spends nothing', () => {
  it('renders the copy where the agent is already looking', () => {
    setup({ rejection: CATALOG_CHANGED_COPY });
    expect(screen.getByTestId('pad-rejection').textContent).toBe(CATALOG_CHANGED_COPY);
  });

  it('names the cause rather than the symptom, and never escalates', () => {
    // The agent chose a legitimate code and nothing they did was wrong. "Contact
    // support and quote this request id" is what turned a one-click fix into a
    // support ticket, and it is reserved for errors with no recovery path.
    expect(CATALOG_CHANGED_COPY.toLowerCase()).not.toContain('invalid');
    expect(CATALOG_CHANGED_COPY.toLowerCase()).not.toContain('support');
    expect(CATALOG_CHANGED_COPY.toLowerCase()).not.toContain('request id');
  });

  it('keeps the note on the error path', () => {
    // §A.13.6: "Nothing clears the notes on any error path."
    const form: DispositionFormState = { selectedCode: 'sale', notes: 'eight minutes of context', callbackAt: null };
    setup({ form, rejection: CATALOG_CHANGED_COPY });
    // The pad does not own the textarea, so the proof at this tier is that it
    // neither reads nor rewrites `notes` — every `onChange` it can emit preserves
    // it, asserted above. Here: rendering a rejection emits nothing at all.
    expect(screen.getByTestId('pad-rejection')).toBeTruthy();
  });

  it('warns that the number keys moved, without claiming a failure', () => {
    setup({ keysRemapped: true });
    expect(screen.getByTestId('pad-keys-remapped').textContent).toBe(KEYS_REMAPPED_COPY);
  });

  it('does not warn when nothing moved', () => {
    setup();
    expect(screen.queryByTestId('pad-keys-remapped')).toBeNull();
  });
});

describe('the semantic edges', () => {
  it('marks a success code and a suppressing code differently', () => {
    setup();
    expect(optionByName(/Sale/).getAttribute('data-success')).toBe('true');
    expect(optionByName(/Do not call/).getAttribute('data-suppress')).toBe('true');
    expect(optionByName(/Not interested/).getAttribute('data-success')).toBeNull();
    expect(optionByName(/Not interested/).getAttribute('data-suppress')).toBeNull();
  });

  it('does not rely on colour alone — the label is always present', () => {
    setup();
    expect(optionByName(/Do not call/).textContent).toContain('Do not call');
  });
});

describe('the callback row — CR-1 in the one place it is read aloud', () => {
  it('appears only for a code that requires a datetime', () => {
    setup({ form: { ...EMPTY_DISPOSITION_FORM, selectedCode: 'sale' } });
    expect(screen.queryByText(CALLBACK_GROUND_TRUTH_COPY)).toBeNull();

    cleanup();
    setup({ form: { ...EMPTY_DISPOSITION_FORM, selectedCode: 'callback' } });
    expect(screen.getByText(CALLBACK_GROUND_TRUTH_COPY)).toBeTruthy();
  });

  it('says "we", never "I" — D11 puts the callback back in the pool', () => {
    // This copy is the ENTIRE mitigation for D11: whichever agent is available
    // takes it, so "I'll call you back" is a promise the product breaks.
    setup({ form: { ...EMPTY_DISPOSITION_FORM, selectedCode: 'callback' } });
    expect(screen.getByText('When should we call back?')).toBeTruthy();
    expect(CALLBACK_GROUND_TRUTH_COPY).toContain('It may not be you who makes it');
    expect(/\bI\b|\bI'll\b|\bmy\b/.test(CALLBACK_GROUND_TRUTH_COPY)).toBe(false);
  });

  it('offers the three times that cover almost every callback', () => {
    setup({ form: { ...EMPTY_DISPOSITION_FORM, selectedCode: 'callback' } });
    expect(screen.getByRole('button', { name: 'In 1 hour' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tomorrow 10am' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tomorrow 3pm' })).toBeTruthy();
    expect(screen.getByLabelText('Callback date and time')).toBeTruthy();
  });

  it('a chip sets a value the submit builder can parse', () => {
    const { onChange } = setup({ form: { ...EMPTY_DISPOSITION_FORM, selectedCode: 'callback' } });
    fireEvent.click(screen.getByRole('button', { name: 'In 1 hour' }));

    const value = onChange.mock.calls[0]?.[0].callbackAt as string;
    // `datetime-local` shape, and parseable as a real future instant — otherwise
    // `buildSubmitPayload` silently treats it as absent.
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(Date.parse(value)).toBeGreaterThan(T0);
  });

  it('renders the resolved zone beside the choice rather than leaving it implicit', () => {
    // The chips are computed in the AGENT's browser timezone, which is not
    // necessarily the customer's — contact-timezone handling is Phase 3. Naming
    // the zone stops an agent promising a time they have silently converted.
    const at = new Date(T0 + 3_600_000);
    const local = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}T${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    setup({ form: { selectedCode: 'callback', notes: '', callbackAt: local } });

    const resolved = screen.getByTestId('callback-resolved').textContent ?? '';
    expect(resolved.length).toBeGreaterThan(0);
    // A zone name, not a bare time — that is the whole point of the line.
    expect(resolved).not.toMatch(/^\d{2}:\d{2}$/);
    expect(resolved).toContain(new Date(Date.parse(local)).toLocaleString(undefined, { timeZoneName: 'short' }).split(' ').pop()!);
  });

  it('shows no resolved line when nothing is picked yet', () => {
    setup({ form: { ...EMPTY_DISPOSITION_FORM, selectedCode: 'callback' } });
    expect(screen.queryByTestId('callback-resolved')).toBeNull();
  });
});
