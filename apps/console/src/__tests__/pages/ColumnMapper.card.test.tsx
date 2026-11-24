import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ColumnMapper } from '../../pages/campaigns/agency/ColumnMapper';
import { buildContextDisplay, initialMapping, setRole, type MappingState } from '../../utils/agencyColumnMapping';
import type { AgencyColumnAnalysis } from '../../types/agency-campaign';

/**
 * "On the card" on the mapping screen (AS19): offered on New campaign only, where its picks become
 * the new campaign's first card facts; a list added to a campaign leaves the card to Settings.
 */

const ANALYSIS: AgencyColumnAnalysis = {
  headers: ['Mobile', 'Loan No', 'Amount'],
  columns: [
    { name: 'Mobile', index: 0, samples: ['9820041772'], non_empty: 10, phone_score: 0.95, distinct: 10, distinct_phones: 10 },
    { name: 'Loan No', index: 1, samples: ['LN-001'], non_empty: 10, phone_score: 0, distinct: 10, distinct_phones: 0 },
    { name: 'Amount', index: 2, samples: ['125000'], non_empty: 10, phone_score: 0, distinct: 10, distinct_phones: 0 },
  ],
  rows_sampled: 10,
  truncated: false,
  suggested_phone_column: 'Mobile',
  phone_column_ambiguous: false,
  phone_column_candidates: [],
};

function renderMapper(cardChoice: boolean, state: MappingState = initialMapping(ANALYSIS)) {
  const onChange = vi.fn<(next: MappingState) => void>();
  render(<ColumnMapper analysis={ANALYSIS} state={state} onChange={onChange} fileName="loans.csv" cardChoice={cardChoice} />);
  return onChange;
}

const choices = (column: string) => [...(screen.getByLabelText(`Use ${column} as`) as HTMLSelectElement).options].map((o) => o.textContent);

afterEach(cleanup);

describe('ColumnMapper: On the card', () => {
  it('is offered on New campaign, and its picks become the card’s facts in the order picked', () => {
    const onChange = renderMapper(true);
    expect(choices('Loan No')).toEqual(['Phone number', 'Timezone', 'On the card', 'Detail', 'Ignore']);
    expect(screen.getByTestId('card-choice-note').textContent).toContain('Change their names and order later in the campaign’s Settings.');
    fireEvent.change(screen.getByLabelText('Use Amount as'), { target: { value: 'hero' } });
    const picked = setRole(onChange.mock.calls[0]![0], 'Loan No', 'hero');
    expect(buildContextDisplay(picked)).toEqual({
      facts: [
        { column: 'Amount', label: 'Amount', key: 'amount' },
        { column: 'Loan No', label: 'Loan No', key: 'loan_no' },
      ],
      // AS20: the kept columns in the file's order (not the order picked), which More details follows.
      order: ['Loan No', 'Amount'],
    });
  });

  it('says when a column picked On the card became the customer’s name instead (S9)', () => {
    const named: AgencyColumnAnalysis = {
      ...ANALYSIS,
      headers: [...ANALYSIS.headers, 'Customer Name'],
      columns: [...ANALYSIS.columns, { name: 'Customer Name', index: 3, samples: ['Lakshmi'], non_empty: 10, phone_score: 0, distinct: 10, distinct_phones: 0 }],
    };
    const picked = setRole(setRole(initialMapping(named), 'Amount', 'hero'), 'Customer Name', 'hero');
    render(<ColumnMapper analysis={named} state={picked} onChange={vi.fn()} fileName="loans.csv" cardChoice />);
    expect(screen.getByTestId('card-role-note').textContent).toBe('‘Customer Name’ is shown as the customer’s name, not as a fact.');
    cleanup();
    render(<ColumnMapper analysis={named} state={picked} onChange={vi.fn()} fileName="loans.csv" />);
    expect(screen.queryByTestId('card-role-note')).toBeNull();
  });

  it('is not offered on a list added to a campaign, where Settings chooses the card', () => {
    renderMapper(false);
    expect(choices('Loan No')).toEqual(['Phone number', 'Timezone', 'Detail', 'Ignore']);
    expect(screen.getByTestId('card-choice-note').textContent).toBe('What agents see on the customer card is chosen in the campaign’s Settings.');
  });
});
