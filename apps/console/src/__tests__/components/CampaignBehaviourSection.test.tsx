import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CampaignBehaviourSection } from '../../pages/campaigns/agency/CampaignBehaviourSection';
import {
  configFromCampaign,
  type CampaignConfigState,
} from '../../utils/agencyCampaignConfigForm';
import type { AgencyCampaign } from '../../types/agency-campaign';

/**
 * The outcome catalog editor, driven directly.
 *
 * These are the cases about a campaign that ALREADY EXISTS, which the builder
 * page cannot reach — it is a create flow, and its state always starts from
 * `EMPTY_CAMPAIGN_CONFIG`. The settings page is the caller that loads one, and
 * the distinction this file pins is invisible from either page's tests.
 */

function Harness({ campaign }: { campaign: AgencyCampaign }) {
  const [state, setState] = useState<CampaignConfigState>(() => configFromCampaign(campaign));
  return (
    <CampaignBehaviourSection
      state={state}
      onChange={setState}
      fieldErrors={{}}
      layout="plain"
      include={['behaviour']}
    />
  );
}

function loaded(catalog: AgencyCampaign['disposition_catalog']) {
  return render(
    <Harness
      campaign={{ id: 'camp-1', name: 'Collections', status: 'draft', disposition_catalog: catalog }}
    />,
  );
}

afterEach(cleanup);

describe('an outcome that came back from the server', () => {
  /**
   * The tempting stateless rule — "auto-fill the code while it still equals the
   * label's own slug" — cannot tell a code filled in a moment ago from one an
   * operator typed months ago and saved. `promised_to_pay` beside "Promised to
   * pay" is exactly what a careful operator types, so under that rule fixing a
   * typo in the label would silently rewrite the string every historical call
   * record is filed under, with nothing on screen saying so.
   */
  it('keeps its code when the label is edited', () => {
    loaded([{ code: 'promised_to_pay', label: 'Promised to pay' }]);

    fireEvent.change(screen.getByLabelText('Outcome 1 label'), {
      target: { value: 'Promised to pay soon' },
    });

    expect((screen.getByLabelText('Outcome 1 code') as HTMLInputElement).value)
      .toBe('promised_to_pay');
    expect((screen.getByLabelText('Outcome 1 label') as HTMLInputElement).value)
      .toBe('Promised to pay soon');
  });

  it('keeps its code even when the label is emptied entirely', () => {
    // The slug of an empty label is empty. A rule that derived here would
    // delete the code and fail validation on a field the operator never touched.
    loaded([{ code: 'sale', label: 'Sale' }]);
    fireEvent.change(screen.getByLabelText('Outcome 1 label'), { target: { value: '' } });
    expect((screen.getByLabelText('Outcome 1 code') as HTMLInputElement).value).toBe('sale');
  });

});

describe('a retry rule switched on from scratch', () => {
  it('seeds core’s own voicemail default rather than a rule that never fires', () => {
    // `max_attempts: 0` would be a rule the engine ignores, so turning the
    // control on would look like it did nothing.
    loaded([{ code: 'sale', label: 'Sale' }]);

    fireEvent.click(
      screen.getByRole('checkbox', { name: /Call this contact again after this outcome/ }),
    );

    expect((screen.getByLabelText('Sale retry attempts') as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText('Sale retry delay in minutes') as HTMLInputElement).value)
      .toBe('240');
    expect(screen.getByTestId('outcome-summary-0').textContent)
      .toContain('every 4 hours, up to 2 times');
  });
});

describe('reordering', () => {
  it('moves the row and its auto-fill eligibility together', () => {
    loaded([
      { code: 'sale', label: 'Sale' },
      { code: 'no_sale', label: 'No sale' },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Move No sale up' }));
    expect((screen.getByLabelText('Outcome 1 label') as HTMLInputElement).value).toBe('No sale');

    // Both were loaded, so neither may re-derive after the swap — the index
    // bookkeeping must move with the row rather than staying put.
    fireEvent.change(screen.getByLabelText('Outcome 1 label'), { target: { value: 'No answer' } });
    expect((screen.getByLabelText('Outcome 1 code') as HTMLInputElement).value).toBe('no_sale');
  });
});
