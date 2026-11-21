import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { useState } from 'react';
import { ScriptEditor } from '../../pages/campaigns/agency/ScriptEditor';
import { useConfigFieldErrors } from '../../pages/campaigns/agency/configFieldErrors';
import { cardKeys, scriptErrors, type FactsForm, type ScriptForm } from '../../utils/agency/stationSettings';

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
}: {
  initial: ScriptForm;
  onAddFact?: (column: string, token: string) => void;
  samples?: Array<Record<string, unknown>>;
  onChange?: (next: ScriptForm) => void;
}) {
  const [value, setValue] = useState(initial);
  const keys = cardKeys(FACTS);
  const view = useConfigFieldErrors(scriptErrors(value, keys), new Set(Object.keys(scriptErrors(value, keys))));
  return (
    <ScriptEditor
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      errors={view}
      facts={FACTS}
      offered={keys}
      allowed={keys}
      columns={['Name', 'City', 'Loan Amount', 'Loan ID', 'Branch']}
      samples={samples}
      campaignName="Diwali collections"
      onAddFact={onAddFact}
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
});
