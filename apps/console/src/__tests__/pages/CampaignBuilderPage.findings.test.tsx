import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * A setting that stops the campaign saving, as an operator meets it.
 *
 * Save is disabled while the form finds anything. Before this, a finding only showed on its
 * field after a save attempt, which a disabled Save can never make: the operator saw "Fix the
 * highlighted fields" with nothing highlighted, on a step that did not hold the finding. The
 * campaign could not be saved and nothing said why. These pin each place the finding is now
 * said: on its field as soon as it exists, on the stepper, on Review, and beside Save.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getIngestLimits: vi.fn(),
  uploadRosterCsv: vi.fn(),
  analyzeRosterColumns: vi.fn(),
  startRosterIngest: vi.fn(),
  getIngestJob: vi.fn(),
  cancelIngestJob: vi.fn(),
  downloadRejectedRows: vi.fn(),
  createAgencyCampaign: vi.fn(),
  updateAgencyCampaign: vi.fn(),
  isCapabilityEnabled: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: mocks.isCapabilityEnabled, map: {}, loading: false, refresh: vi.fn() }),
}));
// The caller-ID picker is a hard gate on this page: The API rejects a campaign with
// an empty `caller_ids`, so nothing downstream runs until one is chosen.
vi.mock('../../hooks/usePhoneNumbers', () => ({
  usePhoneNumbers: () => ({
    phoneNumbers: [
      {
        phone_number_id: 'pn-1',
        phone_number: '+912200000001',
        provider_name: 'voicelink',
        provider_display_name: 'VoiceLink',
        label: 'Outbound 1',
        is_default: true,
      },
    ],
    loading: false,
    error: null,
    reload: vi.fn(),
    defaultNumber: '+912200000001',
  }),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  getIngestLimits: mocks.getIngestLimits,
  uploadRosterCsv: mocks.uploadRosterCsv,
  analyzeRosterColumns: mocks.analyzeRosterColumns,
  startRosterIngest: mocks.startRosterIngest,
  getIngestJob: mocks.getIngestJob,
  cancelIngestJob: mocks.cancelIngestJob,
  downloadRejectedRows: mocks.downloadRejectedRows,
  createAgencyCampaign: mocks.createAgencyCampaign,
  updateAgencyCampaign: mocks.updateAgencyCampaign,
}));

async function renderPage() {
  const { default: CampaignBuilderPage } = await import(
    '../../pages/campaigns/agency/CampaignBuilderPage'
  );
  return render(
    <MemoryRouter>
      <CampaignBuilderPage />
    </MemoryRouter>,
  );
}

/**
 * Name + caller ID, the two things the API requires before a campaign can exist.
 * `Save campaign` creates it on first use, so the config tests have to satisfy
 * both before they can assert anything about the config payload.
 */
function fillRequiredBasics() {
  fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Collections' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /\+912200000001/ }));
}

function goToStep(title: string) {
  fireEvent.click(screen.getByRole('button', { name: title }));
}

async function openBehaviour() {
  await renderPage();
  fillRequiredBasics();
  goToStep('How agents work');
}

async function openHours() {
  await renderPage();
  fillRequiredBasics();
  goToStep('When to call');
}

beforeEach(() => {
  mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId: 'a1' });
  mocks.isCapabilityEnabled.mockReturnValue(true);
  mocks.getIngestLimits.mockRejectedValue(new Error('not needed here'));
  mocks.createAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Collections', status: 'draft' });
  mocks.updateAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Collections', status: 'draft' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const PROMISE_AND_CALLBACK =
  'An outcome cannot ask for both a promise to pay and a callback time. To call the customer after the promised date, set a follow-up on the promise instead.';

/** Callback already needs a callback time; asking it for a promise too is the finding. */
function promiseBox() {
  const group = screen.getByRole('group', { name: 'Callback: promise to pay' });
  return within(group).getByRole('checkbox', { name: /Asks for a promise to pay/ }) as HTMLInputElement;
}

function askCallbackForAPromise(checked = true) {
  if (promiseBox().checked !== checked) fireEvent.click(promiseBox());
}

const saveButton = () => screen.getByRole('button', { name: 'Save campaign' }) as HTMLButtonElement;

describe('a finding on How agents work', () => {
  it('shows on its outcome as soon as it is made, not after a save attempt', async () => {
    await openBehaviour();
    expect(screen.queryByText(PROMISE_AND_CALLBACK)).toBeNull();

    askCallbackForAPromise();

    expect(screen.getByText(PROMISE_AND_CALLBACK)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByTestId('config-block').textContent).toBe('Fix the highlighted field to save.');
  });

  it('marks the step on the stepper and leaves the hours ticked', async () => {
    await openBehaviour();
    goToStep('When to call');
    goToStep('How agents work');
    askCallbackForAPromise();

    const stepper = screen.getByRole('navigation', { name: 'Campaign setup' });
    expect(within(stepper).getByRole('button', { name: 'How agents work, needs fixing' })).toBeTruthy();
    const hours = within(stepper).getByRole('button', { name: 'When to call' });
    expect(hours.getAttribute('data-complete')).toBe('true');
  });

  it('is named on Review: the row says what is wrong, Save says which step, and nothing is sent', async () => {
    await openBehaviour();
    askCallbackForAPromise();
    goToStep('Review & save');

    const review = screen.getByTestId('builder-review');
    const errors = within(review).getByTestId('review-row-errors');
    expect(errors.textContent).toBe(`Callback: ${PROMISE_AND_CALLBACK}`);
    expect(within(review).getByRole('button', { name: 'Fix Outcomes' })).toBeTruthy();
    // Rows without a finding keep their Edit.
    expect(within(review).getByRole('button', { name: 'Edit Hours' })).toBeTruthy();

    const block = screen.getByTestId('config-block');
    expect(block.textContent).toContain('Can’t save yet: 1 setting on How agents work needs fixing.');
    expect(within(block).getByRole('button', { name: 'Go to How agents work' })).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    expect(mocks.createAgencyCampaign).not.toHaveBeenCalled();
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();
  });

  it('“Fix” lands on the field to change, and the save goes once it is fixed', async () => {
    await openBehaviour();
    askCallbackForAPromise();
    goToStep('Review & save');

    fireEvent.click(screen.getByRole('button', { name: 'Fix Outcomes' }));
    expect(screen.getByTestId('builder-step').getAttribute('data-step')).toBe('behaviour');
    await waitFor(() => expect(document.activeElement).toBe(promiseBox()));

    askCallbackForAPromise(false);
    expect(screen.queryByTestId('config-block')).toBeNull();
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
  });

  it('“Go to” beside Save does the same from another step', async () => {
    await openBehaviour();
    askCallbackForAPromise();
    goToStep('When to call');

    const block = screen.getByTestId('config-block');
    fireEvent.click(within(block).getByRole('button', { name: 'Go to How agents work' }));
    expect(screen.getByTestId('builder-step').getAttribute('data-step')).toBe('behaviour');
    await waitFor(() => expect(document.activeElement).toBe(promiseBox()));
  });

  it('a new outcome says it needs a label straight away, and Review says which outcome', async () => {
    await openBehaviour();
    fireEvent.click(screen.getByRole('button', { name: /Add an outcome/ }));

    expect(screen.getAllByText('Every outcome needs a label — the agent reads it off a button.').length).toBe(1);
    goToStep('Review & save');
    const errors = within(screen.getByTestId('builder-review')).getByTestId('review-row-errors');
    expect(errors.textContent).toContain('Outcome 4: Every outcome needs a label');
  });
});

describe('Review shows the automatic outcomes for unanswered calls', () => {
  it('has a row for them, as the summary rail does, with a way back to the step', async () => {
    await openBehaviour();
    goToStep('Review & save');
    const review = screen.getByTestId('builder-review');
    expect(review.textContent).toContain('Unanswered calls');
    fireEvent.click(within(review).getByRole('button', { name: 'Edit Unanswered calls' }));
    expect(screen.getByTestId('builder-step').getAttribute('data-step')).toBe('behaviour');
  });
});

describe('a finding on When to call', () => {
  it('is named from How agents work, and Review marks the Hours row', async () => {
    await openHours();
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '09:00' } });
    goToStep('How agents work');
    expect(screen.getByTestId('config-block').textContent).toContain(
      'Can’t save yet: 1 setting on When to call needs fixing.',
    );
    goToStep('Review & save');
    expect(screen.getByRole('button', { name: 'Fix Hours' })).toBeTruthy();
  });
});
