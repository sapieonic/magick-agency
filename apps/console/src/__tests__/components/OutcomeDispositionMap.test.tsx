import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { OutcomeDispositionMap } from '../../pages/campaigns/agency/OutcomeDispositionMap';
import { CampaignBehaviourSection } from '../../pages/campaigns/agency/CampaignBehaviourSection';
import {
  NO_AUTOMATIC_OUTCOME,
  OUTCOME_DISPOSITIONS_EMPTY_CATALOG,
  OUTCOME_DISPOSITIONS_LEAD,
  OUTCOME_DISPOSITIONS_SWITCHED_OFF_NOTE,
  configFromCampaign,
  type CampaignConfigState,
} from '../../utils/agencyCampaignConfigForm';
import type {
  AgencyCampaign,
  AgencyDispositionEntry,
  AgencyOutcomeDispositions,
} from '../../types/agency-campaign';

/**
 * The "Unanswered calls" editor (decisions OD1–OD8): one select per outcome a call
 * can end with unanswered, offering only the catalog entries that may be filed
 * automatically, with its findings on the row they are about.
 */

const CATALOG: AgencyDispositionEntry[] = [
  { code: 'voicemail', label: 'Voicemail' },
  { code: 'callback', label: 'Callback', requires_datetime: true },
  { code: 'do_not_call', label: 'Do not call', suppress: true },
  { code: 'retry_later', label: 'Retry later' },
  { code: 'closed', label: 'Closed', terminal: true },
];

function Harness({
  initial = {},
  dispositions = CATALOG,
  fieldErrors = {},
  onState,
}: {
  initial?: AgencyOutcomeDispositions;
  dispositions?: AgencyDispositionEntry[];
  fieldErrors?: Record<string, string>;
  onState?: (next: AgencyOutcomeDispositions) => void;
}) {
  const [mapping, setMapping] = useState<AgencyOutcomeDispositions>(initial);
  return (
    <OutcomeDispositionMap
      mapping={mapping}
      dispositions={dispositions}
      fieldErrors={fieldErrors}
      onChange={(next) => {
        setMapping(next);
        onState?.(next);
      }}
    />
  );
}

const select = (name: string) => screen.getByLabelText(name) as HTMLSelectElement;
const optionTexts = (el: HTMLSelectElement) => Array.from(el.options).map((o) => o.textContent);

afterEach(cleanup);

describe('the Unanswered calls editor', () => {
  it('renders one row per mappable outcome, with the lead and the switched-off note', () => {
    render(<Harness />);
    expect(screen.getByRole('heading', { name: 'Unanswered calls' })).toBeTruthy();
    expect(screen.getByText(OUTCOME_DISPOSITIONS_LEAD)).toBeTruthy();
    expect(screen.getByTestId('outcome-dispositions-switched-off').textContent)
      .toBe(OUTCOME_DISPOSITIONS_SWITCHED_OFF_NOTE);
    // A declined call is not always Busy: it can arrive as No answer (a carrier rejection).
    expect(OUTCOME_DISPOSITIONS_SWITCHED_OFF_NOTE).toBe(
      'A phone that is switched off is reported by the carrier as “Busy”. A declined call arrives '
      + 'as “Busy” or “No answer”, depending on what the carrier reports.',
    );
    // Not every unanswered contact is dialled again (an invalid number, a last attempt).
    expect(OUTCOME_DISPOSITIONS_LEAD).toContain(
      'The retries above still decide whether and when the contact is dialled again',
    );
    for (const name of ['No answer', 'Busy', 'Failed', 'Invalid number', 'Abandoned (nobody free)']) {
      expect(select(name).value).toBe('');
    }
  });

  it('offers only the outcomes that neither stop nor end the contact, by label', () => {
    render(<Harness />);
    expect(optionTexts(select('Busy'))).toEqual([
      NO_AUTOMATIC_OUTCOME,
      'Voicemail',
      'Callback',
      'Retry later',
    ]);
  });

  it('maps an outcome when one is picked, and unmaps it on "No automatic outcome"', () => {
    const states: AgencyOutcomeDispositions[] = [];
    render(<Harness onState={(next) => states.push(next)} />);

    fireEvent.change(select('Busy'), { target: { value: 'retry_later' } });
    expect(states.at(-1)).toEqual({ busy: 'retry_later' });
    expect(select('Busy').value).toBe('retry_later');

    fireEvent.change(select('No answer'), { target: { value: 'callback' } });
    expect(states.at(-1)).toEqual({ busy: 'retry_later', no_answer: 'callback' });

    fireEvent.change(select('Busy'), { target: { value: '' } });
    // The key goes, rather than staying as an empty string.
    expect(states.at(-1)).toEqual({ no_answer: 'callback' });
  });

  it('shows a mapping to a removed outcome as it is, with the finding on its row', () => {
    render(<Harness initial={{ failed: 'gone' }} />);
    const failed = select('Failed');
    expect(failed.value).toBe('gone');
    expect(optionTexts(failed).at(-1)).toBe('gone (can’t be used)');
    const describedBy = failed.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const error = document.getElementById(describedBy!);
    expect(error?.textContent).toMatch(/‘gone’ is no longer one of this campaign’s outcomes/);
    // Only that row.
    expect(select('Busy').getAttribute('aria-describedby')).toBeNull();
  });

  it('shows a mapping to an outcome that stops calling as a finding, by its label', () => {
    render(<Harness initial={{ busy: 'do_not_call' }} />);
    expect(optionTexts(select('Busy')).at(-1)).toBe('Do not call (can’t be used)');
    const error = document.getElementById(select('Busy').getAttribute('aria-describedby')!);
    expect(error?.textContent).toBe(
      '“Do not call” stops calling the contact. An automatic outcome is only a label and never '
      + 'changes what happens to the contact, so pick an outcome that doesn’t stop or end it.',
    );
  });

  it('puts the server’s message on the row it is keyed to', () => {
    render(
      <Harness
        initial={{ busy: 'retry_later' }}
        fieldErrors={{ 'outcome_dispositions.busy': 'Refused by the server.' }}
      />,
    );
    const error = document.getElementById(select('Busy').getAttribute('aria-describedby')!);
    expect(error?.textContent).toBe('Refused by the server.');
  });

  it('shows a note instead of the selects while the catalog is empty', () => {
    render(<Harness dispositions={[]} />);
    expect(screen.getByTestId('outcome-dispositions-empty').textContent)
      .toBe(OUTCOME_DISPOSITIONS_EMPTY_CATALOG);
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

describe('in the Behaviour section, beside the catalog it maps into', () => {
  function Section({ campaign, onState }: { campaign: AgencyCampaign; onState: (s: CampaignConfigState) => void }) {
    const [state, setState] = useState<CampaignConfigState>(() => configFromCampaign(campaign));
    return (
      <CampaignBehaviourSection
        state={state}
        onChange={(next) => {
          setState(next);
          onState(next);
        }}
        fieldErrors={{}}
        layout="plain"
        include={['behaviour']}
      />
    );
  }

  const CAMPAIGN: AgencyCampaign = {
    id: 'camp-1',
    name: 'Renewals',
    status: 'draft',
    disposition_catalog: CATALOG,
    outcome_dispositions: { busy: 'retry_later' },
  };

  it('renders right after the retries', () => {
    render(<Section campaign={CAMPAIGN} onState={() => {}} />);
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings.indexOf('Unanswered calls')).toBe(headings.indexOf('Retries') + 1);
  });

  it('follows a mapped code renamed in the catalog', () => {
    const states: CampaignConfigState[] = [];
    render(<Section campaign={CAMPAIGN} onState={(s) => states.push(s)} />);
    fireEvent.change(screen.getByLabelText('Outcome 4 code'), { target: { value: 'retry_soon' } });
    expect(states.at(-1)?.outcomeDispositions).toEqual({ busy: 'retry_soon' });
    expect(select('Busy').value).toBe('retry_soon');
  });

  it('follows a mapped code cleared and retyped, through the empty code', () => {
    const states: CampaignConfigState[] = [];
    render(<Section campaign={CAMPAIGN} onState={(s) => states.push(s)} />);
    const code = screen.getByLabelText('Outcome 4 code');
    fireEvent.change(code, { target: { value: '' } });
    expect(states.at(-1)?.outcomeDispositions).toEqual({ busy: '' });
    fireEvent.change(code, { target: { value: 'l' } });
    fireEvent.change(code, { target: { value: 'later' } });
    expect(states.at(-1)?.outcomeDispositions).toEqual({ busy: 'later' });
    expect(select('Busy').value).toBe('later');
  });

  it('follows a mapped code typed through another outcome’s code', () => {
    const states: CampaignConfigState[] = [];
    const campaign = { ...CAMPAIGN, disposition_catalog: [{ code: 'retry', label: 'Retry' }, ...CATALOG] };
    render(<Section campaign={campaign} onState={(s) => states.push(s)} />);
    const code = screen.getByLabelText('Outcome 5 code');
    // `retry` is the first row's code: for one keystroke the two collide.
    fireEvent.change(code, { target: { value: 'retry' } });
    expect(states.at(-1)?.outcomeDispositions).toEqual({ busy: 'retry' });
    fireEvent.change(code, { target: { value: 'retry_2' } });
    expect(states.at(-1)?.outcomeDispositions).toEqual({ busy: 'retry_2' });
  });

  it('keeps a mapping to a removed outcome and says so on its row', () => {
    const states: CampaignConfigState[] = [];
    render(<Section campaign={CAMPAIGN} onState={(s) => states.push(s)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Retry later' }));
    expect(states.at(-1)?.outcomeDispositions).toEqual({ busy: 'retry_later' });
    const map = within(screen.getByTestId('outcome-dispositions'));
    expect(map.getByText(/‘retry_later’ is no longer one of this campaign’s outcomes/)).toBeTruthy();
  });

  it('says so when a mapped outcome is set to stop calling the contact', () => {
    render(<Section campaign={CAMPAIGN} onState={() => {}} />);
    const flags = screen.getByRole('group', { name: 'What happens when an agent files Retry later' });
    fireEvent.click(within(flags).getByLabelText(/Stops calling this contact/));
    const map = within(screen.getByTestId('outcome-dispositions'));
    expect(map.getByText(/“Retry later” stops calling the contact/)).toBeTruthy();
  });
});
