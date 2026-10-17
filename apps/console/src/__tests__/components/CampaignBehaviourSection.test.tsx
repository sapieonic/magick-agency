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
  it('seeds the server’s own voicemail default rather than a rule that never fires', () => {
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

// ── Pinned before the section is split into its four editors ─────────────────

function Editor({
  initial,
  fieldErrors = {},
  include = ['hours', 'behaviour'],
}: {
  initial?: AgencyCampaign;
  fieldErrors?: Record<string, string>;
  include?: ('hours' | 'behaviour')[];
}) {
  const [state, setState] = useState<CampaignConfigState>(() =>
    configFromCampaign(initial ?? { id: 'camp-1', name: 'Collections', status: 'draft' }),
  );
  return (
    <CampaignBehaviourSection
      state={state}
      onChange={setState}
      fieldErrors={fieldErrors}
      layout="plain"
      include={include}
      now={new Date('2026-08-19T06:30:00.000Z')}
    />
  );
}

const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;

describe('an outcome added in this session', () => {
  it('takes its code from its label until the code is typed into', () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole('button', { name: /Add an outcome/ }));
    fireEvent.change(screen.getByLabelText('Outcome 4 label'), { target: { value: 'Promised to pay' } });
    expect(value('Outcome 4 code')).toBe('promised_to_pay');

    fireEvent.change(screen.getByLabelText('Outcome 4 code'), { target: { value: 'ptp' } });
    fireEvent.change(screen.getByLabelText('Outcome 4 label'), { target: { value: 'Promised to pay later' } });
    expect(value('Outcome 4 code')).toBe('ptp');
  });

  it('keeps following its label after an earlier row is removed, and after a move', () => {
    render(<Editor initial={{ id: 'c', name: 'C', status: 'draft', disposition_catalog: [
      { code: 'voicemail', label: 'Voicemail' },
      { code: 'sale', label: 'Sale' },
    ] }} />);
    fireEvent.click(screen.getByRole('button', { name: /Add an outcome/ }));
    fireEvent.change(screen.getByLabelText('Outcome 3 label'), { target: { value: 'Busy later' } });

    fireEvent.click(screen.getByRole('button', { name: 'Remove Sale' }));
    fireEvent.change(screen.getByLabelText('Outcome 2 label'), { target: { value: 'Call later' } });
    expect(value('Outcome 2 code')).toBe('call_later');

    fireEvent.click(screen.getByRole('button', { name: 'Move Call later up' }));
    fireEvent.change(screen.getByLabelText('Outcome 1 label'), { target: { value: 'Call much later' } });
    expect(value('Outcome 1 code')).toBe('call_much_later');
  });

  it('refuses to remove a built-in', () => {
    render(<Editor />);
    expect((screen.getByRole('button', { name: 'Remove Voicemail' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('lock-voicemail')).toBeTruthy();
  });
});

describe('field errors are tied to their fields', () => {
  it('gives each error an id the field names in aria-describedby', () => {
    render(
      <Editor
        fieldErrors={{
          calling_window_start: 'Start must be before end.',
          'disposition_catalog[0].label': 'A label is required.',
          'retry_policy.busy.max_attempts': 'Too many.',
          wrapup_seconds: 'At most 600.',
        }}
      />,
    );
    const cases: [string, string][] = [
      ['Start', 'Start must be before end.'],
      ['Outcome 1 label', 'A label is required.'],
      ['Busy max attempts', 'Too many.'],
      ['Wrap-up seconds (0 = none)', 'At most 600.'],
    ];
    for (const [label, message] of cases) {
      const field = screen.getByLabelText(label);
      const describedBy = field.getAttribute('aria-describedby');
      expect(describedBy, label).toBeTruthy();
      expect(document.getElementById(describedBy!)?.textContent).toBe(message);
    }
  });

  it('names no description when there is no error', () => {
    render(<Editor />);
    expect(screen.getByLabelText('Start').getAttribute('aria-describedby')).toBeNull();
  });
});

describe('calling hours', () => {
  it('toggles a day and echoes the window it describes', () => {
    render(<Editor include={['hours']} />);
    expect(screen.getByTestId('calling-window-echo').textContent).toContain('Mon–Fri, 09:00–20:00, Asia/Kolkata.');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sat' }));
    expect(screen.getByTestId('calling-window-echo').textContent).toContain('Mon–Sat');
    // 06:30Z is 12:00 in Kolkata, a Wednesday: inside the window.
    expect(screen.getByTestId('calling-window-echo').textContent)
      .toContain('Right now it is 12:00 there — the campaign would be dialing.');
  });
});

describe('the retry table', () => {
  it('seeds an our-fault row from the platform default, not zero, when one half is typed', () => {
    render(<Editor include={['behaviour']} />);
    fireEvent.change(screen.getByLabelText('Agent disconnected (our fault) delay in minutes'), {
      target: { value: '10' },
    });
    expect(value('Agent disconnected (our fault) max attempts')).toBe('3');
    expect(screen.queryByTestId('our-fault-zero-agent_disconnected')).toBeNull();

    fireEvent.change(screen.getByLabelText('Agent disconnected (our fault) max attempts'), {
      target: { value: '0' },
    });
    expect(screen.getByTestId('our-fault-zero-agent_disconnected')).toBeTruthy();
  });

  it('shows invalid and connected fixed at zero rather than hiding them', () => {
    render(<Editor include={['behaviour']} />);
    expect(screen.getByTestId('fixed-invalid').textContent).toContain('Fixed at 0');
    expect(screen.getByTestId('fixed-connected').textContent).toContain('Fixed at 0');
  });
});

describe('wrap-up', () => {
  it('says what the window and the auto-return switch do together', () => {
    render(<Editor include={['behaviour']} />);
    expect(screen.getByTestId('auto-return-hint').textContent).toContain('After 30s an agent becomes available again');
    fireEvent.click(screen.getByRole('checkbox', { name: /Send agents back to the pool automatically/ }));
    expect(screen.getByTestId('auto-return-hint').textContent)
      .toContain('stays in wrap-up until they mark themselves ready');
    fireEvent.change(screen.getByLabelText('Wrap-up seconds (0 = none)'), { target: { value: '0' } });
    expect(screen.getByTestId('auto-return-hint').textContent)
      .toContain('With no wrap-up window there is no countdown');
  });
});
