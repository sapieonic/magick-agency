import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SectionSource, sectionSourcesOf } from '../../components/agency/campaignTemplates/SectionSource';

/** A template section's chip and Reset, as New campaign places them at each block (CS18). */

afterEach(cleanup);

describe('SectionSource', () => {
  it('names where the section came from, with no Reset while it is the template’s', () => {
    render(<SectionSource section="hours" source="account" onReset={vi.fn()} />);
    const chip = screen.getByTestId('section-source-chip');
    expect(chip.textContent).toBe('Account template');
    expect(chip.getAttribute('data-source')).toBe('account');
    expect(screen.queryByRole('button')).toBeNull();
    // Read with the section's name, which the chip alone does not say.
    expect(screen.getByTestId('section-source-hours').textContent).toBe('Calling hours: Account template');
  });

  it('says each source in words', () => {
    for (const [source, words] of [
      ['organisation', 'Organisation template'],
      ['builtin', 'Built-in'],
      ['campaign', 'Changed for this campaign'],
    ] as const) {
      render(<SectionSource section="wrapup" source={source} />);
      expect(screen.getByTestId('section-source-chip').textContent).toBe(words);
      cleanup();
    }
  });

  it('offers Reset once changed, named by the section', () => {
    const onReset = vi.fn();
    render(<SectionSource section="agent_screen" source="campaign" onReset={onReset} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset what agents see to the template' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('shows nothing without a source (no template, or numbers left to the operator)', () => {
    const { container } = render(<SectionSource section="numbers" source={null} onReset={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('sectionSourcesOf', () => {
  it('gives one piece per section with a template, and nothing without one', () => {
    const sourceProps = vi.fn(() => ({ source: 'builtin' as const, onReset: vi.fn() }));
    expect(sectionSourcesOf(false, sourceProps)).toBeUndefined();
    const pieces = sectionSourcesOf(true, sourceProps)!;
    expect(Object.keys(pieces).sort()).toEqual(
      ['agent_screen', 'assignment', 'breaks', 'hours', 'inbound', 'numbers', 'outcomes', 'recording', 'retries', 'safety', 'wrapup'],
    );
    render(<>{pieces.retries}</>);
    expect(screen.getByTestId('section-source-retries')).toBeTruthy();
  });
});
