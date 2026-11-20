import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentNav } from '../../components/agency/AgentNav';
import { StationFrame } from '../../components/agency/station/StationFrame';

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

  it('ends the station’s top bar, with nothing focusable added', () => {
    const view = { screen: 'ready', tone: 'ready' as const, icon: 'headphones' as const, title: 'Ready', subtitle: null };
    render(
      <MemoryRouter>
        <StationFrame view={view} agentName="Asha" workName="Renewals" brandMark="MA" menu={<button type="button">More</button>}>
          <p>Body</p>
        </StationFrame>
      </MemoryRouter>,
    );
    const label = screen.getByTestId('app-version');
    expect(label.textContent).toBe(`v${version}`);
    expect(label.closest('header')?.lastElementChild?.contains(label)).toBe(true);
    expect(label.closest('button, a, [tabindex]')).toBeNull();
  });
});
