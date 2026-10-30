import type { InviteEmailResult } from '@magick-agency/contracts/api/platform/team';

/**
 * What the super admin is told after adding somebody to a tenant — by tenant
 * create (its owner) or by add-user — about the invitation email.
 *
 * Both routes answer `invite_email` (contract `InviteEmailResult`): `sent: true`,
 * or `sent: false` with the reason. Without this the UI said nothing either way,
 * so a person added on a server with no mail transport, or whose mail the
 * provider refused, was never told — and the super admin had no way to know.
 *
 * ── Three answers, and the third is the old server ────────────────────────
 *  - **sent** → a success note that says the email went.
 *  - **not sent** → a WARNING that keeps the two facts apart: the person WAS
 *    added (the membership stands; retrying would answer 409), and was NOT
 *    emailed. The reason is named in plain words, because `not_configured` is
 *    the server's operator's to fix and `failed` is the mail provider's.
 *  - **absent** → a server that predates the field. The add still happened, so
 *    the note says so and nothing about mail: claiming either outcome would be a
 *    guess presented as a fact.
 *
 * There is no link to hand over on the warning, on purpose: these routes never
 * answer the join link to this UI (see `inviteEmailBody` in the server's
 * `super-admin/tenants.ts`).
 */
export interface InviteEmailNotice {
  tone: 'success' | 'warning';
  message: string;
}

/** The reason as a clause, for the sentence below. Unknown reasons are named as themselves. */
function reasonClause(reason: string): string {
  switch (reason) {
    case 'not_configured':
      return 'email is not configured on the server';
    case 'failed':
      return 'the mail provider did not accept it';
    default:
      return `reason: ${reason}`;
  }
}

/**
 * @param done  What happened, as a sentence without its full stop
 *              ("Added pat@acme.test as Operator").
 * @param email The invited address, named again in the warning so it can be
 *              read on its own.
 */
export function inviteEmailNotice(
  done: string,
  email: string,
  result: InviteEmailResult | undefined,
): InviteEmailNotice {
  if (!result) return { tone: 'success', message: `${done}.` };
  if (result.sent) return { tone: 'success', message: `${done}. The invitation email was sent.` };
  return {
    tone: 'warning',
    message:
      `${done}, but the invitation email was not sent (${reasonClause(result.reason)}). `
      + `${email} has not been told they were added.`,
  };
}
