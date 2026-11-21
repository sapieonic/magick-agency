import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { useState } from 'react';
import type { AgencyFactField } from '@magick-agency/contracts/agency';
import { CustomerFactsEditor } from '../../pages/campaigns/agency/CustomerFactsEditor';
import { useConfigFieldErrors } from '../../pages/campaigns/agency/configFieldErrors';
import { factsErrors, type FactsForm } from '../../utils/agency/stationSettings';

/**
 * Campaign Settings › What agents see › the customer card (AS19): the name and line-under-name
 * selects, up to 4 facts (added from a picker with samples, renamed with a counter, keyed once,
 * one highlighted, reordered by drag, buttons or arrow keys with an announcement), the
 * missing-column state, "Put it back", and how each column is read. Column names match ignoring
 * case, and every control and error has its own id whatever the column names.
 */

const fact = (column: string, key: string, label = column, extra: Partial<AgencyFactField> = {}): AgencyFactField => ({ column, label, key, ...extra });
const card = (over: Partial<FactsForm> = {}): FactsForm => ({ name: '', place: '', list: [], types: {}, ...over });

function Harness({
  initial,
  columns,
  uploaded,
  hidden = [],
  serverErrors = {},
  onChange,
  readOnly = false,
  samples = [],
  removedInUse = [],
  onPutBack,
  phoneDisplay,
}: {
  initial: FactsForm;
  columns: string[];
  uploaded?: string[];
  hidden?: string[];
  serverErrors?: Record<string, string>;
  onChange?: (next: FactsForm) => void;
  readOnly?: boolean;
  samples?: Array<Record<string, unknown>>;
  removedInUse?: AgencyFactField[];
  onPutBack?: (key: string) => void;
  phoneDisplay?: 'full' | 'masked';
}) {
  const [value, setValue] = useState(initial);
  // As the page does: the card's own findings, then the server's.
  const view = useConfigFieldErrors({ ...serverErrors, ...factsErrors(value, { hidden, uploaded: uploaded ?? [] }) });
  return (
    <CustomerFactsEditor
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      columns={columns}
      uploaded={uploaded}
      hidden={hidden}
      loading={false}
      phoneDisplay={phoneDisplay}
      errors={view}
      readOnly={readOnly}
      samples={samples}
      removedInUse={removedInUse}
      onPutBack={onPutBack}
    />
  );
}

afterEach(() => cleanup());

const rows = () => within(screen.getByTestId('fact-rows')).queryAllByRole('listitem');
const labels = () => rows().map((row) => (within(row).getByRole('textbox') as HTMLInputElement).value);
const keys = () => rows().map((row) => row.querySelector('code')!.textContent);

describe('the name and the line under it', () => {
  it('shows a column stored in another case as the list’s column, chosen, never “not in the list”', () => {
    render(<Harness initial={card({ place: 'city' })} columns={['Name', 'City']} />);
    const place = screen.getByTestId('fact-role-place') as HTMLSelectElement;
    expect(place.value).toBe('City');
    // With none chosen, the server would guess City: the empty choice says so.
    expect(within(place).getAllByRole('option').map((o) => o.textContent)).toEqual(['Guess from the column names (City)', 'Name', 'City']);
    cleanup();
    render(<Harness initial={card()} columns={['Name', 'Loan']} />);
    expect(within(screen.getByTestId('fact-role-place')).getAllByRole('option')[0]!.textContent).toBe('None');
  });

  it('names the column the server would guess when none is chosen', () => {
    render(<Harness initial={card()} columns={['Customer Name', 'Town', 'Loan']} />);
    expect(within(screen.getByTestId('fact-role-name')).getAllByRole('option')[0]!.textContent).toBe('Guess from the column names (Customer Name)');
    expect(within(screen.getByTestId('fact-role-place')).getAllByRole('option')[0]!.textContent).toBe('Guess from the column names (Town)');
  });
});

describe('adding facts', () => {
  it('offers the columns not hidden and not used, each with a sample, and adds one with its default name and key', () => {
    const onChange = vi.fn();
    render(
      <Harness
        initial={card({ list: [fact('Loan ID', 'loan_id')], types: { 'Loan Amount': 'money' } })}
        columns={['Name', 'City', 'Loan ID', 'Loan Amount', 'PAN', 'Outstanding principal amount']}
        hidden={['pan']}
        samples={[{ Name: 'Lakshmi', 'Loan Amount': '', City: 'Pune' }, { 'Loan Amount': '125000' }]}
        onChange={onChange}
      />,
    );
    const add = screen.getByTestId('fact-add');
    expect(add.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(add);
    expect(add.getAttribute('aria-expanded')).toBe('true');
    const picker = screen.getByTestId('fact-picker');
    // The guessed name and line under it, the fact already on the card, and the hidden column are not offered.
    expect(within(picker).getAllByRole('button').map((b) => b.querySelector('b')!.textContent)).toEqual(['Loan Amount', 'Outstanding principal amount']);
    // The first non-blank sample, read by the column's type.
    expect(within(screen.getByTestId('fact-pick-Loan Amount')).getByText('e.g. ₹1,25,000')).toBeTruthy();
    // The first choice takes focus.
    expect(document.activeElement).toBe(screen.getByTestId('fact-pick-Loan Amount'));

    fireEvent.click(screen.getByTestId('fact-pick-Outstanding principal amount'));
    expect(labels()).toEqual(['Loan ID', 'Outstanding prin']);
    expect(keys()).toEqual(['{loan_id}', '{outstanding_principal_amount}']);
    expect(screen.queryByTestId('fact-picker')).toBeNull();
    // Focus goes to the new fact's name, to rename it.
    expect(document.activeElement).toBe(screen.getByTestId('fact-label-1'));
    expect(screen.getByTestId('facts-announce').textContent).toBe('Outstanding prin added to the card.');
    expect(screen.getByTestId('facts-count').textContent).toBe('2 of 4 used');
  });

  it('offers only the latest upload’s columns, never one only the stored settings name (AS19 R12)', () => {
    render(
      <Harness
        initial={card({ list: [fact('Loan ID', 'loan_id')] })}
        columns={['Name', 'Loan ID', 'Branch', 'Old Branch']}
        uploaded={['Name', 'Loan ID', 'Branch']}
      />,
    );
    fireEvent.click(screen.getByTestId('fact-add'));
    const picker = screen.getByTestId('fact-picker');
    expect(within(picker).getAllByRole('button').map((b) => b.querySelector('b')!.textContent)).toEqual(['Branch']);
  });

  it('with no upload, offers no column and says to upload one', () => {
    render(<Harness initial={card({ list: [fact('Loan ID', 'loan_id')] })} columns={['Loan ID', 'Branch']} uploaded={[]} />);
    fireEvent.click(screen.getByTestId('fact-add'));
    expect(within(screen.getByTestId('fact-picker')).queryAllByRole('button')).toEqual([]);
    expect(screen.getByTestId('fact-picker-none').textContent).toBe('Upload a customer list to this campaign first.');
  });

  it('shows a phone fact’s sample only as agents see it, never its digits beside it (AS19 R12)', () => {
    render(
      <Harness
        initial={card({ list: [fact('Mobile', 'mobile'), fact('Due', 'due')], types: { Mobile: 'phone', Due: 'money' } })}
        columns={['Mobile', 'Due']}
        samples={[{ Mobile: '+91 98765 43321', Due: '125000' }]}
        phoneDisplay="masked"
      />,
    );
    const phone = screen.getByTestId('fact-sample-0').textContent!;
    expect(phone.replace(/\D/g, '')).not.toContain('9876543321');
    expect(phone).not.toContain('→');
    // Other types still show what was uploaded and how it reads.
    expect(screen.getByTestId('fact-sample-1').textContent).toBe(' · 125000 → ₹1,25,000');
  });

  it('stops at 4: a fifth add says why instead', () => {
    render(<Harness initial={card({ list: ['A', 'B', 'C', 'D'].map((c) => fact(c, c.toLowerCase())) })} columns={['A', 'B', 'C', 'D', 'E']} />);
    expect(screen.getByTestId('facts-count').textContent).toBe('4 of 4 used');
    fireEvent.click(screen.getByTestId('fact-add'));
    expect(screen.queryByTestId('fact-picker')).toBeNull();
    expect(screen.getByTestId('facts-limit').textContent).toBe('You can show 4 facts at most. Remove one to add another.');
    expect(screen.getByTestId('facts-limit').getAttribute('role')).toBe('alert');
    // Room again: the message goes, and the picker opens.
    fireEvent.click(screen.getByTestId('fact-remove-3'));
    expect(screen.queryByTestId('facts-limit')).toBeNull();
    fireEvent.click(screen.getByTestId('fact-add'));
    expect(screen.getByTestId('fact-picker')).toBeTruthy();
  });
});

describe('each fact', () => {
  it('counts its name against 16 letters, says a name too long, empty or repeated, and keeps its key on a rename', () => {
    render(<Harness initial={card({ list: [fact('Loan ID', 'loan_id'), fact('Due', 'due')] })} columns={['Loan ID', 'Due']} />);
    const label = screen.getByTestId('fact-label-0') as HTMLInputElement;
    expect(screen.getByTestId('fact-label-count-0').textContent).toContain('7/16');
    fireEvent.change(label, { target: { value: 'Loan account number' } });
    expect(screen.getByTestId('fact-label-count-0').textContent).toContain('19/16');
    expect(screen.getByTestId('fact-label-count-0').hasAttribute('data-over')).toBe(true);
    const tooLong = screen.getByText('A fact’s name can be 16 letters at most.');
    expect(label.getAttribute('aria-invalid')).toBe('true');
    expect(label.getAttribute('aria-describedby')).toContain(tooLong.closest('p')!.id);
    fireEvent.change(label, { target: { value: '' } });
    expect(screen.getByText('Give this fact a name.')).toBeTruthy();
    fireEvent.change(label, { target: { value: 'DUE' } });
    // Said on the second of the two.
    expect(screen.getByTestId('fact-row-1').textContent).toContain('Two facts cannot have the same name.');
    fireEvent.change(label, { target: { value: 'Account' } });
    expect(keys()).toEqual(['{loan_id}', '{due}']);
    expect(screen.queryByText(/at most|Give this fact|same name/)).toBeNull();
  });

  it('highlights one at most: it moves first, and turning on another turns it off', () => {
    render(<Harness initial={card({ list: [fact('A', 'a'), fact('B', 'b'), fact('C', 'c')] })} columns={['A', 'B', 'C']} />);
    fireEvent.click(screen.getByTestId('fact-highlight-1'));
    expect(keys()).toEqual(['{b}', '{a}', '{c}']);
    expect(screen.getByTestId('fact-highlight-0').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('fact-row-0').textContent).toContain('Highlighted, always first');
    // The highlighted fact cannot be moved, and nothing moves above it.
    expect((screen.getByTestId('fact-down-0') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('fact-up-1') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('fact-highlight-2'));
    expect(keys()).toEqual(['{c}', '{b}', '{a}']);
    expect(rows().map((r) => within(r).getByTestId(/fact-highlight-/).getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    fireEvent.click(screen.getByTestId('fact-highlight-0'));
    expect(rows().every((r) => within(r).getByTestId(/fact-highlight-/).getAttribute('aria-pressed') === 'false')).toBe(true);
  });

  it('moves by the arrow keys on its grip, keeps focus there, and says where it went', () => {
    render(<Harness initial={card({ list: [fact('A', 'a', 'Amount'), fact('B', 'b', 'Branch'), fact('C', 'c', 'City')] })} columns={['A', 'B', 'C']} />);
    const grip = screen.getByTestId('fact-grip-0');
    expect(grip.getAttribute('aria-label')).toBe('Move Amount. Position 1 of 3. Use the arrow keys.');
    grip.focus();
    fireEvent.keyDown(grip, { key: 'ArrowDown' });
    expect(labels()).toEqual(['Branch', 'Amount', 'City']);
    expect(screen.getByTestId('facts-announce').textContent).toBe('Amount moved to position 2 of 3.');
    expect(screen.getByTestId('facts-announce').getAttribute('aria-live')).toBe('polite');
    const moved = screen.getByTestId('fact-grip-1');
    expect(document.activeElement).toBe(moved);
    expect(moved.getAttribute('aria-label')).toBe('Move Amount. Position 2 of 3. Use the arrow keys.');
    fireEvent.keyDown(moved, { key: 'ArrowDown' });
    expect(labels()).toEqual(['Branch', 'City', 'Amount']);
    // At the end: nothing moves.
    fireEvent.keyDown(screen.getByTestId('fact-grip-2'), { key: 'ArrowDown' });
    expect(labels()).toEqual(['Branch', 'City', 'Amount']);
    fireEvent.keyDown(screen.getByTestId('fact-grip-2'), { key: 'ArrowUp' });
    expect(labels()).toEqual(['Branch', 'Amount', 'City']);
  });

  it('moves by its buttons and by drag', () => {
    render(<Harness initial={card({ list: [fact('A', 'a'), fact('B', 'b'), fact('C', 'c')] })} columns={['A', 'B', 'C']} />);
    fireEvent.click(screen.getByTestId('fact-up-2'));
    expect(keys()).toEqual(['{a}', '{c}', '{b}']);
    fireEvent.dragStart(screen.getByTestId('fact-grip-0'), { dataTransfer: { setData: () => {}, effectAllowed: '' } });
    fireEvent.dragOver(screen.getByTestId('fact-row-2'));
    fireEvent.drop(screen.getByTestId('fact-row-2'));
    expect(keys()).toEqual(['{c}', '{b}', '{a}']);
  });

  it('says a column the latest upload does not have, and offers another in its place', () => {
    const onChange = vi.fn();
    render(
      <Harness
        initial={card({ list: [fact('Branch', 'branch', 'Branch office')] })}
        columns={['Name', 'Loan ID', 'Branch']}
        uploaded={['Name', 'Loan ID']}
        onChange={onChange}
      />,
    );
    const replace = screen.getByTestId('fact-column-0') as HTMLSelectElement;
    const message = screen.getByText('This column is not in the latest upload. Choose another or remove the fact.');
    expect(replace.getAttribute('aria-describedby')).toBe(message.closest('p')!.id);
    expect(within(replace).getAllByRole('option').map((o) => o.textContent)).toEqual(['Branch: choose another column', 'Loan ID']);
    fireEvent.change(replace, { target: { value: 'Loan ID' } });
    // The name and key stay; the column changes.
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ list: [fact('Loan ID', 'branch', 'Branch office')] }));
    expect(screen.queryByText(/not in the latest upload/)).toBeNull();
  });

  it('offers a removed fact the script uses back', () => {
    const onPutBack = vi.fn();
    render(<Harness initial={card()} columns={['Due']} removedInUse={[fact('Due', 'due_date', 'Due date')]} onPutBack={onPutBack} />);
    const note = screen.getByTestId('fact-put-back-due_date');
    expect(note.textContent).toContain('The script uses {due_date}. Take it out of the script first, or keep the fact.');
    fireEvent.click(within(note).getByRole('button', { name: 'Put ‘Due date’ back' }));
    expect(onPutBack).toHaveBeenCalledWith('due_date');
  });
});

describe('how each column is read', () => {
  it('offers all six types, on each fact and in the list, as one setting per column', () => {
    const onChange = vi.fn();
    render(<Harness initial={card({ list: [fact('Paid On', 'paid_on')], types: { 'paid on': 'date' } })} columns={['Paid On', 'Mobile']} onChange={onChange} />);
    const rowType = screen.getByTestId('fact-row-type-0') as HTMLSelectElement;
    expect(within(rowType).getAllByRole('option').map((o) => o.textContent)).toEqual(['Text', 'Money', 'Date', 'Number', 'Phone number', 'Yes / No']);
    expect(rowType.value).toBe('date');
    fireEvent.change(rowType, { target: { value: 'number' } });
    // One key per column, the stored spelling kept.
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ types: { 'paid on': 'number' } }));
    expect((screen.getByTestId('fact-type-Paid On') as HTMLSelectElement).value).toBe('number');
    fireEvent.change(screen.getByTestId('fact-type-Mobile'), { target: { value: 'phone' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ types: { 'paid on': 'number', Mobile: 'phone' } }));
  });

  it('gives every column’s select and error an id of its own', () => {
    render(
      <Harness
        initial={card()}
        columns={['a b', 'a-b', 'a.b']}
        serverErrors={{ 'context_display.types.a b': 'First.', 'context_display.types.a-b': 'Second.' }}
      />,
    );
    const selects = ['a b', 'a-b', 'a.b'].map((c) => screen.getByTestId(`fact-type-${c}`));
    expect(new Set(selects.map((s) => s.id)).size).toBe(3);
    for (const select of selects) expect(screen.getByLabelText(select.closest('li')!.querySelector('label')!.textContent!)).toBe(select);
    const first = screen.getByText('First.').closest('[id]')!.id;
    const second = screen.getByText('Second.').closest('[id]')!.id;
    expect(first).not.toBe(second);
    expect(selects[0]!.getAttribute('aria-describedby')).toBe(first);
    expect(selects[1]!.getAttribute('aria-describedby')).toBe(second);
    // A type refused by the server opens the list it is in.
    expect((selects[0]!.closest('details') as HTMLDetailsElement).open).toBe(true);
  });
});

describe('reading only', () => {
  it('never says it is still reading to a reader who cannot edit', () => {
    render(<Harness initial={card()} columns={[]} readOnly />);
    expect(screen.getByTestId('customer-facts-empty').textContent).toBe('No customer facts are set for this campaign.');
  });

  it('shows the facts without the controls that change them', () => {
    render(<Harness initial={card({ list: [fact('Loan ID', 'loan_id')] })} columns={['Loan ID']} readOnly />);
    expect((screen.getByTestId('fact-label-0') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId('fact-add')).toBeNull();
    expect(screen.queryByTestId('fact-grip-0')).toBeNull();
  });
});
