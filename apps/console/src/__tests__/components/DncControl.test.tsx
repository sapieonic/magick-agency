import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DncControl } from '../../components/agency/DncControl';

/**
 * `C4`. The confirmation names the campaign, and that name is the ONLY thing
 * distinguishing the campaign-scoped promise ("won't be called again by
 * Renewals") from the tenant-wide one. `campaignName ?? 'this campaign'` does
 * not catch `''`, and `''` is reachable: `AgentConsolePage` passes
 * `live?.attempt.campaign_name ?? null` straight through, so an unnamed campaign
 * rendered "…won't be called again by . Other campaigns…".
 */

afterEach(cleanup);

function renderControl(over: Partial<Parameters<typeof DncControl>[0]> = {}) {
  const onConfirm = over.onConfirm ?? vi.fn();
  render(
    <DncControl
      attemptId="att-1"
      phoneE164="+919820041772"
      campaignName="Renewals"
      permitted
      permittedTenantWide={false}
      inFlight={false}
      onConfirm={onConfirm}
      {...over}
    />,
  );
  fireEvent.click(screen.getByTestId('dnc-button'));
  return { onConfirm };
}

/** The confirmation sentence, whatever campaign name it ended up with. */
function message(): string {
  return screen.getByText(/won’t be called again by/).textContent ?? '';
}

describe('the mark-DNC confirmation names the campaign', () => {
  it('uses the real campaign name when there is one', () => {
    // The under-claim guard: falling back to the generic wording for a campaign
    // that HAS a name would make both promises read alike.
    renderControl({ campaignName: 'Renewals' });

    expect(message()).toContain('won’t be called again by Renewals.');
    expect(message()).not.toContain('this campaign');
  });

  it('falls back to generic wording for an EMPTY name, never a blank', () => {
    // The defect: `??` passes `''` through untouched.
    renderControl({ campaignName: '' });

    expect(message()).toContain('won’t be called again by this campaign.');
    expect(message()).not.toMatch(/called again by\s*\./);
  });

  it('falls back for a whitespace-only name too', () => {
    renderControl({ campaignName: '   ' });

    expect(message()).toContain('won’t be called again by this campaign.');
    expect(message()).not.toMatch(/called again by\s+\./);
  });

  it('falls back for a null name, as it always did', () => {
    renderControl({ campaignName: null });

    expect(message()).toContain('won’t be called again by this campaign.');
  });

  it('always names the number, and never claims the workspace-wide scope', () => {
    renderControl({ campaignName: '' });

    expect(message()).toContain('+919820041772');
    // The default option is campaign-scoped; only the escalation may say this.
    expect(message()).not.toContain('any campaign in this workspace');
  });
});

describe('the tenant-wide escalation is offered only under its own permission', () => {
  it('is absent without `agency.dnc.manage`, and the default still works', () => {
    // Hiding the escalation must never disable the campaign-scoped default —
    // they are independent choices, not tiers of one permission.
    const { onConfirm } = renderControl({ permittedTenantWide: false });

    expect(screen.queryByText('Never call again (any campaign, forever)')).toBeNull();
    fireEvent.click(screen.getByText('Don’t call in this campaign'));
    // `renderControl` opens the dialog via the button, so `origin` is 'click'.
    expect(onConfirm).toHaveBeenCalledWith('campaign', 'click');
  });

  it('is present with the permission, and escalates on its own scope', () => {
    const { onConfirm } = renderControl({ permittedTenantWide: true });

    fireEvent.click(screen.getByText('Never call again (any campaign, forever)'));
    expect(onConfirm).toHaveBeenCalledWith('tenant', 'click');
  });
});
