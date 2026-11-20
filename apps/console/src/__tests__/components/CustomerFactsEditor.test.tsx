import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { useState } from 'react';
import { CustomerFactsEditor } from '../../pages/campaigns/agency/CustomerFactsEditor';
import { useConfigFieldErrors } from '../../pages/campaigns/agency/configFieldErrors';
import type { FactsForm } from '../../utils/agency/stationSettings';

/**
 * Campaign Settings › Customer facts (BE-6) against the server's rules: column names match ignoring
 * case (a stored `amount` is the list's `Amount`), a type change never adds a second key for one
 * column, and every select and error has its own id, whatever the column names.
 */

const NO_ROLES = { name: '', place: '', amount_due: '', due_date: '' };

function Harness({ initial, columns, errors = {}, onChange, readOnly = false }: {
  initial: FactsForm;
  columns: string[];
  errors?: Record<string, string>;
  onChange?: (next: FactsForm) => void;
  readOnly?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const view = useConfigFieldErrors(errors);
  return (
    <CustomerFactsEditor
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      columns={columns}
      hidden={[]}
      loading={false}
      errors={view}
      readOnly={readOnly}
    />
  );
}

afterEach(() => cleanup());

describe('CustomerFactsEditor', () => {
  it('shows a role stored in another case as the list’s column, chosen, never “not in the list”', () => {
    render(<Harness initial={{ roles: { ...NO_ROLES, place: 'city' }, types: {} }} columns={['Name', 'City']} />);
    const place = screen.getByTestId('fact-role-place') as HTMLSelectElement;
    expect(place.value).toBe('City');
    expect(within(place).getAllByRole('option').map((o) => o.textContent)).toEqual(['Not set', 'Name', 'City']);
  });

  it('reads a type stored in another case, and changing it keeps one key', () => {
    const onChange = vi.fn();
    render(<Harness initial={{ roles: NO_ROLES, types: { 'paid on': 'date' } }} columns={['Paid On']} onChange={onChange} />);
    const type = screen.getByTestId('fact-type-Paid On') as HTMLSelectElement;
    expect(type.value).toBe('date');
    fireEvent.change(type, { target: { value: 'money' } });
    expect(onChange).toHaveBeenLastCalledWith({ roles: NO_ROLES, types: { 'paid on': 'money' } });
  });

  it('gives every column’s select and error an id of its own', () => {
    render(
      <Harness
        initial={{ roles: NO_ROLES, types: {} }}
        columns={['a b', 'a-b', 'a.b']}
        errors={{ 'context_display.types.a b': 'First.', 'context_display.types.a-b': 'Second.' }}
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
  });

  it('never says it is still reading to a reader who cannot edit', () => {
    render(<Harness initial={{ roles: NO_ROLES, types: {} }} columns={[]} readOnly />);
    expect(screen.getByTestId('customer-facts-empty').textContent).toBe('No customer facts are set for this campaign.');
  });
});
