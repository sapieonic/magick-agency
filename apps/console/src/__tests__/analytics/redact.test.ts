import { describe, it, expect } from 'vitest';
import { redactInviteToken, redactAnalyticsProperties } from '../../analytics/redact';
import { safeAnalyticsPath } from '../../api/error-analytics';

/**
 * The rules behind the PostHog boundary hook.
 *
 * The behaviour that matters is asserted at that boundary
 * (`analytics/posthog.test.ts`, on `before_send`). What is pinned HERE is the
 * design decision underneath it, because it is the one a future reader is most
 * likely to undo: this is keyed on the PATH and not on how random the segment
 * looks.
 */

describe('redactInviteToken', () => {
  const TOKEN = 'Xk8sQ2vLp7NmR4tYwZ1aB3cD5eF6gH9jK0lM2nO4pQ6';

  it('redacts the token wherever the string carries it', () => {
    expect(redactInviteToken(`/agency/join/${TOKEN}`)).toBe('/agency/join/:token');
    expect(redactInviteToken(`https://app.example.com/agency/join/${TOKEN}?utm=mail`))
      .toBe('https://app.example.com/agency/join/:token?utm=mail');
    // As prose, which is how it reaches an autocapture `$el_text`.
    expect(redactInviteToken(`Your link: https://app.mv.com/agency/join/${TOKEN} — opens once`))
      .toBe('Your link: https://app.mv.com/agency/join/:token — opens once');
  });

  it('redacts a token that ENTROPY detection would miss', () => {
    /*
      This is the whole reason `isHighEntropyTokenLikeSegment` is not reused here.
      That predicate requires a digit, because it is guessing at paths whose shape
      it does not know. A base64url token need not contain one — the server mints 32
      random bytes, so roughly one token in 1,500 has no digit at all — and
      "usually redacted" is not a property worth having for a live credential.

      The contrast is asserted rather than described: the same URL through the
      entropy path keeps its token.
    */
    const noDigits = 'QwErTyUiOpAsDfGhJkLzXcVbNmQwErTyUiOpAsDfGhJ';
    expect(/\d/.test(noDigits)).toBe(false);

    expect(redactInviteToken(`/agency/join/${noDigits}`)).toBe('/agency/join/:token');
    expect(safeAnalyticsPath(`/agency/join/${noDigits}`)).toContain(noDigits);
  });

  it('covers the API spelling of the token as well as the page one', () => {
    expect(redactInviteToken(`/invites/${TOKEN}`)).toBe('/invites/:token');
    expect(redactInviteToken(`/invites/${TOKEN}/claim`)).toBe('/invites/:token/claim');
  });

  it('leaves /invites/resend alone, because it is a route and not a secret', () => {
    // Redacting it would make an endpoint that is worth distinguishing in a
    // funnel indistinguishable from every claim in the product.
    expect(redactInviteToken('/invites/resend')).toBe('/invites/resend');
    expect(redactInviteToken('https://api.mv.com/invites/resend')).toBe('https://api.mv.com/invites/resend');
  });

  it('is idempotent, and leaves everything else untouched', () => {
    expect(redactInviteToken('/agency/join/:token')).toBe('/agency/join/:token');
    expect(redactInviteToken('/agency/campaigns/abc')).toBe('/agency/campaigns/abc');
    expect(redactInviteToken('/agency/join')).toBe('/agency/join');
  });
});

describe('redactAnalyticsProperties', () => {
  const TOKEN = 'Xk8sQ2vLp7NmR4tYwZ1aB3cD5eF6gH9jK0lM2nO4pQ6';

  it('reaches nested arrays and objects, which is where autocapture puts it', () => {
    const out = redactAnalyticsProperties({
      $current_url: `https://app.mv.com/agency/join/${TOKEN}`,
      $elements: [{ tag_name: 'span', $el_text: `/agency/join/${TOKEN}` }],
      count: 2,
    });

    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out.count).toBe(2);
  });

  it('returns the SAME object when there was nothing to redact', () => {
    // Every capture in the app runs through this; the overwhelmingly common one
    // must cost a walk and no allocation.
    const props = { $current_url: 'https://app.mv.com/app/calls', n: 1 };
    expect(redactAnalyticsProperties(props)).toBe(props);
  });

  it('does not rebuild a class instance as a bare object', () => {
    const at = new Date('2026-09-05T00:00:00.000Z');
    const out = redactAnalyticsProperties({ at, url: `/agency/join/${TOKEN}` });
    expect(out.at).toBe(at);
    expect(out.url).toBe('/agency/join/:token');
  });
});
