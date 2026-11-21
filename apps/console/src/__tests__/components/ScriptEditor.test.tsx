import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { useState } from 'react';
import { ScriptEditor } from '../../pages/campaigns/agency/ScriptEditor';
import { useConfigFieldErrors } from '../../pages/campaigns/agency/configFieldErrors';
import { cardKeys, scriptErrors, type FactsForm, type RemovedFact, type ScriptForm } from '../../utils/agency/stationSettings';

/**
 * Campaign Settings › Script (AS19): this campaign's keys tinted in the text, the `{` list (filter,
 * arrows, Enter, Tab, Esc), the chips at the caret, a `{word}` the card has no fact for underlined
 * with its fixes, and "As the agent reads it" filled from a sample customer, an empty value as
 * "<name> not given".
 */

const FACTS: FactsForm = {
  name: '',
  place: '',
  list: [
    { column: 'Loan Amount', label: 'Amount due', key: 'amount_due', highlight: true },
    { column: 'Loan ID', label: 'Loan ID', key: 'loan_id' },
  ],
  types: { 'Loan Amount': 'money' },
};

function Harness({
  initial,
  onAddFact,
  samples = [],
  onChange,
  uploaded,
  facts = FACTS,
  legacy,
  removedInUse,
  onPutBack,
}: {
  uploaded?: string[];
  initial: ScriptForm;
  onAddFact?: (column: string, token: string) => void;
  samples?: Array<Record<string, unknown>>;
  onChange?: (next: ScriptForm) => void;
  facts?: FactsForm;
  legacy?: boolean;
  removedInUse?: RemovedFact[];
  onPutBack?: (key: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const keys = cardKeys(facts);
  const view = useConfigFieldErrors(scriptErrors(value, keys), new Set(Object.keys(scriptErrors(value, keys))));
  return (
    <ScriptEditor
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      errors={view}
      facts={facts}
      offered={keys}
      allowed={keys}
      columns={['Name', 'City', 'Loan Amount', 'Loan ID', 'Branch']}
      uploaded={uploaded}
      samples={samples}
      campaignName="Diwali collections"
      onAddFact={onAddFact}
      legacy={legacy}
      removedInUse={removedInUse}
      onPutBack={onPutBack}
    />
  );
}

afterEach(() => cleanup());

const opening = () => screen.getByTestId('script-opening') as HTMLTextAreaElement;
const type = (field: HTMLTextAreaElement, text: string) => {
  field.focus();
  fireEvent.change(field, { target: { value: text } });
};
const options = () => within(screen.getByTestId('script-key-list')).getAllByRole('option');

describe('the keys in the text', () => {
  it('tints this campaign’s keys and underlines a word the card has no fact for', () => {
    render(<Harness initial={{ opening: 'Hi {name}, your loan {loan_id} at {branch}', steps: [] }} />);
    const tint = screen.getByTestId('script-tint-opening');
    expect(Array.from(tint.querySelectorAll('mark:not([data-unknown])')).map((m) => m.textContent)).toEqual(['{name}', '{loan_id}']);
    expect(Array.from(tint.querySelectorAll('mark[data-unknown]')).map((m) => m.textContent)).toEqual(['{branch}']);
    expect(tint.getAttribute('aria-hidden')).toBe('true');
    expect(opening().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('The script uses {branch}, which is not a fact on the card. Add it as a fact or take it out.')).toBeTruthy();
  });

  it('keeps the tint to the field’s own box: the { list is outside it, after the field (S9)', () => {
    render(<Harness initial={{ opening: 'Hi {name}', steps: [] }} />);
    type(opening(), 'Hi {name} {');
    const tint = screen.getByTestId('script-tint-opening');
    const box = tint.parentElement!;
    // The tint and the field share a box of their own, and nothing else is in it.
    expect(Array.from(box.children)).toEqual([tint, opening()]);
    const pick = screen.getByTestId('script-key-pick');
    expect(box.contains(pick)).toBe(false);
    expect(box.nextElementSibling).toBe(pick);
  });

  it('takes the field’s scroll on every render, not only when the field scrolls (S9)', () => {
    render(<Harness initial={{ opening: 'Hi {name}', steps: [] }} />);
    const tint = screen.getByTestId('script-tint-opening');
    Object.defineProperty(opening(), 'scrollTop', { configurable: true, get: () => 40 });
    expect(tint.scrollTop).toBe(0);
    type(opening(), 'Hi {name}, again');
    expect(tint.scrollTop).toBe(40);
  });
});

describe('the { list', () => {
  it('opens on {, moves with the arrows, and adds the key with Enter, closing its brace', () => {
    render(<Harness initial={{ opening: '', steps: [] }} />);
    type(opening(), 'Hello {');
    expect(options().map((o) => o.querySelector('code')!.textContent)).toEqual([
      '{name}', '{place}', '{agent_name}', '{campaign_name}', '{amount_due}', '{loan_id}',
    ]);
    expect(opening().getAttribute('aria-expanded')).toBe('true');
    expect(opening().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
    fireEvent.keyDown(opening(), { key: 'ArrowDown' });
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true');
    expect(opening().getAttribute('aria-activedescendant')).toBe(options()[1]!.id);
    fireEvent.keyDown(opening(), { key: 'Enter' });
    expect(opening().value).toBe('Hello {place}');
    expect(screen.queryByTestId('script-key-list')).toBeNull();
    expect(opening().selectionStart).toBe('Hello {place}'.length);
  });

  it('filters as more is typed, by key or name, and Tab adds the one chosen', () => {
    render(<Harness initial={{ opening: '', steps: [] }} />);
    type(opening(), 'Loan {');
    fireEvent.change(opening(), { target: { value: 'Loan {lo' } });
    expect(options().map((o) => o.querySelector('b')!.textContent)).toEqual(['Loan ID']);
    fireEvent.keyDown(opening(), { key: 'Tab' });
    expect(opening().value).toBe('Loan {loan_id}');
    type(opening(), 'Loan {loan_id} {');
    fireEvent.change(opening(), { target: { value: 'Loan {loan_id} {amount d' } });
    // Not a word: the list closes.
    expect(screen.queryByTestId('script-key-list')).toBeNull();
  });

  it('names its list while it is open, never as a combobox, and says the list’s state aloud (S9)', () => {
    render(<Harness initial={{ opening: '', steps: [] }} />);
    const field = opening();
    const said = screen.getByTestId('script-key-announce');
    expect(field.getAttribute('role')).toBeNull();
    expect(field.getAttribute('aria-haspopup')).toBe('listbox');
    expect(field.getAttribute('aria-expanded')).toBe('false');
    expect(field.hasAttribute('aria-controls')).toBe(false);
    expect(said.getAttribute('aria-live')).toBe('polite');
    expect(said.textContent).toBe('');
    type(field, 'Hi {');
    expect(field.getAttribute('aria-controls')).toBe(screen.getByTestId('script-key-list').id);
    expect(field.getAttribute('aria-expanded')).toBe('true');
    expect(said.textContent).toBe('6 keys of this campaign. Up and down arrows to move, Enter to add, Escape to close.');
    fireEvent.change(field, { target: { value: 'Hi {lo' } });
    expect(said.textContent).toMatch(/^1 key of this campaign\./);
    // Filtered by key or name, anywhere in them: none matches. No listbox, so nothing is controlled.
    fireEvent.change(field, { target: { value: 'Hi {zz' } });
    expect(within(screen.getByTestId('script-key-pick')).getByText('No key matches “zz”.')).toBeTruthy();
    expect(said.textContent).toBe('No key matches “zz”.');
    expect(field.hasAttribute('aria-controls')).toBe(false);
    expect(field.hasAttribute('aria-activedescendant')).toBe(false);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field.getAttribute('aria-expanded')).toBe('false');
    expect(said.textContent).toBe('');
  });

  it('closes with Esc and leaves the text as typed', () => {
    render(<Harness initial={{ opening: '', steps: [] }} />);
    type(opening(), 'Pay by {');
    fireEvent.keyDown(opening(), { key: 'Escape' });
    expect(screen.queryByTestId('script-key-list')).toBeNull();
    expect(opening().value).toBe('Pay by {');
  });

  it('adds a key picked with the pointer', () => {
    render(<Harness initial={{ opening: '', steps: [] }} />);
    type(opening(), 'Due: {');
    fireEvent.click(screen.getByTestId('script-key-option-amount_due'));
    expect(opening().value).toBe('Due: {amount_due}');
  });
});

describe('the chips', () => {
  it('offer this campaign’s keys and add one at the caret of the field last typed in', () => {
    render(<Harness initial={{ opening: 'Hello there', steps: [] }} />);
    expect(within(screen.getByRole('group', { name: /Add a key to/ })).getAllByRole('button').map((b) => b.textContent)).toEqual([
      '{name}', '{place}', '{agent_name}', '{campaign_name}', '{amount_due}', '{loan_id}',
    ]);
    opening().focus();
    opening().setSelectionRange(6, 6);
    fireEvent.click(screen.getByTestId('script-chip-loan_id'));
    expect(opening().value).toBe('Hello {loan_id} there');
  });
});

describe('a word the card has no fact for', () => {
  it('offers to add the column it names as a fact', () => {
    const onAddFact = vi.fn();
    render(<Harness initial={{ opening: 'From {branch}', steps: [] }} onAddFact={onAddFact} />);
    fireEvent.click(screen.getByTestId('script-fix-opening-branch-add'));
    expect(onAddFact).toHaveBeenCalledWith('Branch', '{branch}');
  });

  it('says so in full when the card has no room for the column it names (S9)', () => {
    const full: FactsForm = {
      ...FACTS,
      list: ['A', 'B', 'C', 'D'].map((c) => ({ column: c, label: c, key: c.toLowerCase() })),
    };
    render(<Harness initial={{ opening: 'From {branch}', steps: [] }} onAddFact={vi.fn()} facts={full} />);
    expect(screen.queryByTestId('script-fix-opening-branch-add')).toBeNull();
    expect(screen.getByTestId('script-fix-opening-branch-full').textContent)
      .toBe('The card is full (4 of 4), so ‘Branch’ cannot be added. Use another key or take it out.');
  });

  it('offers a removed fact back, disabled with the reason when it cannot go back (S9)', () => {
    const onPutBack = vi.fn();
    const due = { column: 'Due', label: 'Due date', key: 'due_date' };
    render(<Harness initial={{ opening: 'By {due_date}', steps: [] }} removedInUse={[{ fact: due, blocked: null }]} onPutBack={onPutBack} />);
    fireEvent.click(screen.getByTestId('script-fix-opening-due_date-put-back'));
    expect(onPutBack).toHaveBeenCalledWith('due_date');
    cleanup();
    render(<Harness initial={{ opening: 'By {due_date}', steps: [] }} removedInUse={[{ fact: due, blocked: '‘Due’ is on the card again.' }]} onPutBack={onPutBack} />);
    const button = screen.getByTestId('script-fix-opening-due_date-put-back') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(document.getElementById(button.getAttribute('aria-describedby')!)!.textContent).toBe('‘Due’ is on the card again.');
  });

  it('offers to add it only from the latest upload’s columns', () => {
    render(<Harness initial={{ opening: 'From {branch}', steps: [] }} onAddFact={vi.fn()} uploaded={['Name', 'City', 'Loan ID']} />);
    expect(screen.getByTestId('script-fix-opening-branch')).toBeTruthy();
    expect(screen.queryByTestId('script-fix-opening-branch-add')).toBeNull();
  });

  it('puts another key in its place, or takes it out', () => {
    const onChange = vi.fn();
    render(<Harness initial={{ opening: 'Pay {due} now', steps: ['{due} please'] }} onChange={onChange} />);
    expect(screen.queryByTestId('script-fix-opening-due-add')).toBeNull();
    fireEvent.change(screen.getByTestId('script-fix-opening-due-use'), { target: { value: 'amount_due' } });
    expect(onChange).toHaveBeenLastCalledWith({ opening: 'Pay {amount_due} now', steps: ['{amount_due} please'] });
    cleanup();
    render(<Harness initial={{ opening: 'Pay {due} now', steps: [] }} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('script-fix-opening-due-remove'));
    expect(onChange).toHaveBeenLastCalledWith({ opening: 'Pay now', steps: [] });
  });
});

describe('As the agent reads it', () => {
  const script = { opening: 'Namaste {name}, about loan {loan_id} for {campaign_name}.', steps: ['Say that {amount_due} is due.'] };

  it('fills the keys from a sample customer, formatted as the card writes them', () => {
    render(<Harness initial={script} samples={[{ Name: 'Lakshmi Narayana', 'Loan ID': 'LN-204418', 'Loan Amount': '125000' }]} />);
    expect(screen.getByTestId('script-preview-opening').textContent).toBe('Namaste Lakshmi Narayana, about loan LN-204418 for Diwali collections.');
    expect(screen.getByTestId('script-preview-step-0').textContent).toBe('Say that ₹1,25,000 is due.');
  });

  it('says “<name> not given” for an empty value, and steps between sample customers', () => {
    render(<Harness initial={script} samples={[{ Name: 'Lakshmi', 'Loan ID': 'LN-1', 'Loan Amount': '500' }, { Name: 'Ravi', 'Loan ID': '  ' }]} />);
    expect(screen.queryByTestId('script-not-given')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next sample customer' }));
    expect(screen.getByText(/sample customer 2 of 2/)).toBeTruthy();
    expect(screen.getByTestId('script-preview-opening').textContent).toBe('Namaste Ravi, about loan Loan ID not given for Diwali collections.');
    expect(screen.getByTestId('script-preview-step-0').textContent).toBe('Say that Amount due not given is due.');
    expect(screen.getAllByTestId('script-not-given').map((n) => n.textContent)).toEqual(['Loan ID not given', 'Amount due not given']);
  });

  it('leaves an empty value out on a campaign still on the old model, as its agents read it (R5)', () => {
    render(<Harness initial={script} legacy samples={[{ Name: 'Ravi', 'Loan ID': '  ' }]} />);
    expect(screen.queryByTestId('script-not-given')).toBeNull();
    expect(screen.getByTestId('script-preview-opening').textContent).toBe('Namaste Ravi, about loan  for Diwali collections.');
    expect(screen.getByTestId('script-preview-step-0').textContent).toBe('Say that  is due.');
  });
});
