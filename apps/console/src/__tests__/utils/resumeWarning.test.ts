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
        + 'reached 4.2%, over the 3% limit. The rate now is 3.8% (12 abandoned out of 316 answered calls), '
        + 'still over the limit. If you resume now, the dialler will pause the campaign again within about '
        + 'a minute. Get more agents on shift before you resume, so fewer answered calls are left waiting.',
      confirmLabel: RESUME_ANYWAY_LABEL,
    });
  });

  it('still asks once the rate is back under the ceiling, and does not promise a pause', () => {
    const warning = resumeWarning(guardrailPaused(), now(5, 400));
    expect(warning?.kind).toBe('abandonment_pause');
    expect(warning?.message).toContain(
      'The rate now is 1.3% (5 abandoned out of 400 answered calls). If the rate goes over the limit again, '
      + 'the dialler will pause the campaign within about a minute.',
    );
    expect(warning?.message).not.toContain('still over');
  });

  it('asks from the campaign row alone when the stats read failed', () => {
    const warning = resumeWarning(guardrailPaused(), null);
    expect(warning?.kind).toBe('abandonment_pause');
    expect(warning?.message).toContain(
      'reached 4.2%, over the 3% limit. If the rate is still over the limit when you resume, the dialler will '
      + 'pause the campaign again within about a minute.',
    );
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
      'The dialler paused this campaign automatically: its abandonment rate over the last 24 hours went over the limit.',
    )).toBe(true);
  });

  it('never says a rate over the limit as the limit itself: 3.03% is not "3%, over the 3% limit"', () => {
    // 3.03% at the pause; 10 of 330 answered (3.03%) now, both over a 3% ceiling.
    const warning = resumeWarning(guardrailPaused({ pause_abandonment_rate_pct: 3.03 }), now(10, 330));
    expect(warning?.message).toContain('reached 3.03%, over the 3% limit.');
    expect(warning?.message).toContain('The rate now is 3.03% (10 abandoned out of 330 answered calls), still over the limit.');
  });
});

describe('resumeWarning — any other pause (AW2)', () => {
  it('asks when the rolling rate is over the ceiling by the guardrail’s rule', () => {
    const warning = resumeWarning({ status: 'paused', pause_reason: 'supervisor', abandonment_ceiling_pct: 3 }, now(12, 316));
    expect(warning).toEqual({
      kind: 'over_ceiling',
      title: 'Abandonment is over the limit',
      message:
        'This campaign’s abandonment rate over the last 24 hours is 3.8% (12 abandoned out of 316 answered '
        + 'calls), over the 3% limit. If you resume now, the dialler will pause the campaign again within '
        + 'about a minute. Get more agents on shift before you resume, so fewer answered calls are left waiting.',
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

  it('says the rate over the limit on enough decimals to read as over it', () => {
    expect(resumeWarning({ status: 'paused', pause_reason: 'supervisor', abandonment_ceiling_pct: 3 }, now(10, 330))?.message)
      .toContain('is 3.03% (10 abandoned out of 330 answered calls), over the 3% limit.');
  });

  it('never warns about a campaign that is not paused', () => {
    expect(resumeWarning(guardrailPaused({ status: 'running' }), now(12, 316))).toBeNull();
    expect(resumeWarning(guardrailPaused({ status: 'stopping' }), now(12, 316))).toBeNull();
  });
});

describe('resumeWarning — the campaign could not be re-read (why it is paused is not known)', () => {
  const unread = { campaignRead: false } as const;

  it('asks rather than resume silently, saying the console could not check', () => {
    expect(resumeWarning({ status: 'paused' }, null, unread)).toEqual({
      kind: 'unchecked',
      title: 'Could not check this campaign',
      message:
        'The console could not check why this campaign is paused or what its abandonment rate is now. If the '
        + 'dialler paused it because the rate went over the limit, and the rate is still over, the dialler will '
        + 'pause the campaign again within about a minute.',
      confirmLabel: RESUME_ANYWAY_LABEL,
    });
  });

  it('says the rate it could read, within the limit', () => {
    const warning = resumeWarning({ status: 'paused' }, now(5, 400), unread);
    expect(warning?.kind).toBe('unchecked');
    expect(warning?.message).toBe(
      'The console could not check why this campaign is paused. Its abandonment rate over the last 24 hours '
      + 'is 1.3% (5 abandoned out of 400 answered calls), within the 3% limit.',
    );
  });

  it('warns as over the limit when the rate it could read is over, whatever paused it', () => {
    expect(resumeWarning({ status: 'paused' }, now(12, 316), unread)?.kind).toBe('over_ceiling');
  });

  it('does not trust a pause reason the caller held from before', () => {
    // Held, not re-read: still the unchecked question, not the guardrail's numbers.
    expect(resumeWarning(guardrailPaused(), null, unread)?.kind).toBe('unchecked');
  });

  it('never warns about a campaign that is not paused', () => {
    expect(resumeWarning({ status: 'running' }, null, unread)).toBeNull();
  });
});

describe('abandonmentPauseLine — the header’s reason (AW1)', () => {
  const sameDay = new Date('2026-11-23T10:00:00.000Z');

  it('says when, the rate at the pause and the ceiling', () => {
    expect(abandonmentPauseLine(guardrailPaused(), sameDay)).toBe(
      'Paused automatically at 5:33 AM: abandonment over the last 24 hours reached 4.2%, over the 3% limit.',
    );
  });

  it('says the day of a pause before today, and the year of one before this year', () => {
    expect(abandonmentPauseLine(guardrailPaused(), new Date('2026-11-24T10:00:00.000Z'))).toBe(
      'Paused automatically on 23 Nov at 5:33 AM: abandonment over the last 24 hours reached 4.2%, over the 3% limit.',
    );
    expect(abandonmentPauseLine(guardrailPaused({ paused_at: '2025-12-31T15:05:00.000Z' }), sameDay)).toBe(
      'Paused automatically on 31 Dec 2025 at 3:05 PM: abandonment over the last 24 hours reached 4.2%, over the 3% limit.',
    );
  });

  it('never says a rate over the limit as the limit itself', () => {
    expect(abandonmentPauseLine(guardrailPaused({ pause_abandonment_rate_pct: 3.03 }), sameDay))
      .toContain('reached 3.03%, over the 3% limit.');
  });

  it('leaves out what the row does not carry', () => {
    expect(abandonmentPauseLine(
      guardrailPaused({ paused_at: null, pause_abandonment_rate_pct: null, abandonment_ceiling_pct: undefined }),
      sameDay,
    )).toBe('Paused automatically: abandonment over the last 24 hours went over the limit.');
  });

  it('is null for any other pause, and for a campaign not paused', () => {
    expect(abandonmentPauseLine(guardrailPaused({ pause_reason: 'supervisor' }), sameDay)).toBeNull();
    expect(abandonmentPauseLine(guardrailPaused({ status: 'running' }), sameDay)).toBeNull();
  });
});
