import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import {
  applied,
  currentStep,
  fillBasics,
  footer,
  goToStep,
  openFold,
  renderPage,
  saveDraftButton,
  stepCard,
  staffingHook,
} from './campaignBuilderFixtures';

/**
 * A setting that holds the save, with no Review step (CS1): shown on its field as it is made,
 * marked on its step card, and named beside Save with a way to it ("Show me" on its own step,
 * "Go to …" from another), held back while Name & number is incomplete. And a refusal from the
 * server, sent to the step that has its field.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getIngestLimits: vi.fn(),
  createAgencyCampaign: vi.fn(),
  updateAgencyCampaign: vi.fn(),
  applyStaffing: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: () => true, map: {}, loading: false, refresh: vi.fn() }),
}));
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
vi.mock('../../hooks/useCampaignStaffing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useCampaignStaffing')>()),
  useCampaignStaffing: () => staffingHook(mocks.applyStaffing),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  getIngestLimits: mocks.getIngestLimits,
  uploadCustomerFile: vi.fn(),
  analyzeRosterColumns: vi.fn(),
  startRosterIngest: vi.fn(),
  getIngestJob: vi.fn(),
  cancelIngestJob: vi.fn(),
  downloadRejectedRows: vi.fn(),
  downloadSkippedRows: vi.fn(),
  importCheckedFile: vi.fn(),
  createAgencyCampaign: mocks.createAgencyCampaign,
  updateAgencyCampaign: mocks.updateAgencyCampaign,
  transitionAgencyCampaign: vi.fn(),
}));

beforeEach(() => {
  mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId: 'a1' });
  mocks.getIngestLimits.mockRejectedValue(new Error('not needed here'));
  mocks.createAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Collections', status: 'draft' });
  mocks.updateAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Collections', status: 'draft' });
  mocks.applyStaffing.mockResolvedValue(applied());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openPurpose() {
  await renderPage();
  fillBasics();
  goToStep('Purpose & buttons');
}

const PROMISE_AND_CALLBACK =
  'An outcome cannot ask for both a promise to pay and a callback time. To call the customer after the promised date, set a follow-up on the promise instead.';

/** Callback already needs a callback time; asking it for a promise too is the finding. */
function promiseBox() {
  const group = screen.getByRole('group', { name: 'Callback: promise to pay' });
  return within(group).getByRole('checkbox', { name: /Asks for a promise to pay/ }) as HTMLInputElement;
}

/** Made in the full editor, under step 3's Advanced. */
function askCallbackForAPromise(checked = true) {
  openFold('purpose-advanced');
  if (promiseBox().checked !== checked) fireEvent.click(promiseBox());
}

/** The live finding's paragraphs (the button's sentence above, the full editor below). */
const findingTexts = () => screen.getAllByText(PROMISE_AND_CALLBACK);

describe('a finding on Purpose & buttons', () => {
  it('shows on its outcome as soon as it is made, not after a save attempt', async () => {
    await openPurpose();
    expect(screen.queryByText(PROMISE_AND_CALLBACK)).toBeNull();

    askCallbackForAPromise();

    // Shown, linked to its field, and not announced as an alert while the form is edited.
    const finding = findingTexts().map((node) => node.closest('p')!).find((p) => promiseBox().getAttribute('aria-describedby')?.includes(p.id));
    expect(finding).toBeTruthy();
    expect(finding!.getAttribute('role')).toBeNull();
    expect(saveDraftButton().disabled).toBe(true);
    expect(screen.getByTestId('config-block').textContent).toBe('Fix the highlighted field to save. Show me');
  });

  it('“Show me” on the same step takes focus to a field with the finding, wherever it has been scrolled', async () => {
    await openPurpose();
    askCallbackForAPromise();
    // Somewhere else on the step, as after scrolling away.
    const elsewhere = screen.getByTestId('button-add');
    elsewhere.focus();

    fireEvent.click(within(screen.getByTestId('config-block')).getByRole('button', { name: /^Show the setting that stops/ }));
    const focused = document.activeElement as HTMLElement;
    expect(focused).not.toBe(elsewhere);
    const describedBy = (focused.getAttribute('aria-describedby') ?? '').split(/\s+/);
    const findingIds = findingTexts().map((node) => node.closest('p')!.id);
    expect(describedBy.some((id) => findingIds.includes(id))).toBe(true);
  });

  it('marks the step card, and leaves a visited Agents & timing ticked', async () => {
    await openPurpose();
    goToStep('Agents & timing');
    goToStep('Purpose & buttons');
    askCallbackForAPromise();

    expect(stepCard('Purpose & buttons').getAttribute('aria-label')).toBe('Purpose & buttons, needs fixing');
    expect(stepCard('Agents & timing').getAttribute('data-complete')).toBe('true');
  });

  it('is named beside Save from another step, with Go to, and nothing is sent', async () => {
    await openPurpose();
    askCallbackForAPromise();
    goToStep('Agents & timing');

    const block = screen.getByTestId('config-block');
    expect(block.textContent).toContain('Can’t save yet: 1 setting on Purpose & buttons needs fixing.');
    expect(within(block).getByRole('button', { name: /^Go to Purpose & buttons/ })).toBeTruthy();
    expect(saveDraftButton().disabled).toBe(true);
    expect((footer().getByRole('button', { name: 'Start campaign' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.createAgencyCampaign).not.toHaveBeenCalled();
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();
  });

  it('“Go to” lands on a field with the finding, and the save goes once it is fixed', async () => {
    await openPurpose();
    askCallbackForAPromise();
    goToStep('Agents & timing');

    fireEvent.click(within(screen.getByTestId('config-block')).getByRole('button', { name: /^Go to Purpose & buttons/ }));
    expect(currentStep()).toBe('purpose');
    await waitFor(() => {
      const describedBy = ((document.activeElement as HTMLElement).getAttribute('aria-describedby') ?? '').split(/\s+/);
      const findingIds = findingTexts().map((node) => node.closest('p')!.id);
      expect(describedBy.some((id) => findingIds.includes(id))).toBe(true);
    });

    askCallbackForAPromise(false);
    expect(screen.queryByTestId('config-block')).toBeNull();
    expect(saveDraftButton().disabled).toBe(false);
    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
  });

  it('a new button says it needs a name straight away, and holds the save', async () => {
    await openPurpose();
    openFold('purpose-advanced');
    fireEvent.click(screen.getByRole('button', { name: /Add an outcome/ }));
    expect(screen.getAllByText('Every outcome needs a label — the agent reads it off a button.').length).toBeGreaterThan(0);
    expect(saveDraftButton().disabled).toBe(true);
    expect(stepCard('Purpose & buttons').getAttribute('aria-label')).toBe('Purpose & buttons, needs fixing');
  });
});

describe('“Go to” and the Name & number gate', () => {
  it('is not offered while Name & number is incomplete, since no other step opens until it is', async () => {
    await openPurpose();
    askCallbackForAPromise();
    goToStep('Name & number');
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: '' } });

    const block = screen.getByTestId('config-block');
    expect(block.textContent).toContain('Can’t save yet: 1 setting on Purpose & buttons needs fixing.');
    expect(within(block).queryByRole('button')).toBeNull();
  });
});

describe('a finding on the calling hours', () => {
  it('is named from Purpose & buttons as Agents & timing’s, and marks that card', async () => {
    await renderPage();
    fillBasics();
    goToStep('Agents & timing');
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '09:00' } });
    goToStep('Purpose & buttons');
    expect(screen.getByTestId('config-block').textContent).toContain(
      'Can’t save yet: 1 setting on Agents & timing needs fixing.',
    );
    expect(stepCard('Agents & timing').getAttribute('aria-label')).toBe('Agents & timing, needs fixing');
  });
});

describe('the automatic outcomes for unanswered calls', () => {
  it('are under Purpose & buttons’ Advanced, and not shown twice under Agents & timing’s', async () => {
    await openPurpose();
    const purposeFold = openFold('purpose-advanced');
    expect(within(purposeFold).getByRole('heading', { name: 'When a call is not answered' })).toBeTruthy();
    goToStep('Agents & timing');
    const agentsFold = openFold('advanced-settings');
    expect(within(agentsFold).queryByRole('heading', { name: 'When a call is not answered' })).toBeNull();
    expect(within(agentsFold).queryByText(/Unanswered calls/)).toBeNull();
  });
});

/*
  A refusal from the server lands on its field, on the step that has it: the calling window on
  Agents & timing, the catalogue and the automatic outcomes on Purpose & buttons (with its
  Advanced held open when the field is in there), the name and numbers on Name & number.
*/
describe('a save the server refuses', () => {
  function refuse(details: Record<string, string>) {
    mocks.updateAgencyCampaign.mockRejectedValueOnce(
      Object.assign(new Error('Validation Error'), { statusCode: 400, details: { error: 'Validation Error', details } }),
    );
  }

  it('sends a calling-window refusal to Agents & timing, on its field', async () => {
    refuse({ default_timezone: "default_timezone must be a full IANA zone name like 'America/New_York'." });
    await renderPage();
    fillBasics();
    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(currentStep()).toBe('agents'));
    // Custom opens itself, so the field the refusal is about is on screen, with the message beside it.
    const message = await screen.findByText(/must be a full IANA zone name/);
    expect(message.closest('.form-group')?.querySelector('#window-timezone')).toBeTruthy();
    expect(screen.queryByTestId('builder-error')).toBeNull();
  });

  it('sends a refusal of an automatic outcome to Purpose & buttons, with its Advanced open', async () => {
    refuse({ 'outcome_dispositions.busy': '“Do not call” stops calling the contact.' });
    await renderPage();
    fillBasics();
    goToStep('Agents & timing');
    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(currentStep()).toBe('purpose'));
    expect((screen.getByTestId('purpose-advanced') as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByText('“Do not call” stops calling the contact.')).toBeTruthy();
  });

  it('sends a refusal of a button to Purpose & buttons', async () => {
    refuse({ 'disposition_catalog[0].label': 'That label is too long.' });
    await renderPage();
    fillBasics();
    goToStep('Agents & timing');
    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(currentStep()).toBe('purpose'));
    expect(screen.getAllByText('That label is too long.').length).toBeGreaterThan(0);
  });

  it('says a refused name under the name, on Name & number, and marks that card', async () => {
    refuse({ name: 'A campaign with this name already exists.' });
    await renderPage();
    fillBasics();
    goToStep('Agents & timing');
    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(currentStep()).toBe('basics'));
    const message = screen.getByText('A campaign with this name already exists.');
    expect(message.getAttribute('role')).toBe('alert');
    expect((screen.getByLabelText(/Campaign name/) as HTMLInputElement).getAttribute('aria-describedby')).toContain(message.id);
    expect(stepCard('Name & number').getAttribute('aria-label')).toBe('Name & number, needs fixing');
    // Typing a new name retires it.
    fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Collections 2' } });
    expect(screen.queryByText('A campaign with this name already exists.')).toBeNull();
  });
});
