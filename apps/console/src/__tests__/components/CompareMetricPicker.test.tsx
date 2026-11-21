import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { compareMetricId, type AgencyCompareMetricRef } from '@magick-agency/contracts/api/agency/compare';
import { CompareMetricPicker } from '../../components/agency/compare/CompareMetricPicker';
import { CompareAgentChips } from '../../components/agency/compare/CompareAgentChips';
import { CODES, SALES_CODES, WILL_PAY, compareOptions } from '../helpers/compare';

/**
 * The metric picker, the outcome-set builder and the agent chips (`docs/compare-agents.md` §2,
 * CP1, CP17, CP18): six metrics at most, five codes at most, three agents at most; promise
 * metrics only on a campaign that records promises; a set's direction starting from the contract's
 * default and following the codes until the supervisor chooses; "few calls" and "no longer active".
 */

const builtin = (key: string) => ({ kind: 'builtin', key }) as AgencyCompareMetricRef;
const FIVE = ['calls_handled', 'calls_per_hour', 'connect_rate', 'avg_call', 'choose_time'].map(builtin);

function picker(metrics: AgencyCompareMetricRef[], codes = CODES, trend: AgencyCompareMetricRef | null = null) {
  const onMetrics = vi.fn();
  const onTrend = vi.fn();
  render(<CompareMetricPicker id="p" metrics={metrics} trend={trend} codes={codes} onMetrics={onMetrics} onTrend={onTrend} />);
  return { onMetrics, onTrend };
}

const box = (key: string) => document.querySelector(`input[data-metric="${key}"]`) as HTMLInputElement;
const code = (c: string) => document.querySelector(`button[data-code="${c}"]`) as HTMLButtonElement;

describe('the metric picker', () => {
  it('adds and removes a built-in, at the end of the list', () => {
    const { onMetrics } = picker(FIVE);
    fireEvent.click(box('success_rate'));
    expect(onMetrics.mock.calls[0]![0].map(compareMetricId)).toEqual([...FIVE.map(compareMetricId), 'success_rate']);
    fireEvent.click(box('avg_call'));
    expect(onMetrics.mock.calls[1]![0].map(compareMetricId)).not.toContain('avg_call');
  });

  it('stops at six: every other box is disabled and says so', () => {
    picker([...FIVE, builtin('success_rate')]);
    expect(box('no_outcome_rate').disabled).toBe(true);
    expect(box('success_rate').disabled).toBe(false);
    expect(screen.getByText('Six chosen. Untick one to add another.')).toBeTruthy();
  });

  it('never unticks the last metric', () => {
    picker([builtin('avg_call')]);
    expect(box('avg_call').disabled).toBe(true);
  });

  it('marks each metric with its direction', () => {
    picker(FIVE);
    expect(box('choose_time').closest('label')!.textContent).toContain('lower is better');
    expect(box('success_rate').closest('label')!.textContent).toContain('higher is better');
    expect(box('avg_call').closest('label')!.textContent).toContain('shown, never flagged');
  });

  it('hides the promise metrics on a campaign that records no promises', () => {
    picker(FIVE, SALES_CODES);
    expect(box('promises_rate')).toBeNull();
    expect(box('promised_amount')).toBeNull();
    expect(box('success_rate')).not.toBeNull();
  });

  it('lists the outcome sets on the page and removes one', () => {
    const { onMetrics } = picker([builtin('calls_handled'), WILL_PAY]);
    const set = screen.getByTestId('compare-outcome-set');
    expect(set.textContent).toContain('Will pay');
    expect(set.textContent).toContain('higher is better');
    fireEvent.click(within(set).getByRole('button', { name: 'Remove' }));
    expect(onMetrics.mock.calls[0]![0].map(compareMetricId)).toEqual(['calls_handled']);
  });

  it('chooses the trend from the countable metrics', () => {
    const { onTrend } = picker([builtin('calls_handled'), WILL_PAY], CODES, WILL_PAY);
    const select = screen.getByTestId('compare-trend-select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['No trend', 'Will pay', 'Promises']);
    fireEvent.change(select, { target: { value: 'promises_rate' } });
    expect(onTrend).toHaveBeenCalledWith({ kind: 'builtin', key: 'promises_rate' });
    fireEvent.change(select, { target: { value: '' } });
    expect(onTrend).toHaveBeenLastCalledWith(null);
  });
});

describe('the outcome-set builder', () => {
  it('ticks at most five outcomes', () => {
    picker(FIVE);
    for (const c of CODES) fireEvent.click(code(c.code));
    const pressed = CODES.filter((c) => code(c.code).getAttribute('aria-pressed') === 'true').map((c) => c.code);
    expect(pressed).toHaveLength(5);
    expect(code('not_interested').getAttribute('aria-disabled')).toBe('true');
  });

  it('starts "better when higher" for success codes only, and "just show it" otherwise (CP18)', () => {
    picker(FIVE);
    const radio = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
    expect(radio('Just show it').checked).toBe(true);
    fireEvent.click(code('will_pay'));
    expect(radio('Better when higher').checked).toBe(true);
    fireEvent.click(code('refused'));
    expect(radio('Just show it').checked).toBe(true);
    expect(radio('Better when lower').checked).toBe(false);
  });

  it('adds the set with the direction and name chosen, codes in catalog order', () => {
    const { onMetrics } = picker(FIVE);
    fireEvent.click(code('wrong_number'));
    fireEvent.click(code('refused'));
    fireEvent.click(screen.getByLabelText('Better when lower'));
    fireEvent.change(screen.getByLabelText('Name (optional)'), { target: { value: 'Lost' } });
    fireEvent.click(screen.getByTestId('compare-outcome-add'));
    expect(onMetrics).toHaveBeenCalledWith([...FIVE, { kind: 'outcomes', codes: ['refused', 'wrong_number'], better: 'lower', label: 'Lost' }]);
  });

  it('shows the default name as the placeholder and refuses an empty set', () => {
    const { onMetrics } = picker(FIVE);
    fireEvent.click(screen.getByTestId('compare-outcome-add'));
    expect(screen.getByRole('alert').textContent).toBe('Choose at least one outcome.');
    fireEvent.click(code('refused'));
    fireEvent.click(code('call_back'));
    expect((screen.getByLabelText('Name (optional)') as HTMLInputElement).placeholder).toBe('Refused or Call back');
    expect(onMetrics).not.toHaveBeenCalled();
  });

  it('refuses a seventh metric', () => {
    const { onMetrics } = picker([...FIVE, builtin('success_rate')]);
    fireEvent.click(code('refused'));
    fireEvent.click(screen.getByTestId('compare-outcome-add'));
    expect(screen.getByRole('alert').textContent).toMatch(/6 metrics are chosen/);
    expect(onMetrics).not.toHaveBeenCalled();
  });
});

describe('the agent chips', () => {
  it('marks few calls and no longer active, and names an unresolved id as one, by its first 8 characters', () => {
    render(<CompareAgentChips agents={compareOptions().agents} slots={[null, null, null]} onToggle={vi.fn()} />);
    const chips = screen.getAllByTestId('compare-agent-chip');
    expect(chips.map((c) => c.textContent)).toEqual([
      'Lakshmi P',
      'Ravi Kumar',
      'Priya M',
      'Arjun T· no longer active',
      'Divya S· few calls',
      'Agent u-kiran',
    ]);
  });

  it('stops at three picks, with the reason', () => {
    const onToggle = vi.fn();
    render(<CompareAgentChips agents={compareOptions().agents} slots={['u-lak', 'u-ravi', 'u-priya']} onToggle={onToggle} />);
    const arjun = screen.getAllByTestId('compare-agent-chip')[3]!;
    expect(arjun.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(arjun);
    expect(onToggle).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByTestId('compare-agent-chip')[0]!);
    expect(onToggle).toHaveBeenCalledWith('u-lak');
    expect(screen.getByText(/3 agents is the most that stays readable/)).toBeTruthy();
  });

  it('groups the calls in a chip’s tooltip the house way', () => {
    const [lak] = compareOptions().agents;
    render(<CompareAgentChips agents={[{ ...lak!, calls: 12345 }, { ...lak!, agent_user_id: 'u-one', name: 'Uma R', calls: 1 }]} slots={[null, null, null]} onToggle={vi.fn()} />);
    const [many, one] = screen.getAllByTestId('compare-agent-chip');
    expect(many!.getAttribute('title')).toBe('Lakshmi P: 12,345 calls on this campaign in this window');
    expect(one!.getAttribute('title')).toBe('Uma R: 1 call on this campaign in this window');
  });

  it('gives a picked chip its slot’s colour', () => {
    render(<CompareAgentChips agents={compareOptions().agents} slots={[null, 'u-priya', null]} onToggle={vi.fn()} />);
    const priya = screen.getAllByTestId('compare-agent-chip')[2]!;
    expect(priya.getAttribute('aria-pressed')).toBe('true');
    expect((priya.querySelector('span') as HTMLElement).style.background).toBe('var(--cmp-agent-2)');
  });
});
