import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('marks a withheld value, and leaves out an empty line', () => {
    render(<Kpi label="Success rate" value="Not enough calls yet" withheld sub={null} look="outlined" testId="kpi" />);
    const kpi = screen.getByTestId('kpi');
    expect(kpi.className).toMatch(/outlined/);
    expect(kpi.querySelector('[data-withheld]')?.getAttribute('data-withheld')).toBe('true');
    expect(kpi.children).toHaveLength(2);
  });
});
