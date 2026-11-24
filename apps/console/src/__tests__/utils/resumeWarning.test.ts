import { describe, expect, it } from 'vitest';
import {
  abandonmentPauseLine,
  resumeWarning,
  RESUME_ANYWAY_LABEL,
  type ResumeWarningCampaign,
  type ResumeWarningStats,
} from '../../utils/agency/resumeWarning';

/**
 * The warning before Resume (decisions AW1–AW3): when it is asked, and what it says. Page-level
 * behaviour (nothing sent until confirmed, confirm always resumes) is in
 * `AgencyCampaignDetailPage.test.tsx` and `HomePage.test.tsx`.
 */

function guardrailPaused(over: Partial<ResumeWarningCampaign> = {}): ResumeWarningCampaign {
  return {
    status: 'paused',
    pause_reason: 'abandonment_ceiling',
    paused_at: '2026-11-23T05:33:00.000Z',
    pause_abandonment_rate_pct: 4.24,
    abandonment_ceiling_pct: 3,
    ...over,
  };
}

function now(abandoned: number, answered: number): ResumeWarningStats {
  return { abandoned_24h: abandoned, answered_24h: answered, abandonment_ceiling_pct: 3 };
}

describe('resumeWarning — a campaign the guardrail paused (AW1)', () => {
  it('asks, with the rate at the pause and the ceiling, and says it will be paused again while still over', () => {
    const warning = resumeWarning(guardrailPaused(), now(12, 316));
    expect(warning).toEqual({
      kind: 'abandonment_pause',
      title: 'Resume after an automatic pause?',
      message:
        'The dialler paused this campaign automatically: its abandonment rate over the last 24 hours '
        + 'reached 4.2%, over its 3% limit. It is 3.8% (12 of 316 answered calls) now, still over the '
        + 'limit. If you resume now, it will be paused again within about a minute. Get more agents on '
        + 'shift before you resume, so fewer answered calls are left waiting.',
      confirmLabel: RESUME_ANYWAY_LABEL,
    });
  });

  it('still asks once the rate is back under the ceiling, and does not promise a pause', () => {
    const warning = resumeWarning(guardrailPaused(), now(5, 400));
    expect(warning?.kind).toBe('abandonment_pause');
    expect(warning?.message).toContain('It is 1.3% (5 of 400 answered calls) now. If it goes over the limit again, it will be paused again within about a minute.');
    expect(warning?.message).not.toContain('still over');
  });

  it('asks from the campaign row alone when the stats read failed', () => {
    const warning = resumeWarning(guardrailPaused(), null);
    expect(warning?.kind).toBe('abandonment_pause');
    expect(warning?.message).toContain('reached 4.2%, over its 3% limit. If the rate is still over the limit when you resume, it will be paused again within about a minute.');
  });

  it('reads the guardrail’s rule for "still over": one abandoned call in too small a sample is not', () => {
    // 1 of 20 is 5%, over 3%, but the guardrail never pauses on one call under 34 answered.
    const warning = resumeWarning(guardrailPaused(), now(1, 20));
    expect(warning?.message).not.toContain('still over');
  });

  it('says the limit without a number when no ceiling is carried, and the pause without a rate', () => {
    const warning = resumeWarning(
      guardrailPaused({ abandonment_ceiling_pct: undefined, pause_abandonment_rate_pct: null }),
      null,
    );
    expect(warning?.message.startsWith(
      'The dialler paused this campaign automatically: its abandonment rate over the last 24 hours went over its limit.',
    )).toBe(true);
  });
});

describe('resumeWarning — any other pause (AW2)', () => {
  it('asks when the rolling rate is over the ceiling by the guardrail’s rule', () => {
    const warning = resumeWarning({ status: 'paused', pause_reason: 'supervisor', abandonment_ceiling_pct: 3 }, now(12, 316));
    expect(warning).toEqual({
      kind: 'over_ceiling',
      title: 'Abandonment is over the limit',
      message:
        'This campaign’s abandonment rate over the last 24 hours is 3.8% (12 of 316 answered calls), '
        + 'over its 3% limit. If you resume now, the dialler will pause it again within about a minute. '
        + 'Get more agents on shift before you resume, so fewer answered calls are left waiting.',
      confirmLabel: RESUME_ANYWAY_LABEL,
    });
  });

  it.each([
    ['under the ceiling', now(2, 100)],
    ['at the ceiling', now(3, 100)],
    ['one call in too small a sample', now(1, 20)],
    ['nothing answered', now(0, 0)],
    ['no stats', null],
  ])('goes straight through when %s', (_case, stats) => {
    expect(resumeWarning({ status: 'paused', pause_reason: 'supervisor', abandonment_ceiling_pct: 3 }, stats)).toBeNull();
  });

  it('reads the ceiling from the stats when the row does not carry it', () => {
    expect(resumeWarning({ status: 'paused', pause_reason: 'carrier_auth' }, now(12, 316))?.kind).toBe('over_ceiling');
  });

  it('never warns about a campaign that is not paused', () => {
    expect(resumeWarning(guardrailPaused({ status: 'running' }), now(12, 316))).toBeNull();
    expect(resumeWarning(guardrailPaused({ status: 'stopping' }), now(12, 316))).toBeNull();
  });
});

describe('abandonmentPauseLine — the header’s reason (AW1)', () => {
  const sameDay = new Date('2026-11-23T10:00:00.000Z');

  it('says when, the rate at the pause and the ceiling', () => {
    expect(abandonmentPauseLine(guardrailPaused(), sameDay)).toBe(
      'Paused automatically at 05:33 AM: abandonment over the last 24 hours reached 4.2%, over the 3% limit.',
    );
  });

  it('leaves out what the row does not carry', () => {
    expect(abandonmentPauseLine(
      guardrailPaused({ paused_at: null, pause_abandonment_rate_pct: null, abandonment_ceiling_pct: undefined }),
      sameDay,
    )).toBe('Paused automatically: abandonment over the last 24 hours went over its limit.');
  });

  it('is null for any other pause, and for a campaign not paused', () => {
    expect(abandonmentPauseLine(guardrailPaused({ pause_reason: 'supervisor' }), sameDay)).toBeNull();
    expect(abandonmentPauseLine(guardrailPaused({ status: 'running' }), sameDay)).toBeNull();
  });
});
