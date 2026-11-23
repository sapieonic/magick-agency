import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import type { AgencyPhoneDisplay } from '@magick-agency/contracts/agency';
import {
  AgentsTimingStep,
  readyLine,
  type AgentsTimingStepProps,
} from '../../../pages/campaigns/agency/setup/AgentsTimingStep';
import { emptyCampaignConfig, type CampaignConfigState } from '../../../utils/agencyCampaignConfigForm';
import { NO_ANALYSIS_PROFILE, type CampaignRecordingState } from '../../../utils/agencyCampaignRecording';
import type { StaffingAgent } from '../../../hooks/useCampaignStaffing';
import type { CallAnalysisProfile } from '../../../types/call-analysis-profile';

/**
 * Step 4, Agents & timing (CS10–CS14), as a supervisor meets it: controlled, so each test drives
 * it through a small stateful harness and reads what the page would be handed.
 */

const NOW = new Date('2026-11-22T06:00:00Z');

function agent(id: string, name: string): StaffingAgent {
  return {
    id,
    name,
    email: null,
    persona: 'Agent',
    avatar: { display_name: name, email: null, avatar_url: null },
    notSignedIn: false,
    inTeam: true,
  };
}

const AGENTS = [agent('u-asha', 'Asha Rao'), agent('u-ravi', 'Ravi Kumar'), agent('u-sunil', 'Sunil Das')];
const PROFILES = [
  { id: 'prof-default', name: 'Standard summary', is_default: true },
  { id: 'prof-collections', name: 'Collections dimensions', is_default: false },
] as CallAnalysisProfile[];

interface HarnessOptions {
  config?: Partial<CampaignConfigState>;
  selected?: string[];
  recording?: Partial<AgentsTimingStepProps['recording']>;
  recordingState?: CampaignRecordingState;
  agentScreen?: boolean;
  props?: Partial<AgentsTimingStepProps>;
}

interface Seen {
  config: CampaignConfigState;
  selected: string[];
  recording: CampaignRecordingState;
  screen: { dailyTarget: string; phoneDisplay: AgencyPhoneDisplay };
}

function renderStep(options: HarnessOptions = {}) {
  const seen = {} as Seen;
  function Harness() {
    const [config, setConfig] = useState<CampaignConfigState>({ ...emptyCampaignConfig(), ...options.config });
    const [selected, setSelected] = useState<string[]>(options.selected ?? ['u-asha', 'u-ravi']);
    const [rec, setRec] = useState<CampaignRecordingState>(options.recordingState ?? { record: false, profileId: NO_ANALYSIS_PROFILE });
    const [station, setStation] = useState<Seen['screen']>({ dailyTarget: '', phoneDisplay: 'full' });
    Object.assign(seen, { config, selected, recording: rec, screen: station });
    return (
      <AgentsTimingStep
        config={config}
        onChange={setConfig}
        fieldErrors={{}}
        mode="create"
        staffing={{ agents: AGENTS, selected, onChange: setSelected, loading: false, error: null, invitePath: '/settings/team' }}
        recording={{
          state: rec,
          onChange: setRec,
          recordingEnabled: true,
          analyticsEnabled: true,
          profiles: PROFILES,
          profilesLoading: false,
          profilesError: null,
          savedProfileId: null,
          ...options.recording,
        }}
        agentScreen={options.agentScreen === false ? undefined : { ...station, onChange: (patch) => setStation((s) => ({ ...s, ...patch })) }}
        now={NOW}
        {...options.props}
      />
    );
  }
  render(
    <MemoryRouter>
      <Harness />
    </MemoryRouter>,
  );
  return seen;
}

const fold = () => screen.getByTestId('advanced-settings') as HTMLDetailsElement;

/** A sentence as it reads on screen: each select as its chosen option. */
function sentence(testId: string): string {
  const original = screen.getByTestId(testId);
  const chosen = Array.from(original.querySelectorAll('select'), (select) => select.selectedOptions[0]?.textContent ?? '');
  const copy = original.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('select').forEach((select, i) => select.replaceWith(chosen[i]!));
  return copy.textContent ?? '';
}

afterEach(cleanup);

describe('Who will call', () => {
  it('lists the agents as tick cards under how many are picked', () => {
    const seen = renderStep();
    const card = screen.getByTestId('who-will-call');
    expect(within(card).getByRole('heading', { name: 'Who will call' })).toBeTruthy();
    expect(within(card).getByText('2 agents picked.')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sunil Das' }));
    expect(seen.selected).toEqual(['u-asha', 'u-ravi', 'u-sunil']);
    expect(within(card).getByText('3 agents picked.')).toBeTruthy();
  });

  it('says how customers reach them for the campaign’s assignment mode', () => {
    renderStep();
    expect(screen.getByTestId('staffing-hint').textContent).toBe(
      'Any free agent takes the next customer. Call-backs go to whichever agent is free when they are due.',
    );
    cleanup();
    renderStep({ config: { assignment: { ...emptyCampaignConfig().assignment, mode: 'preferred' } } });
    expect(screen.getByTestId('staffing-hint').textContent).toMatch(/A call-back goes to the agent who booked it\./);
  });
});

describe('When to call', () => {
  it('offers the three windows and Custom, with today’s 9 AM – 8 PM chosen', () => {
    renderStep();
    const presets = screen.getByTestId('hours-presets');
    expect(within(presets).getAllByRole('radio').map((r) => r.parentElement?.textContent)).toEqual([
      '9 AM – 6 PM', '9 AM – 8 PM', '9 AM – 9 PM', 'Custom',
    ]);
    expect((within(presets).getByRole('radio', { name: '9 AM – 8 PM' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText('Start')).toBeNull();
    expect(screen.getByTestId('hours-zone').textContent).toBe('In each customer’s own time zone; Asia/Kolkata when it is not known.');
  });

  it('writes a preset’s hours and keeps the days and the time zone', () => {
    const seen = renderStep({ config: { window: { start: '09:00', end: '20:00', days: [1, 3], timezone: 'Europe/London' } } });
    fireEvent.click(screen.getByRole('radio', { name: '9 AM – 6 PM' }));
    expect(seen.config.window).toEqual({ start: '09:00', end: '18:00', days: [1, 3], timezone: 'Europe/London' });
  });

  it('opens start, end and time zone on Custom, without a second set of days', () => {
    const seen = renderStep();
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    const start = screen.getByLabelText('Start') as HTMLInputElement;
    expect(start.value).toBe('09:00');
    expect(screen.getByLabelText('Default timezone')).toBeTruthy();
    expect(screen.getAllByRole('group', { name: 'Calling days' })).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '18:00' } });
    // Still Custom, though the hours now equal a preset: the supervisor chose Custom.
    expect((screen.getByRole('radio', { name: 'Custom' }) as HTMLInputElement).checked).toBe(true);
    expect(seen.config.window.end).toBe('18:00');
  });

  it('shows a loaded window that is no preset as Custom', () => {
    renderStep({ config: { window: { start: '10:30', end: '19:00', days: [1, 2, 3, 4, 5], timezone: 'Asia/Kolkata' } } });
    expect((screen.getByRole('radio', { name: 'Custom' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Start') as HTMLInputElement).value).toBe('10:30');
  });

  it('opens Custom when the hours need fixing, so the finding can be seen', () => {
    renderStep({ props: { fieldErrors: { default_timezone: 'Use a time zone like Asia/Kolkata.' } } });
    expect((screen.getByRole('radio', { name: 'Custom' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Use a time zone like Asia/Kolkata.')).toBeTruthy();
  });

  it('turns the days on and off as pills', () => {
    const seen = renderStep();
    const days = screen.getByRole('group', { name: 'Calling days' });
    const sunday = within(days).getByRole('button', { name: 'Sunday' });
    expect(sunday.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(sunday);
    expect(seen.config.window.days).toEqual([1, 2, 3, 4, 5, 7]);
    fireEvent.click(within(days).getByRole('button', { name: 'Monday' }));
    expect(seen.config.window.days).toEqual([2, 3, 4, 5, 7]);
  });
});

describe('If the customer doesn’t pick up', () => {
  const SAME = {
    no_answer: { max_attempts: 3, delay_minutes: 120 },
    busy: { max_attempts: 3, delay_minutes: 120 },
    failed: { max_attempts: 3, delay_minutes: 120 },
    agent_disconnected: { max_attempts: 2, delay_minutes: 5 },
  };

  it('is one sentence while the three results share a rule', () => {
    renderStep({ config: { retryPolicy: SAME } });
    expect(sentence('unanswered-sentence')).toBe('Make up to 3 calls in all, 2 hours apart.');
  });

  it('writes a choice to no answer, busy and failed only', () => {
    const seen = renderStep({ config: { retryPolicy: SAME } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Calls in all to a customer who doesn’t pick up' }), { target: { value: '5' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Time between calls' }), { target: { value: '240' } });
    expect(seen.config.retryPolicy).toEqual({
      no_answer: { max_attempts: 5, delay_minutes: 240 },
      busy: { max_attempts: 5, delay_minutes: 240 },
      failed: { max_attempts: 5, delay_minutes: 240 },
      agent_disconnected: { max_attempts: 2, delay_minutes: 5 },
    });
  });

  it('leaves the time between calls out when there is no second call', () => {
    renderStep({ config: { retryPolicy: { no_answer: { max_attempts: 1 }, busy: { max_attempts: 1 }, failed: { max_attempts: 1 } } } });
    expect(sentence('unanswered-sentence')).toBe('Make up to 1 call in all.');
    expect(screen.queryByRole('combobox', { name: 'Time between calls' })).toBeNull();
  });

  it('says when the results differ (a new campaign’s defaults do), links to Advanced and offers one rule', () => {
    const seen = renderStep();
    const mixed = screen.getByTestId('unanswered-mixed');
    expect(within(mixed).getByText('Different rules for no answer, busy and calls that can’t connect.')).toBeTruthy();
    expect(within(mixed).getByText('Busy or switched off: up to 4 calls in all, 15 minutes apart (default)')).toBeTruthy();
    expect(fold().open).toBe(false);
    fireEvent.click(within(mixed).getByRole('button', { name: 'See them in Advanced settings' }));
    expect(fold().open).toBe(true);
    fireEvent.click(within(mixed).getByRole('button', { name: 'Use one rule for all' }));
    expect(sentence('unanswered-sentence')).toBe('Make up to 3 calls in all, 1 hour apart.');
    expect(seen.config.retryPolicy.busy).toEqual({ max_attempts: 3, delay_minutes: 60 });
  });
});

describe('Agent screen', () => {
  it('sets the time to choose “What happened?” from the choices, and leaves the seconds box out of Advanced', () => {
    const seen = renderStep();
    const select = screen.getByRole('combobox', { name: 'Time to choose what happened after each call' }) as HTMLSelectElement;
    expect(select.value).toBe('30');
    expect(within(select).getByRole('option', { name: 'No time' })).toBeTruthy();
    fireEvent.change(select, { target: { value: '60' } });
    expect(seen.config.wrapupSeconds).toBe(60);
    expect(within(fold()).queryByLabelText(/Wrap-up seconds/)).toBeNull();
    expect(within(fold()).getByText(/Send agents back to the pool automatically/)).toBeTruthy();
  });

  it('records calls with the switch while the account may record', () => {
    const seen = renderStep();
    fireEvent.click(screen.getByRole('switch', { name: 'Record calls' }));
    expect(seen.recording.record).toBe(true);
  });

  it('locks recording, saying why, when the account may not record', () => {
    renderStep({ recording: { recordingEnabled: false } });
    const sw = screen.getByRole('switch', { name: 'Record calls' }) as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(screen.getByTestId('record-row').textContent).toContain('Call recording is turned off for this account');
  });

  it('still lets a campaign that records switch it off when the account lost recording', () => {
    const seen = renderStep({ recording: { recordingEnabled: false }, recordingState: { record: true, profileId: NO_ANALYSIS_PROFILE } });
    const sw = screen.getByRole('switch', { name: 'Record calls' }) as HTMLButtonElement;
    expect(sw.disabled).toBe(false);
    fireEvent.click(sw);
    expect(seen.recording.record).toBe(false);
  });

  it('picks a call summary profile from the account’s list', () => {
    const seen = renderStep();
    const select = screen.getByRole('combobox', { name: 'Call summary' }) as HTMLSelectElement;
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'No summary', 'Standard summary (default)', 'Collections dimensions',
    ]);
    fireEvent.change(select, { target: { value: 'prof-collections' } });
    expect(seen.recording.profileId).toBe('prof-collections');
  });

  it('locks the call summary, saying why, when the account has no call summaries', () => {
    renderStep({ recording: { analyticsEnabled: false } });
    expect((screen.getByRole('combobox', { name: 'Call summary' }) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByTestId('summary-row').textContent).toContain(
      'Call summaries are turned off for this account. Ask an administrator to turn them on.',
    );
  });

  it('shows the whole number or hides it, and takes a daily target', () => {
    const seen = renderStep();
    const sw = screen.getByRole('switch', { name: 'Show full phone number to agents' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(seen.screen.phoneDisplay).toBe('masked');
    const target = screen.getByRole('textbox', { name: 'Daily target for each agent' });
    fireEvent.change(target, { target: { value: '40' } });
    expect(seen.screen.dailyTarget).toBe('40');
  });

  it('says what is wrong with a daily target as it is typed', () => {
    renderStep();
    const target = screen.getByRole('textbox', { name: 'Daily target for each agent' });
    fireEvent.change(target, { target: { value: 'lots' } });
    expect(target.getAttribute('aria-invalid')).toBe('true');
    expect(target.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('leaves the number and the target out when the page does not give them', () => {
    renderStep({ agentScreen: false });
    expect(screen.queryByRole('switch', { name: 'Show full phone number to agents' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Daily target for each agent' })).toBeNull();
  });

  it('offers nothing that does not exist here (CS14)', () => {
    renderStep();
    expect(screen.queryByText(/pre-pick/i)).toBeNull();
    expect(screen.queryByText(/\bAI\b/)).toBeNull();
  });
});

describe('Advanced settings', () => {
  it('is folded, and holds the retry table, the abandonment limit and wrap-up', () => {
    renderStep();
    expect(fold().open).toBe(false);
    expect(fold().querySelector('summary')?.textContent).toBe('Advanced settings (most campaigns don’t need these)');
    expect(within(fold()).getByRole('columnheader', { name: 'Max attempts' })).toBeTruthy();
    expect(within(fold()).getByTestId('abandonment-ceiling-input')).toBeTruthy();
    expect(within(fold()).getByTestId('allow-wrapup-redial')).toBeTruthy();
  });

  it('opens by itself when a finding lives inside it', () => {
    renderStep({ props: { fieldErrors: { 'retry_policy.busy.max_attempts': 'Set how many attempts — a whole number from 0 to 20.' } } });
    expect(fold().open).toBe(true);
  });

  it('opens when the page asks (a break-limit finding it holds)', () => {
    renderStep({ props: { forceAdvancedOpen: true } });
    expect(fold().open).toBe(true);
  });

  it('stays open once the page lets go of it, until the supervisor closes it', () => {
    const props: AgentsTimingStepProps = {
      config: emptyCampaignConfig(),
      onChange: vi.fn(),
      fieldErrors: {},
      mode: 'edit',
      staffing: { agents: AGENTS, selected: [], onChange: vi.fn(), loading: false, error: null },
      recording: {
        state: { record: false, profileId: NO_ANALYSIS_PROFILE },
        onChange: vi.fn(),
        recordingEnabled: true,
        analyticsEnabled: true,
        profiles: PROFILES,
        profilesLoading: false,
        profilesError: null,
        savedProfileId: null,
      },
      now: NOW,
    };
    const { rerender } = render(<MemoryRouter><AgentsTimingStep {...props} forceAdvancedOpen /></MemoryRouter>);
    expect(fold().open).toBe(true);
    rerender(<MemoryRouter><AgentsTimingStep {...props} forceAdvancedOpen={false} /></MemoryRouter>);
    expect(fold().open).toBe(true);
    fireEvent.click(fold().querySelector('summary')!);
    expect(fold().open).toBe(false);
  });

  it('puts the ids a link names on When to call, the agent screen, the retry rules and the agents’ rules', () => {
    renderStep({
      props: {
        anchors: { whenToCall: 'calling-hours', agentScreen: 'recording', retries: 'dialling-retries', agentRules: 'agents' },
        breakLimits: <p data-testid="break-limits">Break limits</p>,
      },
    });
    expect(document.getElementById('calling-hours')).toBe(screen.getByTestId('when-to-call'));
    expect(document.getElementById('recording')).toBe(screen.getByTestId('agent-screen'));
    const retries = document.getElementById('dialling-retries')!;
    expect(fold().contains(retries)).toBe(true);
    expect(retries.querySelector('[data-testid="abandonment-ceiling-input"]')).not.toBeNull();
    const rules = document.getElementById('agents')!;
    expect(fold().contains(rules)).toBe(true);
    expect(rules.querySelector('[data-testid="break-limits"]')).not.toBeNull();
    cleanup();
    // Nothing for the agents' rules to hold: no empty box.
    renderStep({ props: { anchors: { agentRules: 'agents' } } });
    expect(document.getElementById('agents')).toBeNull();
  });

  it('stays folded for a finding the step shows open', () => {
    renderStep({ props: { fieldErrors: { wrapup_seconds: 'Wrap-up is 0–600 seconds. 0 means no wrap-up.' } } });
    expect(fold().open).toBe(false);
    expect(screen.getByText('Wrap-up is 0–600 seconds. 0 means no wrap-up.')).toBeTruthy();
  });

  it('shows contact assignment and inbound callers only with their flags, and break limits when given', () => {
    renderStep();
    expect(within(fold()).queryByRole('group', { name: 'How contacts reach agents' })).toBeNull();
    expect(within(fold()).queryByTestId('inbound-sticky-enabled')).toBeNull();
    cleanup();
    renderStep({
      props: {
        assignment: { modeLocked: false },
        inbound: true,
        breakLimits: <p data-testid="break-limits">Break limits</p>,
      },
    });
    expect(within(fold()).getByRole('group', { name: 'How contacts reach agents' })).toBeTruthy();
    expect(within(fold()).getByTestId('inbound-sticky-enabled')).toBeTruthy();
    expect(within(fold()).getByTestId('break-limits')).toBeTruthy();
  });

  it('holds the automatic outcomes for unanswered calls unless the page leaves them out', () => {
    renderStep();
    expect(within(fold()).getByText(/filed on it automatically/)).toBeTruthy();
    cleanup();
    renderStep({ props: { unansweredOutcomes: false } });
    expect(within(fold()).queryByText(/filed on it automatically/)).toBeNull();
  });
});

describe('read only', () => {
  it('locks the ticks, the hours, the rule and the switches', () => {
    renderStep({ config: { retryPolicy: { no_answer: { max_attempts: 2 }, busy: { max_attempts: 2 }, failed: { max_attempts: 2 } } }, props: { readOnly: true } });
    expect((screen.getByRole('checkbox', { name: 'Asha Rao' }) as HTMLInputElement).closest('fieldset')?.disabled).toBe(true);
    expect((screen.getByTestId('hours-presets') as HTMLFieldSetElement).disabled).toBe(true);
    expect((screen.getByRole('combobox', { name: 'Calls in all to a customer who doesn’t pick up' }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole('switch', { name: 'Record calls' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('switch', { name: 'Show full phone number to agents' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('readyLine', () => {
  it('is exported for the footer', () => {
    expect(readyLine({ customers: 1240, agents: 6, window: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5, 6] } })).toBe(
      'Ready: 1,240 customers · 6 agents · 9 AM – 6 PM · 6 days a week',
    );
  });
});

describe('what the page brings: each section’s source at its block (CS18)', () => {
  const SOURCES = ['hours', 'retries', 'wrapup', 'recording', 'agent_screen', 'safety', 'assignment', 'inbound', 'breaks', 'outcomes', 'numbers'] as const;
  const sectionSources = Object.fromEntries(SOURCES.map((key) => [key, <span data-testid={`src-${key}`}>{key}</span>]));
  const inside = (testId: string, key: string) =>
    within(screen.getByTestId(testId)).getAllByTestId(`src-${key}`).length;

  it('places each one in the block that edits its section, and none for a section of another step', () => {
    renderStep({
      props: {
        sectionSources,
        assignment: { modeLocked: false },
        inbound: true,
        breakLimits: <div data-testid="break-limits">Break limits</div>,
      },
    });
    expect(inside('when-to-call', 'hours')).toBe(1);
    expect(inside('unanswered-rule', 'retries')).toBe(1);
    expect(inside('wrapup-row', 'wrapup')).toBe(1);
    expect(inside('record-row', 'recording')).toBe(1);
    expect(inside('summary-row', 'recording')).toBe(1);
    expect(inside('phone-display-row', 'agent_screen')).toBe(1);
    expect(inside('daily-target-row', 'agent_screen')).toBe(1);
    fireEvent.click(fold().querySelector('summary')!);
    expect(inside('sourced-retries', 'retries')).toBe(1);
    expect(inside('sourced-safety', 'safety')).toBe(1);
    expect(inside('sourced-assignment', 'assignment')).toBe(1);
    expect(inside('sourced-inbound', 'inbound')).toBe(1);
    expect(inside('sourced-breaks', 'breaks')).toBe(1);
    expect(within(screen.getByTestId('sourced-breaks')).getByTestId('break-limits')).toBeTruthy();
    // The buttons and the numbers are other steps'.
    expect(screen.queryByTestId('src-outcomes')).toBeNull();
    expect(screen.queryByTestId('src-numbers')).toBeNull();
  });

  it('wraps nothing without them', () => {
    renderStep({ props: { breakLimits: <div data-testid="break-limits">Break limits</div> } });
    expect(screen.queryByTestId(/^sourced-/)).toBeNull();
    expect(screen.queryByTestId(/^src-/)).toBeNull();
  });
});

