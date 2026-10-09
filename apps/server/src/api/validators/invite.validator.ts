import { z } from 'zod';

/**
 * `POST /invites/:token/claim`'s body.
 *
 * The same field name and the same shape as `sessionRequestSchema`'s
 * `id_token`, deliberately: the SPA already has a Firebase sign-in flow that
 * produces this value and posts it to `/auth/session`, and the claim page is
 * that flow with a different destination. A differently-named field here would
 * be a second thing to remember on the one screen a person only ever sees once.
 *
 * No `phone_number`. `/auth/session` accepts one because signup can collect it;
 * a claim must not, because the claim path deliberately provisions nothing —
 * see the route's docstring on why it can never reach `/auth/session` path 4.
 */
export const claimInviteSchema = z.object({
  id_token: z.string().min(1, 'id_token is required'),
});

/**
 * `POST /invites/resend`'s body.
 *
 * The MEMBERSHIP is the subject, not the user and not the email address. That is
 * the same decision the whole feature turns on: a user can hold more than one
 * membership in a tenant (one tenant-wide, one per account), and an address is
 * not an identity in this schema at all (`users.email` carries only a non-unique
 * index). Naming the membership makes "resend the invitation for this row"
 * expressible and "resend to whoever this address happens to resolve to"
 * inexpressible.
 */
export const resendInviteSchema = z.object({
  membership_id: z.string().uuid(),
});

export type ClaimInviteRequest = z.infer<typeof claimInviteSchema>;
export type ResendInviteRequest = z.infer<typeof resendInviteSchema>;
