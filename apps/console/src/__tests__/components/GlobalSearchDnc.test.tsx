import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * How the Do Not Call list presents itself in the command palette.
 *
 * It used to be "Agency Do Not Call", because the palette opened inside a second shell where
 * nothing said which surface a result belonged to. There is one shell now (B28), and the sidebar
 * and the page both say "Do Not Call", so the palette does too. What stays: `compliance` and
 * `opt out` are not words for it, because the list binds the dialler only and someone typing
 * those is asking a wider question than this page answers.
 */

const mocks = vi.hoisted(() => ({
  useFeatureFlags: vi.fn(),
  useGovernance: vi.fn(),
}));

vi.mock('../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: mocks.useFeatureFlags }));
vi.mock('../../contexts/GovernanceContext', () => ({ useGovernance: mocks.useGovernance }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: () => ({ role: 'account_admin' }) }));

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
  return screen.getByRole('dialog', { name: 'Search' });
}

function search(dialog: HTMLElement, query: string) {
  fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: query } });
}

const dnc = (dialog: HTMLElement) => within(dialog).queryByRole('option', { name: /^Do Not Call/ });

describe('the Do Not Call entry', () => {
  it('reads as the sidebar names it', () => {
    const dialog = openPalette();
    expect(dnc(dialog)).not.toBeNull();
  });

  it('is still found by the words an operator actually types', () => {
    // Someone looking for the suppression list has to land on it.
    for (const query of ['do not call', 'dnc', 'suppress', 'blocklist']) {
      cleanup();
      const dialog = openPalette();
      search(dialog, query);
      expect(dnc(dialog), query).not.toBeNull();
    }
  });

  it('is not offered as the answer to "compliance"', () => {
    // The misreading: this list binds agency dialling only, so presenting it to
    // someone asking a wider compliance question tells them every kind of call
    // honours it. Only agency dialling does.
    const dialog = openPalette();
    search(dialog, 'compliance');
    expect(dnc(dialog)).toBeNull();
  });

  it('is not offered as the answer to "opt out" either', () => {
    const dialog = openPalette();
    search(dialog, 'opt out');
    expect(dnc(dialog)).toBeNull();
  });
});
