import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { DialerUnavailable } from '../../components/agency/DialerUnavailable';

/**
 * What a dedicated agent reads when the dialer is off for their tenant.
 *
 * `DashboardPage`'s own tests pin WHEN this renders; these pin what it says. Both
 * halves matter — the diversion without the sentence is the empty shell again, and
 * the sentence has to name the person who can fix it, because an `agent` holds no
 * permission that could.
 */

afterEach(cleanup);

describe('DialerUnavailable', () => {
  it('names who can turn the dialer on', () => {
    /* Not a "try again": an agent cannot read the governance map, set an override
       or touch a feature flag, so a retry would be an instruction to repeat
       something that cannot work. Same rule as `AgentHomePage`'s "ask your
       supervisor to add you to one". */
    render(<MemoryRouter><DialerUnavailable /></MemoryRouter>);

    expect(screen.getByText(/ask your administrator/i)).toBeTruthy();
  });

  it('offers a way to the dialer once somebody switches it on', () => {
    /* The gates resolve per tenant and per account, so an agent whose
       administrator enables the capability while this is open needs a way to try
       without signing out and back in. */
    render(<MemoryRouter><DialerUnavailable /></MemoryRouter>);

    expect(screen.getByRole('link', { name: /try the dialer/i }).getAttribute('href'))
      .toBe('/dialer');
  });

  it('names neither the capability nor the feature flag', () => {
    /* Which of the two gates is off is a fact about our rollout, not about this
       person's day, and both have the same remedy. Leaking the vocabulary would
       put implementation names on the one screen read by the people least
       equipped to act on them. */
    const { container } = render(<MemoryRouter><DialerUnavailable /></MemoryRouter>);

    expect(container.textContent).not.toMatch(/capability|feature flag|agency_dialer_enabled/i);
  });
});
