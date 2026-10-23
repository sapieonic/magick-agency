import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentNav } from '../../components/agency/AgentNav';
import { StationHeader } from '../../components/agency/StationHeader';
import { DEFAULT_CUE_PREFS } from '../../utils/agencyCuePrefs';

/**
 * The agent's surfaces (`/station`, `/dialer`, `/dialer/performance`, `/dialer/attempts`) run
 * full-viewport, outside both shells, so no sidebar carries the version there. `AgentNav`
 * (the three `/dialer` pages) and the station header carry it instead, inline and as a plain
 * label: nothing focusable, so the tab order agents rely on does not move.
 */
const { version } = JSON.parse(
  readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8'),
) as { version: string };

describe('the version on the agent surfaces', () => {
  it('ends the agent nav, after every destination, and is not a link', () => {
    render(<MemoryRouter><AgentNav current="campaigns" /></MemoryRouter>);
    const nav = screen.getByRole('navigation', { name: 'Your screens' });
    const label = within(nav).getByTestId('app-version');
    expect(label.textContent).toBe(`v${version}`);
    expect(nav.lastElementChild?.contains(label)).toBe(true);
    expect(label.closest('a')).toBeNull();
  });

  it('ends the station header, with nothing focusable added', () => {
    render(
      <MemoryRouter>
        <StationHeader
          user={{ display_name: 'Asha', email: 'asha@example.com', avatar_url: null }}
          campaignName="Renewals"
          recordCalls={false}
          muted={false}
          cuePrefs={DEFAULT_CUE_PREFS}
          onCuePrefsChange={vi.fn()}
          agentState="available"
          canExit={false}
          leaving={false}
          onLeave={vi.fn()}
          onExit={vi.fn()}
          connection="open"
          missedPings={0}
        />
      </MemoryRouter>,
    );
    const label = screen.getByTestId('app-version');
    expect(label.textContent).toBe(`v${version}`);
    expect(label.closest('button, a, [tabindex]')).toBeNull();
  });
});
