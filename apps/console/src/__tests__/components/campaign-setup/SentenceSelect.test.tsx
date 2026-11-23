import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Sentence, SentenceSelect } from '../../../components/campaign-setup';

/** The chip select that sits inside a line of prose. */

const TIMES = [
  { value: '2', label: '2 times' },
  { value: '3', label: '3 times' },
  { value: '5', label: '5 times', disabled: true },
] as const;

describe('SentenceSelect', () => {
  it('is a named select inside its sentence and reports the choice', () => {
    const onChange = vi.fn();
    render(
      <Sentence testId="retry-sentence">
        Try again <SentenceSelect ariaLabel="How many times" value="3" options={TIMES} onChange={onChange} />.
      </Sentence>,
    );
    expect(screen.getByTestId('retry-sentence').tagName).toBe('P');
    const select = screen.getByRole('combobox', { name: 'How many times' }) as HTMLSelectElement;
    expect(select.value).toBe('3');
    fireEvent.change(select, { target: { value: '2' } });
    expect(onChange).toHaveBeenCalledWith('2');
  });

  it('marks itself invalid and disabled', () => {
    render(
      <SentenceSelect ariaLabel="How many times" value="3" options={TIMES} onChange={() => {}} invalid disabled />,
    );
    const select = screen.getByRole('combobox', { name: 'How many times' }) as HTMLSelectElement;
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(select.disabled).toBe(true);
  });
});
