import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * AnalysisProfilesPage — the "Call Summaries" editor.
 *
 * Mocks are declared per-module (never the components/common barrel — adding an
 * export to that barrel would break every page test that mocks it).
 */
const mocks = vi.hoisted(() => ({
  useCallAnalysisProfiles: vi.fn(),
  usePermission: vi.fn(),
  useTenant: vi.fn(),
  createCallAnalysisProfile: vi.fn(),
  updateCallAnalysisProfile: vi.fn(),
}));

vi.mock('../../hooks/useCallAnalysisProfiles', () => ({
  useCallAnalysisProfiles: mocks.useCallAnalysisProfiles,
}));
vi.mock('../../hooks/usePermission', () => ({ usePermission: mocks.usePermission }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/call-analysis-profiles', () => ({
  createCallAnalysisProfile: mocks.createCallAnalysisProfile,
  updateCallAnalysisProfile: mocks.updateCallAnalysisProfile,
}));

import AnalysisProfilesPage from '../../pages/settings/AnalysisProfilesPage';

function setupProfiles(overrides: Record<string, unknown> = {}) {
  const reload = vi.fn();
  const remove = vi.fn();
  mocks.useCallAnalysisProfiles.mockReturnValue({
    profiles: [],
    total: 0,
    defaultProfile: null,
    loading: false,
    error: null,
    reload,
    remove,
    ...overrides,
  });
  return { reload, remove };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AnalysisProfilesPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId: 'a1', role: 'account_admin' });
  mocks.usePermission.mockReturnValue(true);
  mocks.createCallAnalysisProfile.mockResolvedValue({ id: 'new' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AnalysisProfilesPage — empty + gating', () => {
  it('shows the empty state with a "New summary" CTA when there are no profiles', () => {
    setupProfiles();
    renderPage();
    expect(screen.getByText(/No call summaries set up yet/i)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /New summary/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('hides create/edit affordances when the user lacks write permission', () => {
    mocks.usePermission.mockReturnValue(false);
    setupProfiles();
    renderPage();
    // No New-summary button anywhere (header or empty state) for a read-only user.
    expect(screen.queryByRole('button', { name: /New summary/i })).toBeNull();
  });
});

describe('AnalysisProfilesPage — editor', () => {
  it('derives a snake_case key and filters incomplete rows on create', async () => {
    setupProfiles();
    renderPage();

    // Open the create modal.
    fireEvent.click(screen.getAllByRole('button', { name: /New summary/i })[0]!);

    // Name it.
    fireEvent.change(screen.getByLabelText(/Name/i), {
      target: { value: 'Collections calls' },
    });

    // Add two dimensions: one filled, one left blank (must be dropped).
    fireEvent.click(screen.getByRole('button', { name: /Add something to capture/i }));
    fireEvent.click(screen.getByRole('button', { name: /Add something to capture/i }));

    const captureInputs = screen.getAllByLabelText('What to capture');
    fireEvent.change(captureInputs[0]!, {
      target: { value: 'Whether the customer agreed to pay' },
    });
    // Second row deliberately left blank.

    fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));

    await waitFor(() => expect(mocks.createCallAnalysisProfile).toHaveBeenCalled());
    const [, payload] = mocks.createCallAnalysisProfile.mock.calls[0]!;
    expect(payload.name).toBe('Collections calls');
    // Only the completed row survives, keyed off its description.
    expect(payload.custom_dimensions).toHaveLength(1);
    expect(payload.custom_dimensions[0].key).toBe('whether_the_customer_agreed_to_pay');
  });

  it('shows a live preview line for a completed dimension before saving', () => {
    setupProfiles();
    renderPage();
    fireEvent.click(screen.getAllByRole('button', { name: /New summary/i })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /Add something to capture/i }));
    fireEvent.change(screen.getByLabelText('What to capture'), {
      target: { value: 'Payment date agreed' },
    });
    // The preview echoes the description with its plain-language answer type.
    expect(screen.getByText(/Payment date agreed/)).toBeTruthy();
    expect(screen.getByText(/a short piece of text/)).toBeTruthy();
  });

  it('blocks save with a friendly message when the name is empty', () => {
    setupProfiles();
    renderPage();
    fireEvent.click(screen.getAllByRole('button', { name: /New summary/i })[0]!);
    fireEvent.click(screen.getByRole('button', { name: /^Create$/i }));
    expect(screen.getByText(/Give this summary a name/i)).toBeTruthy();
    expect(mocks.createCallAnalysisProfile).not.toHaveBeenCalled();
  });
});

describe('AnalysisProfilesPage — a refused delete has to reach the operator', () => {
  /*
    Regression cover for a defect an adversarial review found, and the shape is
    worth stating because it is the sort that hides forever: the whole cross-service
    chain worked. Core answered 409 with a sentence whose entire content is the
    remedy, master's error mask deliberately allow-lists the code so it survives the
    hop unmasked — and then this page dropped it on the floor.

    `handleDeleteConfirm` caught the throw under the comment "Surfaced by the hook's
    error state", which was false: `useCallAnalysisProfiles`'s `error` is written
    only by `load`'s catch, and `load()` is never reached when `remove` rejects. The
    dialog closed, the row stayed, nothing was said. An operator pressing Delete
    twice and watching the row survive twice concludes the page is broken.

    That is the same outcome as masking the error, reached one hop later — which is
    why it is pinned at the last hop as well as the first.
  */
  const profileRow = {
    id: 'p1',
    name: 'Collections',
    description: '',
    context: '',
    custom_dimensions: [],
    is_default: true,
    is_active: true,
    version: 1,
  };

  const REFUSAL =
    '2 agency campaigns (2 running) use this profile directly, and 3 more rely on it as '
    + 'the account default. Point them at another profile, or clone this one, before deleting it.';

  async function openDeleteAndConfirm() {
    fireEvent.click(screen.getByLabelText('Delete Collections'));
    // The row button's accessible name is "Delete Collections" (aria-label), so an
    // exact "Delete" only ever matches the dialog's confirm button.
    const confirm = await waitFor(() => screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(confirm);
  }

  it("renders core's refusal verbatim rather than closing the dialog on silence", async () => {
    const remove = vi.fn().mockRejectedValue(new Error(REFUSAL));
    setupProfiles({ profiles: [profileRow], total: 1, defaultProfile: profileRow, remove });
    renderPage();

    await openDeleteAndConfirm();

    // The message itself, not a generic "couldn't delete": the counts and the
    // "clone this one" remedy ARE the answer, and substituting a sentence of our
    // own is the mask's behaviour reimplemented in the client.
    await waitFor(() => expect(screen.getByText(REFUSAL)).toBeTruthy());
    // And the row survives. A refusal that also dropped it from the list would be
    // worse than silence.
    expect(screen.getByLabelText('Delete Collections')).toBeTruthy();
  });

  it('falls back to a plain message only when the failure carries no body', async () => {
    const remove = vi.fn().mockRejectedValue('socket hang up');
    setupProfiles({ profiles: [profileRow], total: 1, defaultProfile: profileRow, remove });
    renderPage();

    await openDeleteAndConfirm();

    // A non-Error rejection is the transport case. It must still say SOMETHING —
    // an `instanceof Error` guard with no else branch is the original bug.
    await waitFor(() =>
      expect(screen.getByText('Failed to delete this summary setup')).toBeTruthy(),
    );
  });

  it('says nothing when the delete succeeds', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    setupProfiles({ profiles: [profileRow], total: 1, defaultProfile: profileRow, remove });
    renderPage();

    await openDeleteAndConfirm();

    await waitFor(() => expect(remove).toHaveBeenCalledWith('p1'));
    expect(screen.queryByText(/agency campaign/)).toBeNull();
    expect(screen.queryByText('Failed to delete this summary setup')).toBeNull();
  });

  it('clears a standing refusal when the operator starts the remedy it named', async () => {
    // The way out of this 409 is to clone the profile, which starts by opening the
    // editor. A refusal still on screen after that reads as a second, current
    // failure — and `ErrorAlert` has no dismiss affordance to offer instead.
    const remove = vi.fn().mockRejectedValue(new Error(REFUSAL));
    setupProfiles({ profiles: [profileRow], total: 1, defaultProfile: profileRow, remove });
    renderPage();

    await openDeleteAndConfirm();
    await waitFor(() => expect(screen.getByText(REFUSAL)).toBeTruthy());

    fireEvent.click(screen.getAllByRole('button', { name: /New summary/i })[0]!);

    expect(screen.queryByText(REFUSAL)).toBeNull();
  });
});
