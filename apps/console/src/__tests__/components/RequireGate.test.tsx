import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

/**
 * `RequireGate`: a route's guards read from its navigation entry's gate. Each capability, then
 * each flag, outermost first (the order the hand-written guards had); the permission and the rest
 * of the gate are the page's and the link's, not the route's.
 */

vi.mock('../../components/auth/RequireCapability', () => ({
  default: ({ capability, children }: { capability: string; children: ReactNode }) => (
    <div data-testid="guard" data-guard={`capability:${capability}`}>{children}</div>
  ),
}));
vi.mock('../../components/auth/RequireFlag', () => ({
  default: ({ flag, children }: { flag: string; children: ReactNode }) => (
    <div data-testid="guard" data-guard={`flag:${flag}`}>{children}</div>
  ),
}));

import RequireGate from '../../components/auth/RequireGate';
import { SETTINGS_ENTRIES, settingsEntry } from '../../utils/consoleNav';

const guards = () => screen.queryAllByTestId('guard').map((el) => el.getAttribute('data-guard'));

describe('RequireGate', () => {
  it('wraps the page in each capability, then each flag, outermost first', () => {
    render(
      <RequireGate gate={{ permission: 'agency.supervise', capabilities: ['agency', 'agency.analytics'], flags: ['a_flag', 'b_flag'], agentLanding: true }}>
        <p>PAGE</p>
      </RequireGate>,
    );
    expect(guards()).toEqual(['capability:agency', 'capability:agency.analytics', 'flag:a_flag', 'flag:b_flag']);
    expect(screen.getAllByTestId('guard').at(-1)!.contains(screen.getByText('PAGE'))).toBe(true);
  });

  it('renders the page unguarded for a gate with no capability or flag', () => {
    render(<RequireGate gate={settingsEntry('team').gate}><p>PAGE</p></RequireGate>);
    expect(guards()).toEqual([]);
    expect(screen.getByText('PAGE').textContent).toBe('PAGE');
  });

  it('finds every Settings entry by id, and refuses an unknown one', () => {
    for (const entry of SETTINGS_ENTRIES) expect(settingsEntry(entry.id)).toBe(entry);
    expect(() => settingsEntry('nope')).toThrow();
  });
});
