import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * How the Do Not Call list presents itself in the command palette.
 *
 * The palette is reached from inside the `/app` zone, where no shell tells the
 * reader which surface a result belongs to — so the entry's own words are the
 * only scope it has. `compliance` and `opt out` were keywords on it, which made
 * the palette answer a wider question with an agency-only page.
 */

const mocks = vi.hoisted(() => ({
  useFeatureFlags: vi.fn(),
  useGovernance: vi.fn(),
}));

vi.mock('../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: mocks.useFeatureFlags }));
vi.mock('../../contexts/GovernanceContext', () => ({ useGovernance: mocks.useGovernance }));

import { GlobalSearch } from '../../components/common/GlobalSearch';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Agency on: the flag and the capability the entry is gated on. */
function openPalette() {
  mocks.useFeatureFlags.mockReturnValue({
    isEnabled: () => true,
    flags: {},
    status: 'ready' as const,
    reload: vi.fn(),
  });
  mocks.useGovernance.mockReturnValue({
    isEnabled: () => true,
    map: {},
    loading: false,
    refresh: () => {},
  });
  render(
    <MemoryRouter>
      <GlobalSearch />
    </MemoryRouter>,
  );
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  return screen.getByRole('dialog', { name: /Quick navigation/i });
}

function search(dialog: HTMLElement, query: string) {
  fireEvent.change(within(dialog).getByLabelText('Search pages'), { target: { value: query } });
}

describe('the Do Not Call entry', () => {
  it('names the product it belongs to', () => {
    const dialog = openPalette();
    expect(within(dialog).getByText('Agency Do Not Call')).toBeTruthy();
  });

  it('is still found by the words an operator actually types', () => {
    // Narrowing the entry must not make it unfindable — someone looking for the
    // suppression list has to land on it.
    for (const query of ['do not call', 'dnc', 'suppress', 'blocklist']) {
      cleanup();
      const dialog = openPalette();
      search(dialog, query);
      expect(within(dialog).getByText('Agency Do Not Call'), query).toBeTruthy();
    }
  });

  it('is not offered as the answer to "compliance"', () => {
    // The misreading: this list binds agency dialing only, so presenting it to
    // someone asking a wider compliance question tells them every kind of call
    // honours it. Only agency dialing does.
    const dialog = openPalette();
    search(dialog, 'compliance');
    expect(within(dialog).queryByText('Agency Do Not Call')).toBeNull();
  });

  it('is not offered as the answer to "opt out" either', () => {
    const dialog = openPalette();
    search(dialog, 'opt out');
    expect(within(dialog).queryByText('Agency Do Not Call')).toBeNull();
  });
});
