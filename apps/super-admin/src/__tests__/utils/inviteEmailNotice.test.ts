import { describe, it, expect } from 'vitest';
import { inviteEmailNotice } from '../../utils/inviteEmailNotice';

/**
 * What the super admin is told about an invitation email after tenant create or
 * add-user. The pages render whatever this returns; these pin its three answers.
 */
const DONE = 'Added pat@acme.test as Operator';

describe('inviteEmailNotice', () => {
  it('says the email went when the server says it did', () => {
    expect(inviteEmailNotice(DONE, 'pat@acme.test', { sent: true })).toEqual({
      tone: 'success',
      message: 'Added pat@acme.test as Operator. The invitation email was sent.',
    });
  });

  it.each([
    ['not_configured', 'email is not configured on the server'],
    ['failed', 'the mail provider did not accept it'],
    ['something_new', 'reason: something_new'],
  ])('warns on %s: added, but not emailed, and why', (reason, clause) => {
    const notice = inviteEmailNotice(DONE, 'pat@acme.test', { sent: false, reason });

    expect(notice.tone).toBe('warning');
    // Both facts, kept apart: the add stands, and nobody told the person.
    expect(notice.message).toBe(
      `Added pat@acme.test as Operator, but the invitation email was not sent (${clause}). `
      + 'pat@acme.test has not been told they were added.',
    );
  });

  it('says only what happened when an older server does not answer invite_email', () => {
    // Neither "sent" nor "not sent" would be true: the server did not say.
    const notice = inviteEmailNotice(DONE, 'pat@acme.test', undefined);
    expect(notice).toEqual({ tone: 'success', message: 'Added pat@acme.test as Operator.' });
    expect(notice.message).not.toMatch(/email/i);
  });
});
