import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SetupCard, SetupColumns, SetupSection, StatusChip, StatusChipRow } from '../../../components/campaign-setup';

/** The step panel, its sections and columns, and the status chips. */

describe('SetupCard', () => {
  it('is a region named by its heading, which can take focus on a step change', () => {
    const ref = createRef<HTMLHeadingElement>();
    render(
      <SetupCard title="Customers" helper="Upload the list." headingRef={ref} testId="card">
        <SetupSection title="Your file" helper="CSV only for now.">
          <p>Body</p>
        </SetupSection>
      </SetupCard>,
    );
    expect(screen.getByRole('region', { name: 'Customers' })).toBe(screen.getByTestId('card'));
    const heading = screen.getByRole('heading', { level: 2, name: 'Customers' });
    expect(ref.current).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('heading', { level: 3, name: 'Your file' })).toBeTruthy();
  });

  it('renders a third-level heading when asked', () => {
    render(
      <SetupCard title="Advanced" headingLevel={3}>
        <p>Body</p>
      </SetupCard>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Advanced' })).toBeTruthy();
  });

  it('lays out its children as columns', () => {
    render(
      <SetupColumns testId="cols" split="main-aside">
        <div>Buttons</div>
        <div>Preview</div>
      </SetupColumns>,
    );
    const grid = screen.getByTestId('cols').firstElementChild as HTMLElement;
    expect(grid.getAttribute('data-split')).toBe('main-aside');
    expect(grid.children).toHaveLength(2);
  });
});

describe('SetupCard density', () => {
  it('marks a slim card, and leaves a regular one unmarked', () => {
    render(
      <>
        <SetupCard density="slim" testId="slim">Start from</SetupCard>
        <SetupCard testId="regular">Customers</SetupCard>
      </>,
    );
    expect(screen.getByTestId('slim').getAttribute('data-density')).toBe('slim');
    expect(screen.getByTestId('regular').hasAttribute('data-density')).toBe(false);
  });
});

describe('StatusChip', () => {
  it('carries its tone, a default icon, and an action', () => {
    render(
      <StatusChipRow live testId="chips">
        <StatusChip tone="success" testId="ready">
          1,240 customers ready
        </StatusChip>
        <StatusChip tone="warning" icon={null} action={<button type="button">Download</button>} testId="bad">
          12 rows have a bad phone number. They will be left out
        </StatusChip>
      </StatusChipRow>,
    );
    expect(screen.getByTestId('chips').getAttribute('aria-live')).toBe('polite');
    const ready = screen.getByTestId('ready');
    expect(ready.getAttribute('data-tone')).toBe('success');
    expect(ready.querySelector('svg')).not.toBeNull();
    const bad = screen.getByTestId('bad');
    expect(bad.querySelector('svg')).toBeNull();
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
  });
});
