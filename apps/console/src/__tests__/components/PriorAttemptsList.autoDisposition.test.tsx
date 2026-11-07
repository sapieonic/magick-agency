import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { PriorAttemptsList } from '../../components/agency/PriorAttemptsList';
import type { AgencyDisposition, AgencyPriorAttempt, AgencyReservedAttempt } from '../../types/agency';
import { AUTO_DISPOSITION_HINT } from '../../utils/agencySpineCopy';

/**
 * The station's prior attempts with an automatic outcome (decisions OD1–OD8): what
 * the agent reads seconds before the next call. An attempt nobody wrote up but the
 * campaign's unanswered-call mapping filed must say what was filed — tagged
 * automatic — rather than "No disposition"; one that was also written up keeps the
 * write-up as the disposition.
 */

const CATALOG: AgencyDisposition[] = [
  { code: 'callback', label: 'Callback' },
  { code: 'retry_later', label: 'Retry later' },
  { code: 'sale', label: 'Sale' },
];

function prior(over: Partial<AgencyPriorAttempt>): AgencyPriorAttempt {
  return {
    attempt_number: 1,
    outcome: 'busy',
    disposition_code: null,
    auto_disposition_code: null,
    notes: null,
    ended_at: '2026-11-06T10:00:00.000Z',
    campaign_id: 'camp-1',
    campaign_name: 'Renewals',
    dialed_at: '2026-11-06T09:59:00.000Z',
    ...over,
  };
}

function attempt(priors: AgencyPriorAttempt[]): AgencyReservedAttempt {
  return {
    attempt_id: 'att-9',
    campaign_id: 'camp-1',
    campaign_name: 'Renewals',
    contact_id: 'contact-1',
    phone_e164: '+919876500001',
    caller_id: '+919000000001',
    attempt_number: 4,
    context: {},
    prior_attempts: priors,
  };
}

afterEach(cleanup);

describe('prior attempts with an automatic outcome', () => {
  it('shows the automatic outcome by its label, tagged, instead of "No disposition"', () => {
    render(
      <PriorAttemptsList
        attempt={attempt([prior({ auto_disposition_code: 'retry_later' })])}
        currentCatalog={CATALOG}
      />,
    );
    const auto = screen.getByTestId('prior-auto-disposition-camp-1-1');
    expect(auto.textContent).toBe('Retry later (automatic)');
    expect(auto.getAttribute('data-auto-disposition')).toBe('primary');
    expect(auto.getAttribute('title')).toBe(AUTO_DISPOSITION_HINT);
    expect(screen.queryByText('No disposition')).toBeNull();
  });

  it('keeps a write-up as the disposition, with the automatic one secondary', () => {
    render(
      <PriorAttemptsList
        attempt={attempt([prior({ disposition_code: 'sale', auto_disposition_code: 'retry_later' })])}
        currentCatalog={CATALOG}
      />,
    );
    const list = screen.getByTestId('prior-attempts');
    expect(within(list).getByText('Sale')).toBeTruthy();
    const auto = screen.getByTestId('prior-auto-disposition-camp-1-1');
    expect(auto.textContent).toBe('Retry later (automatic)');
    expect(auto.getAttribute('data-auto-disposition')).toBe('secondary');
    // Someone did write this one up: the hover must not say otherwise.
    expect(auto.getAttribute('title')).toBe(AUTO_DISPOSITION_HINT);
    expect(auto.getAttribute('title')).not.toMatch(/No one wrote/i);
  });

  it('shows another campaign’s automatic outcome as its code, never through this catalog', () => {
    render(
      <PriorAttemptsList
        attempt={attempt([
          prior({ campaign_id: 'camp-0', campaign_name: 'Parent', auto_disposition_code: 'retry_later' }),
        ])}
        currentCatalog={CATALOG}
      />,
    );
    expect(screen.getByTestId('prior-auto-disposition-camp-0-1').textContent).toBe(
      'retry_later (automatic)',
    );
  });

  it('still says "No disposition" when there is neither', () => {
    render(<PriorAttemptsList attempt={attempt([prior({})])} currentCatalog={CATALOG} />);
    expect(screen.getByText('No disposition')).toBeTruthy();
    expect(screen.queryByTestId('prior-auto-disposition-camp-1-1')).toBeNull();
  });
});
