import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CampaignViewSwitch } from '../../components/agency/CampaignViewSwitch';

/** The one segmented control behind Call log's views and the Calls tab's "Summary | Live". */

afterEach(cleanup);

const CALLS = [
  { id: 'calls', label: 'Summary' },
  { id: 'live', label: 'Live' },
] as const;

function renderSwitch(props: Partial<Parameters<typeof CampaignViewSwitch<'calls' | 'live'>>[0]> = {}) {
  return render(
    <MemoryRouter>
      <CampaignViewSwitch
        campaignId="c-1"
        views={CALLS}
        active="calls"
        ariaLabel="Calls views"
        testId="views"
        linkTestIdPrefix="view"
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('CampaignViewSwitch', () => {
  it('links each view to its own URL, the one showing marked current', () => {
    renderSwitch();
    expect(screen.getByRole('navigation', { name: 'Calls views' })).toBeTruthy();
    expect(screen.getByTestId('view-calls').getAttribute('href')).toBe('/agency/campaigns/c-1/calls');
    expect(screen.getByTestId('view-calls').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('view-live').getAttribute('href')).toBe('/agency/campaigns/c-1/calls/live');
    expect(screen.getByTestId('view-live').getAttribute('aria-current')).toBeNull();
  });

  it('carries the range to a panel view only, and shows a count, 0 included, where given', () => {
    renderSwitch({ search: '?range=today', counts: { live: 0 } });
    expect(screen.getByTestId('view-calls').getAttribute('href')).toBe('/agency/campaigns/c-1/calls?range=today');
    expect(screen.getByTestId('view-live').getAttribute('href')).toBe('/agency/campaigns/c-1/calls/live');
    expect(screen.getByTestId('view-live').textContent).toBe('Live 0');
    expect(screen.getByTestId('view-calls').textContent).toBe('Summary');
  });

  it('renders nothing with one view left to choose', () => {
    renderSwitch({ views: [CALLS[0]] });
    expect(screen.queryByTestId('views')).toBeNull();
  });
});
