import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { CustomerFactsEditor, type ColumnsRead } from '../../pages/campaigns/agency/CustomerFactsEditor';
import { useConfigFieldErrors } from '../../pages/campaigns/agency/configFieldErrors';
import { contextDisplayPayload, type FactsForm } from '../../utils/agency/stationSettings';

/**
 * AS20, Settings › What agents see › More details: the latest upload's other columns (not the
 * name, the line under it, a fact or a hidden column), each shown unless ticked off, with a
 * sample as agents see it and how it is read; a phone-looking column says so; the server's
 * refusal lands under the list.
 */

afterEach(cleanup);

const card = (over: Partial<FactsForm> = {}): FactsForm => ({
  name: 'Customer Name',
  place: null,
  list: [{ column: 'Amount Due', label: 'Amount due', key: 'amount_due' }],
  types: { 'Amount Due': 'money' },
  moreHidden: [],
  ...over,
});

const COLUMNS = ['Customer Name', 'Amount Due', 'Loan No', 'Alt Mobile', 'Branch', 'PAN', 'Old Column'];
const UPLOADED = ['Customer Name', 'Amount Due', 'Loan No', 'Alt Mobile', 'Branch', 'PAN'];
const SAMPLES = [{ 'Customer Name': 'Asha', 'Amount Due': '12500', 'Loan No': 'LN-1', 'Alt Mobile': '98765 43210', Branch: 'Kothrud', PAN: 'X' }];

let last: FactsForm | null = null;

function Harness({ initial, columnsRead, serverErrors = {}, phoneDisplay = 'masked', readOnly = false }: {
  initial: FactsForm;
  columnsRead?: ColumnsRead;
  serverErrors?: Record<string, string>;
  phoneDisplay?: 'full' | 'masked';
  readOnly?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const view = useConfigFieldErrors(serverErrors);
  last = value;
  return (
    <CustomerFactsEditor
      value={value}
      onChange={setValue}
      columns={COLUMNS}
      uploaded={UPLOADED}
      hidden={['PAN']}
      columnsRead={columnsRead}
      errors={view}
      samples={SAMPLES}
      phoneDisplay={phoneDisplay}
      readOnly={readOnly}
    />
  );
}

const listed = () => Array.from(document.querySelectorAll('[data-testid^="more-detail-setting-"]')).map((el) => el.getAttribute('data-testid')!.slice('more-detail-setting-'.length));

describe('More details in Settings (AS20)', () => {
  it('lists the latest upload\'s other columns: not the name, a fact, a hidden one or one the upload lacks', () => {
    render(<Harness initial={card()} />);
    expect(listed()).toEqual(['Loan No', 'Alt Mobile', 'Branch']);
    expect(screen.getByTestId('more-details-shown').textContent).toBe('3 of 3 shown');
    expect((screen.getByTestId('more-detail-show-Branch') as HTMLInputElement).checked).toBe(true);
  });

  it('ticking one off writes it to more_hidden; Hide all and Show all', () => {
    render(<Harness initial={card()} />);
    fireEvent.click(screen.getByTestId('more-detail-show-Branch'));
    expect(last!.moreHidden).toEqual(['Branch']);
    expect(screen.getByTestId('more-details-shown').textContent).toBe('2 of 3 shown');
    expect(contextDisplayPayload({}, last!).more_hidden).toEqual(['Branch']);
    fireEvent.click(screen.getByTestId('more-details-all-off'));
    expect(screen.getByTestId('more-details-shown').textContent).toBe('0 of 3 shown');
    expect((screen.getByTestId('more-details-all-off') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('more-details-all-on'));
    expect(last!.moreHidden).toEqual([]);
  });

  it('a stored more_hidden opens ticked off, ignoring case', () => {
    render(<Harness initial={card({ moreHidden: ['loan no'] })} />);
    expect((screen.getByTestId('more-detail-show-Loan No') as HTMLInputElement).checked).toBe(false);
  });

  it('shows each sample as agents will: a phone-looking value masked, with a note; Text takes it back', () => {
    render(<Harness initial={card()} />);
    const row = screen.getByTestId('more-detail-setting-Alt Mobile');
    expect(row.textContent).toContain('e.g. 98••• ••210');
    expect(row.textContent).not.toContain('43210');
    expect((screen.getByTestId('more-detail-type-Alt Mobile') as HTMLSelectElement).value).toBe('phone');
    expect(screen.getByTestId('more-detail-phone-note-Alt Mobile').textContent).toContain('with the middle digits hidden');
    fireEvent.change(screen.getByTestId('more-detail-type-Alt Mobile'), { target: { value: 'text' } });
    expect(last!.types['Alt Mobile']).toBe('text');
    expect(screen.queryByTestId('more-detail-phone-note-Alt Mobile')).toBeNull();
    expect(screen.getByTestId('more-detail-setting-Alt Mobile').textContent).toContain('e.g. 98765 43210');
  });

  it('a column added as a fact leaves the list', () => {
    render(<Harness initial={card({ list: [...card().list, { column: 'Branch', label: 'Branch', key: 'branch' }] })} />);
    expect(listed()).toEqual(['Loan No', 'Alt Mobile']);
  });

  it('says when the columns are being read, and when there is nothing more to list', () => {
    render(<Harness initial={card()} columnsRead="loading" />);
    expect(screen.getByTestId('more-details-columns')).toBeTruthy();
    cleanup();
    render(<Harness initial={card({ list: ['Amount Due', 'Loan No', 'Alt Mobile', 'Branch'].map((c, i) => ({ column: c, label: c, key: `k${i}` })) })} />);
    expect(screen.getByTestId('more-details-none').textContent).toBe('Every column agents may see is already on the card.');
  });

  it('the server\'s refusal lands under the list; read-only shows the choices without the buttons', () => {
    render(<Harness initial={card()} serverErrors={{ 'context_display.more_hidden': 'A column name must be 1 to 200 characters.' }} />);
    expect(screen.getByTestId('more-details-settings').textContent).toContain('A column name must be 1 to 200 characters.');
    cleanup();
    render(<Harness initial={card()} readOnly />);
    expect(screen.queryByTestId('more-details-all-on')).toBeNull();
    expect((screen.getByTestId('more-detail-show-Branch') as HTMLInputElement).disabled).toBe(true);
  });
});
