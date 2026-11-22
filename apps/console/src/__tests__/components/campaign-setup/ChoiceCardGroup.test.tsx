import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChoiceCardGroup, type ChoiceCardOption } from '../../../components/campaign-setup';

/** Selectable cards over real radio and checkbox inputs. */

type Purpose = 'collections' | 'sales' | 'survey';

const OPTIONS: readonly ChoiceCardOption<Purpose>[] = [
  { value: 'collections', title: 'Payment reminder', description: 'Collect what is due' },
  { value: 'sales', title: 'Sales / leads', aside: 'Hindi, English' },
  {
    value: 'survey',
    title: 'Survey / feedback',
    disabled: true,
    disabledReason: 'Your account cannot use this yet.',
  },
];

describe('ChoiceCardGroup, single', () => {
  it('is a named group of radios, the chosen one checked', () => {
    render(
      <ChoiceCardGroup legend="Starting point" hideLegend options={OPTIONS} value="sales" onChange={() => {}} />,
    );
    expect(screen.getByRole('group', { name: 'Starting point' })).toBeTruthy();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => r.checked)).toEqual([false, true, false]);
    expect(screen.getByRole('radio', { name: 'Payment reminder', description: 'Collect what is due' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Sales / leads', description: 'Hindi, English' })).toBeTruthy();
  });

  it('reports the card picked', () => {
    const onChange = vi.fn();
    render(<ChoiceCardGroup legend="Starting point" options={OPTIONS} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Payment reminder' }));
    expect(onChange).toHaveBeenCalledWith('collections');
  });

  it('disables an option and says why', () => {
    render(<ChoiceCardGroup legend="Starting point" options={OPTIONS} value={null} onChange={() => {}} />);
    const survey = screen.getByRole('radio', {
      name: 'Survey / feedback',
      description: 'Your account cannot use this yet.',
    }) as HTMLInputElement;
    expect(survey.disabled).toBe(true);
    expect(screen.getByText('Your account cannot use this yet.')).toBeTruthy();
  });

  it('disables every option when the group is disabled', () => {
    render(<ChoiceCardGroup legend="Starting point" options={OPTIONS} value={null} onChange={() => {}} disabled />);
    expect((screen.getByRole('group') as HTMLFieldSetElement).disabled).toBe(true);
  });
});

describe('ChoiceCardGroup, multi', () => {
  it('uses tick boxes and adds a card in the options’ order', () => {
    const onChange = vi.fn();
    render(
      <ChoiceCardGroup
        multiple
        legend="Agents"
        options={OPTIONS}
        value={['sales']}
        onChange={onChange}
      />,
    );
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, true, false]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Payment reminder' }));
    expect(onChange).toHaveBeenCalledWith(['collections', 'sales']);
  });

  it('removes a card that is unticked', () => {
    const onChange = vi.fn();
    render(
      <ChoiceCardGroup
        multiple
        legend="Agents"
        options={OPTIONS}
        value={['collections', 'sales']}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sales / leads' }));
    expect(onChange).toHaveBeenCalledWith(['collections']);
  });
});
