import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ColumnMapper } from '../../pages/campaigns/agency/ColumnMapper';
import { initialMapping, type MappingState } from '../../utils/agencyColumnMapping';
import type { AgencyColumnAnalysis } from '../../types/agency-campaign';

/**
 * "Check duplicates on" on the mapping screen: a loan book picks the loan number,
 * so one borrower's two loans (two rows, one number) are both imported.
 */

const ANALYSIS: AgencyColumnAnalysis = {
  headers: ['Mobile', 'Loan No', 'none'],
  columns: [
    // 95 valid numbers, 77 distinct once normalised: 18 rows repeat a number.
    { name: 'Mobile', index: 0, samples: ['9820041772'], non_empty: 100, phone_score: 0.95, distinct: 82, distinct_phones: 77 },
    { name: 'Loan No', index: 1, samples: ['LN-001'], non_empty: 100, phone_score: 0, distinct: 100, distinct_phones: 0 },
    // A header literally called `none` must still be choosable as a column.
    { name: 'none', index: 2, samples: ['x'], non_empty: 100, phone_score: 0, distinct: 3, distinct_phones: 0 },
  ],
  rows_sampled: 100,
  truncated: false,
  suggested_phone_column: 'Mobile',
  phone_column_ambiguous: false,
  phone_column_candidates: [],
};

function renderMapper(state: MappingState = initialMapping(ANALYSIS)) {
  const onChange = vi.fn<(next: MappingState) => void>();
  render(<ColumnMapper analysis={ANALYSIS} state={state} onChange={onChange} fileName="loans.csv" />);
  return { onChange, select: screen.getByLabelText('Check duplicates on') as HTMLSelectElement };
}

afterEach(cleanup);

describe('ColumnMapper: Check duplicates on', () => {
  it('defaults to the phone number, offers the other columns and none, and shows how unique the phone is', () => {
    const { select } = renderMapper();
    expect(select.value).toBe('phone');
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Phone number', 'Loan No', 'none', "Don't remove duplicates",
    ]);
    expect(screen.getByTestId('dedupe-note').textContent).toContain(
      'Mobile: 81% of valid numbers are unique in this file; 18 rows repeat an earlier number and will be dropped.',
    );
  });

  it('picking a column sets it on the mapping', () => {
    const { select, onChange } = renderMapper();
    fireEvent.change(select, { target: { value: 'column:Loan No' } });
    expect(onChange.mock.calls[0]![0].dedupe).toEqual({ mode: 'column', column: 'Loan No' });
  });

  it('a column named `none` is a column, and the none option is none', () => {
    const { select, onChange } = renderMapper();
    fireEvent.change(select, { target: { value: 'column:none' } });
    fireEvent.change(select, { target: { value: 'none' } });
    expect(onChange.mock.calls.map(([next]) => next.dedupe)).toEqual([
      { mode: 'column', column: 'none' },
      { mode: 'none' },
    ]);
  });

  it('links the select to its note for screen readers', () => {
    const { select } = renderMapper();
    expect(select.getAttribute('aria-describedby')).toBe('ingest-dedupe-note');
    expect(document.getElementById('ingest-dedupe-note')).toBe(screen.getByTestId('dedupe-note'));
  });

  it('says that "don\'t remove duplicates" still skips an exact copy', () => {
    renderMapper({ ...initialMapping(ANALYSIS), dedupe: { mode: 'none' } });
    expect(screen.getByTestId('dedupe-note').textContent).toContain('only an exact copy of an earlier row is skipped');
  });

  it('says what a chosen column means for rows that share a number', () => {
    renderMapper({ ...initialMapping(ANALYSIS), dedupe: { mode: 'column', column: 'Loan No' } });
    expect(screen.getByTestId('dedupe-note').textContent).toBe(
      'Loan No: 100% unique in this file. Rows that share a phone number are all kept. The dialer never calls one number twice at the same time.',
    );
  });
});
