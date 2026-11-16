import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Kpi } from '../../components/common/Kpi';

/** The one figure Insights and Home both show: label, value, optional line, two looks. */
describe('Kpi', () => {
  it('shows the label, the value and the line beneath, in the Insights look by default', () => {
    render(<Kpi label="Dials" value="1,218" sub="Across 2 campaigns" testId="kpi" />);
    const kpi = screen.getByTestId('kpi');
    expect(kpi.textContent).toBe('Dials1,218Across 2 campaigns');
    expect(kpi.className).toMatch(/filled/);
    expect(kpi.querySelector('[data-withheld]')?.getAttribute('data-withheld')).toBe('false');
  });

  it('keeps a hint off the label until its button is used', () => {
    render(<Kpi label="Connected" hint="Not counting wrap-up redials." value="72" sub="Connect rate 16.2%" testId="kpi" />);
    const kpi = screen.getByTestId('kpi');
    expect(kpi.querySelector('[data-part="sub"]')?.textContent).toBe('Connect rate 16.2%');
    expect(screen.queryByRole('tooltip')).toBeNull();
    const hidden = document.querySelector('[role="tooltip"]');
    expect(hidden?.getAttribute('aria-hidden')).toBe('true');
    expect(hidden?.textContent).toBe('Not counting wrap-up redials.');
    const explain = screen.getByRole('button', { name: 'Explain' });
    fireEvent.pointerDown(explain);
    fireEvent.click(explain);
    expect(screen.getByRole('tooltip').textContent).toBe('Not counting wrap-up redials.');
  });

  it('marks a withheld value, and leaves out an empty line', () => {
    render(<Kpi label="Success rate" value="Not enough calls yet" withheld sub={null} look="outlined" testId="kpi" />);
    const kpi = screen.getByTestId('kpi');
    expect(kpi.className).toMatch(/outlined/);
    expect(kpi.querySelector('[data-withheld]')?.getAttribute('data-withheld')).toBe('true');
    expect(kpi.children).toHaveLength(2);
  });
});
