import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { useState } from 'react';
import type { AgencyFactField } from '@magick-agency/contracts/agency';
import { CustomerFactsEditor, type ColumnsRead, type FactFocusRequest } from '../../pages/campaigns/agency/CustomerFactsEditor';
import { useConfigFieldErrors } from '../../pages/campaigns/agency/configFieldErrors';
import { NAME_PHONE_MESSAGE, factsErrors, type FactsForm, type RemovedFact } from '../../utils/agency/stationSettings';

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
  columnsRead,
  onRetryColumns,
  waitForColumns,
  focusRequest,
}: {
  initial: FactsForm;
  columns: string[];
  uploaded?: string[];
  hidden?: string[];
  serverErrors?: Record<string, string>;
  onChange?: (next: FactsForm) => void;
  readOnly?: boolean;
  samples?: Array<Record<string, unknown>>;
  removedInUse?: RemovedFact[];
  onPutBack?: (key: string) => void;
  phoneDisplay?: 'full' | 'masked';
  columnsRead?: ColumnsRead;
  onRetryColumns?: () => void;
  waitForColumns?: boolean;
  focusRequest?: FactFocusRequest | null;
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
      columnsRead={columnsRead}
      onRetryColumns={onRetryColumns}
      waitForColumns={waitForColumns}
      focusRequest={focusRequest}
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
    // The guess names what it would pick, briefly enough to fit (S9); "None" is its own choice (S2).
    expect(within(place).getAllByRole('option').map((o) => o.textContent)).toEqual(['Guess (City)', 'None', 'Name', 'City']);
    cleanup();
    render(<Harness initial={card()} columns={['Name', 'Loan']} />);
    const nothing = screen.getByTestId('fact-role-place') as HTMLSelectElement;
    expect(within(nothing).getAllByRole('option')[0]!.textContent).toBe('None');
    expect(within(nothing).getAllByRole('option')[nothing.selectedIndex]!.textContent).toBe('None');
  });

  it('names the column the domain’s guess would pick when none is chosen, never a fact’s (S1)', () => {
    render(<Harness initial={card({ list: [fact('Customer Name', 'cn')] })} columns={['Customer Name', 'Full Name', 'Town', 'Loan']} />);
    expect(within(screen.getByTestId('fact-role-name')).getAllByRole('option')[0]!.textContent).toBe('Guess (Full Name)');
    expect(within(screen.getByTestId('fact-role-place')).getAllByRole('option')[0]!.textContent).toBe('Guess (Town)');
  });

  it('sets the line under the name to none, and back to the guess (S2)', () => {
    const onChange = vi.fn();
    render(<Harness initial={card()} columns={['Name', 'City']} onChange={onChange} />);
    const place = screen.getByTestId('fact-role-place') as HTMLSelectElement;
    fireEvent.change(place, { target: { value: within(place).getByRole('option', { name: 'None' }).getAttribute('value') } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ place: null }));
    expect(within(place).getAllByRole('option')[place.selectedIndex]!.textContent).toBe('None');
    fireEvent.change(place, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ place: '' }));
  });

  it('never offers a column read as a phone number for the name or the line under it (S3(e))', () => {
    render(<Harness initial={card({ types: { Mobile: 'phone' } })} columns={['Name', 'Mobile']} />);
    for (const id of ['fact-role-name', 'fact-role-place']) {
      const option = within(screen.getByTestId(id)).getByRole('option', { name: 'Mobile (phone number)' }) as HTMLOptionElement;
      expect(option.disabled).toBe(true);
    }
    cleanup();
    // One chosen before it was read as a phone number: shown, with the server's words.
    render(<Harness initial={card({ name: 'Mobile', types: { Mobile: 'phone' } })} columns={['Name', 'Mobile']} />);
    const name = screen.getByTestId('fact-role-name') as HTMLSelectElement;
    expect(name.value).toBe('Mobile');
    expect(screen.getByText(NAME_PHONE_MESSAGE)).toBeTruthy();
    expect(name.getAttribute('aria-invalid')).toBe('true');
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
    expect(screen.getByTestId('fact-picker-none').textContent).toBe('This campaign has no customer list yet. Upload one first.');
  });

  it('says the columns are being read, or that the read failed with a way to try again, never “no upload” (S9)', () => {
    render(<Harness initial={card({ list: [fact('Loan ID', 'loan_id')] })} columns={['Loan ID']} uploaded={[]} columnsRead="loading" />);
    fireEvent.click(screen.getByTestId('fact-add'));
    expect(screen.getByTestId('fact-picker-columns').textContent).toBe('Loading the customer list’s columns…');
    expect(screen.queryByTestId('fact-picker-none')).toBeNull();
    cleanup();
    const retry = vi.fn();
    render(<Harness initial={card({ list: [fact('Loan ID', 'loan_id')] })} columns={['Loan ID']} uploaded={[]} columnsRead="failed" onRetryColumns={retry} />);
    fireEvent.click(screen.getByTestId('fact-add'));
    const failed = screen.getByTestId('fact-picker-columns');
    expect(failed.textContent).toContain('Could not read the customer list’s columns.');
    expect(failed.getAttribute('role')).toBe('alert');
    fireEvent.click(within(failed).getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shows a card on the old model only once the columns it is opened from are read (S9)', () => {
    const retry = vi.fn();
    const old = card({ list: [fact('Due', 'amount_due')] });
    render(<Harness initial={old} columns={['Due']} waitForColumns columnsRead="loading" />);
    expect(screen.getByTestId('customer-facts-columns').textContent).toBe('Loading the customer list’s columns…');
    expect(screen.queryByTestId('fact-rows')).toBeNull();
    cleanup();
    render(<Harness initial={old} columns={['Due']} waitForColumns columnsRead="failed" onRetryColumns={retry} />);
    expect(screen.queryByTestId('fact-rows')).toBeNull();
    fireEvent.click(screen.getByTestId('customer-facts-columns-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
    cleanup();
    render(<Harness initial={old} columns={['Due']} waitForColumns columnsRead="done" />);
    expect(screen.getByTestId('fact-rows')).toBeTruthy();
  });

  it('names a new fact unlike the others: a clash is cut to fit “ 2” (S9)', () => {
    render(<Harness initial={card({ list: [fact('Outstanding Balance (₹)', 'ob', 'Outstanding Bala')] })} columns={['Outstanding Balance (₹)', 'Outstanding Balance Today']} />);
    fireEvent.click(screen.getByTestId('fact-add'));
    fireEvent.click(screen.getByTestId('fact-pick-Outstanding Balance Today'));
    expect(labels()).toEqual(['Outstanding Bala', 'Outstanding Ba 2']);
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

  it('offers a removed fact the script uses back, under the one message that holds Save (S9)', () => {
    const onPutBack = vi.fn();
    const said = 'The script uses {due_date}. Take it out of the script first, or keep the fact.';
    render(
      <Harness
        initial={card()}
        columns={['Due']}
        removedInUse={[{ fact: fact('Due', 'due_date', 'Due date'), blocked: null }]}
        onPutBack={onPutBack}
        serverErrors={{ 'context_display.facts': said }}
      />,
    );
    // Said once, not again on the row.
    expect(screen.getAllByText(said)).toHaveLength(1);
    const note = screen.getByTestId('fact-put-back-due_date');
    expect(note.textContent).not.toContain('The script uses');
    fireEvent.click(within(note).getByRole('button', { name: 'Put ‘Due date’ back' }));
    expect(onPutBack).toHaveBeenCalledWith('due_date');
  });

  it('disables “Put it back” with the reason when it cannot go back (S9)', () => {
    render(
      <Harness
        initial={card()}
        columns={['Due']}
        removedInUse={[{ fact: fact('Due', 'due_date', 'Due date'), blocked: 'The card is full (4 of 4). Remove a fact first.' }]}
        onPutBack={vi.fn()}
      />,
    );
    const button = within(screen.getByTestId('fact-put-back-due_date')).getByRole('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const reason = screen.getByText('The card is full (4 of 4). Remove a fact first.');
    expect(button.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('focuses and announces a fact the page put on the card (S9)', () => {
    const list = [fact('Loan ID', 'loan_id'), fact('Due', 'due_date', 'Due date')];
    const { rerender } = render(<Harness initial={card({ list })} columns={['Loan ID', 'Due']} />);
    rerender(<Harness initial={card({ list })} columns={['Loan ID', 'Due']} focusRequest={{ key: 'due_date', part: 'grip', said: 'Due date put back on the card.' }} />);
    expect(document.activeElement).toBe(screen.getByTestId('fact-grip-1'));
    expect(screen.getByTestId('facts-announce').textContent).toBe('Due date put back on the card.');
    rerender(<Harness initial={card({ list })} columns={['Loan ID', 'Due']} focusRequest={{ key: 'loan_id', part: 'label', said: 'Loan ID added to the card.' }} />);
    expect(document.activeElement).toBe(screen.getByTestId('fact-label-0'));
    expect(screen.getByTestId('facts-announce').textContent).toBe('Loan ID added to the card.');
  });

  it('uses one money fact for Full and Half: its key becomes {amount_due}, focus stays on the choice (S9)', () => {
    const onChange = vi.fn();
    render(
      <Harness
        initial={card({ list: [fact('Loan Amount', 'amount_due', 'Loan'), fact('EMI', 'emi'), fact('Branch', 'branch')], types: { 'Loan Amount': 'money', EMI: 'money' } })}
        columns={['Loan Amount', 'EMI', 'Branch']}
        onChange={onChange}
      />,
    );
    // Offered on a money fact only.
    expect((screen.getByTestId('fact-amount-0') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('fact-amount-1') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByTestId('fact-amount-2')).toBeNull();
    fireEvent.click(screen.getByTestId('fact-amount-1'));
    expect(keys()).toEqual(['{loan_amount}', '{amount_due}', '{branch}']);
    expect((screen.getByTestId('fact-amount-0') as HTMLInputElement).checked).toBe(false);
    expect(document.activeElement).toBe(screen.getByTestId('fact-amount-1'));
    expect(screen.getByTestId('facts-announce').textContent).toBe('EMI is used for Full and Half.');
    // A fact holding the key keeps the choice to let it go, whatever its type now.
    fireEvent.change(screen.getByTestId('fact-row-type-1'), { target: { value: 'number' } });
    fireEvent.click(screen.getByTestId('fact-amount-1'));
    expect(keys()).toEqual(['{loan_amount}', '{emi}', '{branch}']);
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
