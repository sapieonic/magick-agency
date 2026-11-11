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
    expect(onChange.mock.calls[0]![0].dedupe).toEqual({ mode: 'keys', keys: [{ kind: 'column', column: 'Loan No' }] });
  });

  it('a column named `none` is a column, and the none option is none', () => {
    const { select, onChange } = renderMapper();
    fireEvent.change(select, { target: { value: 'column:none' } });
    fireEvent.change(select, { target: { value: 'none' } });
    expect(onChange.mock.calls.map(([next]) => next.dedupe)).toEqual([
      { mode: 'keys', keys: [{ kind: 'column', column: 'none' }] },
      { mode: 'none' },
    ]);
  });

  it('from none, picking a key starts a one-key check', () => {
    const { select, onChange } = renderMapper({ ...initialMapping(ANALYSIS), dedupe: { mode: 'none' } });
    expect(select.value).toBe('none');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Phone number', 'Loan No', 'none', "Don't remove duplicates"]);
    fireEvent.change(select, { target: { value: 'column:Loan No' } });
    expect(onChange.mock.calls[0]![0].dedupe).toEqual({ mode: 'keys', keys: [{ kind: 'column', column: 'Loan No' }] });
    expect(screen.queryByRole('button', { name: 'Combine with another column' })).toBeNull();
  });

  it('links the select to its note for screen readers', () => {
    const { select } = renderMapper();
    expect(select.getAttribute('aria-describedby')).toBe('ingest-dedupe-note');
    expect(document.getElementById('ingest-dedupe-note')).toBe(screen.getByTestId('dedupe-note'));
  });

  it('says that "don\'t remove duplicates" still skips an exact copy', () => {
    renderMapper({ ...initialMapping(ANALYSIS), dedupe: { mode: 'none' } });
    expect(screen.getByTestId('dedupe-note').textContent).toContain('only an exact copy of an earlier row (the same number and the same value in every column not set to Ignore) is skipped');
  });

  it('says what a chosen column means for rows that share a number', () => {
    renderMapper({ ...initialMapping(ANALYSIS), dedupe: { mode: 'keys', keys: [{ kind: 'column', column: 'Loan No' }] } });
    expect(screen.getByTestId('dedupe-note').textContent).toBe(
      'Loan No: 100% unique in this file. Rows that share a phone number are all kept. The dialler never calls one number twice at the same time.',
    );
  });

  describe('combining columns', () => {
    const combined: MappingState = {
      ...initialMapping(ANALYSIS),
      dedupe: { mode: 'keys', keys: [{ kind: 'column', column: 'Loan No' }, { kind: 'phone' }] },
    };

    it('"Combine with another column" adds the next key not yet chosen', () => {
      const { onChange } = renderMapper();
      fireEvent.click(screen.getByRole('button', { name: 'Combine with another column' }));
      expect(onChange.mock.calls[0]![0].dedupe).toEqual({
        mode: 'keys', keys: [{ kind: 'phone' }, { kind: 'column', column: 'Loan No' }],
      });
    });

    it('"Combine with another column" adds a column rather than the phone, and the phone only when no column is left', () => {
      const onChange = vi.fn<(next: MappingState) => void>();
      const loan: MappingState = { ...initialMapping(ANALYSIS), dedupe: { mode: 'keys', keys: [{ kind: 'column', column: 'Loan No' }] } };
      const { rerender } = render(<ColumnMapper analysis={ANALYSIS} state={loan} onChange={onChange} fileName="loans.csv" />);
      fireEvent.click(screen.getByRole('button', { name: 'Combine with another column' }));
      const two = onChange.mock.calls[0]![0];
      expect(two.dedupe).toEqual({
        mode: 'keys', keys: [{ kind: 'column', column: 'Loan No' }, { kind: 'column', column: 'none' }],
      });
      // The added select is an ordinary one: the phone number is still offered in it.
      rerender(<ColumnMapper analysis={ANALYSIS} state={two} onChange={onChange} fileName="loans.csv" />);
      const second = screen.getByLabelText('Duplicate check column 2') as HTMLSelectElement;
      expect([...second.options].map((o) => o.textContent)).toEqual(['Phone number', 'none']);
      fireEvent.click(screen.getByRole('button', { name: 'Combine with another column' }));
      expect(onChange.mock.calls[1]![0].dedupe).toEqual({
        mode: 'keys', keys: [{ kind: 'column', column: 'Loan No' }, { kind: 'column', column: 'none' }, { kind: 'phone' }],
      });
    });

    it('shows a select per extra key, each offering only the keys the others do not hold', () => {
      const { select } = renderMapper(combined);
      expect(select.value).toBe('column:Loan No');
      expect([...select.options].map((o) => o.textContent)).toEqual(['Loan No', 'none', "Don't remove duplicates"]);
      const second = screen.getByLabelText('Duplicate check column 2') as HTMLSelectElement;
      expect(second.value).toBe('phone');
      expect([...second.options].map((o) => o.textContent)).toEqual(['Phone number', 'none']);
      expect(second.getAttribute('aria-describedby')).toBe('ingest-dedupe-note');
    });

    it('changing or removing an extra key updates the mapping', () => {
      const { onChange } = renderMapper(combined);
      fireEvent.change(screen.getByLabelText('Duplicate check column 2'), { target: { value: 'column:none' } });
      fireEvent.click(screen.getByRole('button', { name: 'Remove Phone number from the duplicate check' }));
      expect(onChange.mock.calls.map(([next]) => next.dedupe)).toEqual([
        { mode: 'keys', keys: [{ kind: 'column', column: 'Loan No' }, { kind: 'column', column: 'none' }] },
        { mode: 'keys', keys: [{ kind: 'column', column: 'Loan No' }] },
      ]);
    });

    it('the first key can be removed while another remains, and focus lands on the first select', () => {
      const { select, onChange } = renderMapper(combined);
      const remove = screen.getByRole('button', { name: 'Remove Loan No from the duplicate check' });
      remove.focus();
      fireEvent.click(remove);
      expect(onChange.mock.calls[0]![0].dedupe).toEqual({ mode: 'keys', keys: [{ kind: 'phone' }] });
      expect(document.activeElement).toBe(select);
    });

    it('a single key has no Remove: "Don\'t remove duplicates" is how to say none', () => {
      renderMapper();
      expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    });

    it('changing an extra key keeps its select mounted, so keyboard focus stays in it', () => {
      const onChange = vi.fn<(next: MappingState) => void>();
      const { rerender } = render(<ColumnMapper analysis={ANALYSIS} state={combined} onChange={onChange} fileName="loans.csv" />);
      const second = screen.getByLabelText('Duplicate check column 2') as HTMLSelectElement;
      second.focus();
      fireEvent.change(second, { target: { value: 'column:none' } });
      rerender(<ColumnMapper analysis={ANALYSIS} state={onChange.mock.calls[0]![0]} onChange={onChange} fileName="loans.csv" />);
      expect(screen.getByLabelText('Duplicate check column 2')).toBe(second);
      expect(document.activeElement).toBe(second);
    });

    it('offers no further key at three', () => {
      renderMapper({
        ...combined,
        dedupe: { mode: 'keys', keys: [{ kind: 'column', column: 'Loan No' }, { kind: 'phone' }, { kind: 'column', column: 'none' }] },
      });
      expect(screen.getByLabelText('Duplicate check column 3')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Combine with another column' })).toBeNull();
    });

    it('says a row is dropped only when every key matches, and that one number can hold several rows', () => {
      renderMapper(combined);
      expect(screen.getByTestId('dedupe-note').textContent).toBe(
        'A row is dropped only when its Loan No and Mobile both match an earlier row; a row with any of them blank is not checked. Loan No has no repeats in this file, so no row will be dropped as a duplicate. Rows on one number are kept when the other columns differ. The dialler never calls one number twice at the same time.',
      );
    });
  });
});
