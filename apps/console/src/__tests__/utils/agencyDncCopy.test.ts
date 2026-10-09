import { describe, it, expect } from 'vitest';
import {
  DNC_BLOCK_COPY,
  DNC_CAMPAIGN_ACTION_LABEL,
  DNC_CONFIRM_TITLE,
  DNC_TENANT_ACTION_LABEL,
  dncBlockReason,
  dncCampaignConfirmMessage,
  dncFailureCopy,
  dncOutcomeCopy,
  dncTenantConfirmHint,
} from '../../utils/agencyDncCopy';
import type { AgencyDncResponse } from '../../types/agency';

/**
 * `AD-P3-U-03` (b) and (c), plus §A.7.5's *never overstate a compliance action*.
 */

function response(over: Partial<AgencyDncResponse> = {}): AgencyDncResponse {
  return {
    attempt_id: 'att-1',
    contact_id: 'c-1',
    phone_e164: '+919820041772',
    contact_state: 'suppressed',
    dnc_recorded: true,
    ...over,
  };
}

describe('the campaign-scoped default states its (narrower) scope before the agent commits', () => {
  it('names the number and the campaign, not the whole workspace', () => {
    const message = dncCampaignConfirmMessage('+919820041772', 'Renewals');
    expect(message).toContain('+919820041772');
    expect(message).toContain('Renewals');
    // The default option must NOT claim the wider scope — that overstatement is
    // exactly what the tenant-wide escalation exists to keep out of the default.
    expect(message).not.toContain('any campaign in this workspace');
  });

  it('says it cannot be undone from the console, and who can', () => {
    const message = dncCampaignConfirmMessage('+919820041772', 'Renewals');
    expect(message).toContain('undo');
    expect(message).toContain('admin');
  });
});

describe('the tenant-wide escalation states the wider scope and its permanence', () => {
  it('names the number and the workspace-wide, permanent effect', () => {
    const hint = dncTenantConfirmHint('+919820041772');
    expect(hint).toContain('+919820041772');
    expect(hint).toContain('any campaign in this workspace');
    expect(hint).toContain('permanently');
  });

  it('says it cannot be undone from the console, and who can', () => {
    // Irreversibility discovered afterwards is the failure §A.7.5 guards
    // against; "only an admin can" is the actionable half.
    const hint = dncTenantConfirmHint('+919820041772');
    expect(hint).toContain('undo');
    expect(hint).toContain('admin');
  });
});

describe('the outcome promises only what the response promised', () => {
  it('the campaign-scoped mark never claims the wider, workspace-wide scope', () => {
    const copy = dncOutcomeCopy(response({ dnc_recorded: true }), 'campaign');
    expect(copy).not.toContain('No campaign in this workspace');
    expect(copy).toContain('this campaign');
  });

  /**
   * `C1`. These two are a matched pair and must both stay: one fails if the copy
   * OVER-claims (promises the list write that did not happen), the other fails if
   * it UNDER-claims (withholds a list write that did). A copy guarantee is only
   * held by a test that pins the exact claim in both directions.
   */
  it('the campaign-scoped mark DOES claim the list once the write landed', () => {
    // The under-claim guard: weakening this arm unconditionally would pass an
    // "it never over-claims" test while telling every agent their mark is still
    // in flight when it landed.
    const copy = dncOutcomeCopy(response({ dnc_recorded: true }), 'campaign');
    expect(copy).toContain('It’s on this campaign’s Do Not Call list');
  });

  it('the campaign-scoped mark does NOT claim the list while the write is in flight', () => {
    // The over-claim guard, and the defect this pair exists for. Core writes the
    // roster rows `suppressed` and then forwards to master; when that forward
    // cannot land it still answers 200 with `dnc_recorded: false`, and NO entry
    // exists on any list. Claiming one is the overstatement §A.7.5 forbids — and
    // core's own abandon log says why it matters: nothing then stops a re-upload
    // of the number into this same campaign.
    const copy = dncOutcomeCopy(response({ dnc_recorded: false }), 'campaign');
    expect(copy).not.toContain('It’s on this campaign’s Do Not Call list');
    // Still says what IS true — the rows already on the roster are suppressed —
    // so the agent is not told the mark failed, because it did not.
    expect(copy).toContain('this campaign');
    expect(copy).toContain('still adding');
    // And names the residual exposure plus the way to be sure, rather than
    // leaving the gap unnamed.
    expect(copy).toContain('new upload');
    expect(copy).toContain('check the list');
    // It must not silently borrow the tenant-wide arm's wording either.
    expect(copy).not.toContain('No campaign in this workspace');
    expect(copy).not.toContain('workspace Do Not Call list');
  });

  it('the tenant-wide mark claims the workspace-wide scope once the list write landed', () => {
    const copy = dncOutcomeCopy(response({ dnc_recorded: true }), 'tenant');
    expect(copy).toContain('in this workspace will dial it again');
  });

  it('the tenant-wide mark narrows the claim to AGENCY dialing (Q2)', () => {
    // The unqualified "no campaign in this workspace will dial it again" is the
    // sentence `DncPage` narrowed away from: the dial-time gate lives in core's
    // `agency/pre-dial-gates.ts` and nothing in AI dispatch consults it, so the
    // widest true claim is every agency campaign. This is the copy an AGENT reads
    // and may repeat to the customer, so it must be no wider than the page's.
    const copy = dncOutcomeCopy(response({ dnc_recorded: true }), 'tenant');
    expect(copy).toContain('No agency campaign in this workspace');
  });

  it('the tenant-wide mark WEAKENS to this campaign only while the list write is in flight', () => {
    // The load-bearing case. `dnc_recorded: false` is a success with a smaller
    // promise: core suppressed the contact locally, master's tenant-wide row is
    // not confirmed. An agent may repeat this sentence to the customer.
    const copy = dncOutcomeCopy(response({ dnc_recorded: false }), 'tenant');
    expect(copy).toContain('this campaign');
    expect(copy).not.toContain('No campaign in this workspace');
    // And it says how to be sure, rather than leaving the gap unnamed.
    expect(copy).toContain('check the list');
  });

  it('names the number in every form, because the agent may be on their second call', () => {
    expect(dncOutcomeCopy(response({ dnc_recorded: true }), 'campaign')).toContain(
      '+919820041772',
    );
    expect(dncOutcomeCopy(response({ dnc_recorded: false }), 'campaign')).toContain(
      '+919820041772',
    );
    expect(dncOutcomeCopy(response({ dnc_recorded: true }), 'tenant')).toContain('+919820041772');
    expect(dncOutcomeCopy(response({ dnc_recorded: false }), 'tenant')).toContain(
      '+919820041772',
    );
  });
});

/**
 * The two action labels and the title are what an agent reads under pressure and
 * what `AgentConsolePage`'s tests key off. Pinned verbatim so a future edit to
 * the outcome copy in this module cannot drift them as a side effect.
 */
describe('the labels an agent chooses between', () => {
  it('are exactly these strings', () => {
    expect(DNC_CONFIRM_TITLE).toBe('Stop calling this number?');
    expect(DNC_CAMPAIGN_ACTION_LABEL).toBe('Don’t call in this campaign');
    expect(DNC_TENANT_ACTION_LABEL).toBe('Never call again (any campaign, forever)');
  });

  it('spell the escalation out in the label itself, not only in the hint beside it', () => {
    expect(DNC_TENANT_ACTION_LABEL).toContain('any campaign');
    expect(DNC_TENANT_ACTION_LABEL).toContain('forever');
    // The default must not borrow either half of that promise.
    expect(DNC_CAMPAIGN_ACTION_LABEL).not.toContain('any campaign');
    expect(DNC_CAMPAIGN_ACTION_LABEL).not.toContain('forever');
  });
});

describe('when the control is unavailable', () => {
  const base = { hasLiveAttempt: true, permitted: true, inFlight: false };

  it('is available on a live call with the permission', () => {
    expect(dncBlockReason(base)).toBeNull();
  });

  it('is blocked with no live attempt — the same condition as “not your attempt”', () => {
    // (c): the console only ever holds an attempt core reserved to THIS agent,
    // so "no live attempt" is exactly the disabling condition the criterion asks
    // for. Core's 403 `not_your_attempt` is the enforcement behind it.
    expect(dncBlockReason({ ...base, hasLiveAttempt: false })).toBe('no_live_attempt');
    expect(DNC_BLOCK_COPY.no_live_attempt).toContain('on a call');
  });

  it('reports a missing permission AHEAD of the call state', () => {
    // Someone who will never be able to use this control should be told that,
    // not "wait for a call" — which they would then do, indefinitely.
    expect(dncBlockReason({ hasLiveAttempt: false, permitted: false, inFlight: false })).toBe(
      'not_permitted',
    );
  });

  it('blocks a second press while one is in flight', () => {
    expect(dncBlockReason({ ...base, inFlight: true })).toBe('in_flight');
  });
});

describe('failure copy', () => {
  it('says plainly that the call moved on, rather than “contact support”', () => {
    // `not_your_attempt` is allow-listed through master's error mask precisely
    // so it can be said in words on an agent's screen.
    const copy = dncFailureCopy(
      Object.assign(new Error('Forbidden'), { details: { code: 'not_your_attempt' } }),
    );
    expect(copy).toContain('moved on');
    expect(copy.toLowerCase()).not.toContain('support');
  });

  it('says nothing was marked when the attempt is already gone', () => {
    const copy = dncFailureCopy(
      Object.assign(new Error('Not Found'), { details: { code: 'unknown_attempt' } }),
    );
    expect(copy).toContain('Nothing was marked');
  });

  it('never implies a partial mark for an unrecognised failure', () => {
    const copy = dncFailureCopy(new Error(''));
    expect(copy).toContain('Nothing was changed');
  });
});
