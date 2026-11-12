import type { Membership } from '../../types/auth';

/**
 * Which account an invite puts somebody in, and who may leave it open to every account.
 *
 * ── Why there is no default ────────────────────────────────────────────────
 * `POST /users/invite` reads an absent `account_id` as a TENANT-WIDE membership: the
 * invitee reaches every account in the workspace. The invite form used to start on that
 * ("Tenant-level", under an "Account (optional)" label), so an owner inviting a new
 * account's supervisor who forgot the account field handed them every account. Every
 * role the invite offers (`account_admin` and below; the server takes no higher one) is
 * an account's role, so the form now starts with no answer and refuses to submit until
 * one is picked. "All accounts" stays on offer, as a deliberate pick, because a
 * workspace-wide supervisor or viewer is a real seat the server allows.
 */

/** The select's value for "every account": `account_id` is left out of the request. */
export const ALL_ACCOUNTS = '__all_accounts__';

/** What the account select holds: nothing picked yet, every account, or one account's id. */
export type InviteAccountChoice = '' | typeof ALL_ACCOUNTS | (string & {});

/**
 * The `account_id` to send for a choice: the id, `undefined` for every account, and
 * `null` when nothing was picked (the caller must not send the invite).
 */
export function inviteAccountId(choice: InviteAccountChoice): string | undefined | null {
  if (choice === '') return null;
  if (choice === ALL_ACCOUNTS) return undefined;
  return choice;
}

/**
 * What the inviter may put in the account field: anything (`tenant`), one account they are
 * held to (`account`), or `unknown` when this page cannot tell which account the server will
 * hold them to, so it offers none rather than offer a 403.
 */
export type InviterScope =
  | { kind: 'tenant' }
  | { kind: 'account'; accountId: string }
  | { kind: 'unknown' };

/**
 * The scope an inviter's invite is held to, read as the server reads it.
 *
 * `POST /users/invite` is sent without `X-Account-Id`, so the server acts under the inviter's
 * tenant-wide row, else their OLDEST account-scoped row (`selectMembership`), and a scoped row
 * may only invite into its own account (`accountScopeMismatch` in `user.routes.ts`). So:
 *
 *  - a tenant-wide row reaches every account: `tenant`. One exception, kept on purpose: an
 *    inviter who also holds a row for the account in view is offered that account only, which
 *    is narrower than the server allows and never refused.
 *  - no tenant-wide row and exactly one account: that account, whatever account is in view (an
 *    account in view may not be resolved yet).
 *  - no tenant-wide row and several accounts (or none): `unknown`. The server picks the oldest,
 *    which is a tie-break, not something to put in front of the inviter as "your account".
 *
 * Never `tenant` without a tenant-wide row: that would offer "All accounts" and every sibling
 * account to someone the server refuses each of them to.
 */
export function inviterScope(
  memberships: ReadonlyArray<Pick<Membership, 'tenant_id' | 'account_id' | 'status'>>,
  tenantId: string | null,
  accountId: string | null,
): InviterScope {
  const mine = memberships.filter((m) => m.tenant_id === tenantId && m.status === 'active');
  const accounts = [...new Set(mine.flatMap((m) => (m.account_id === null ? [] : [m.account_id])))];
  if (mine.some((m) => m.account_id === null)) {
    return accountId && accounts.includes(accountId) ? { kind: 'account', accountId } : { kind: 'tenant' };
  }
  if (accounts.length === 1) return { kind: 'account', accountId: accounts[0]! };
  return { kind: 'unknown' };
}
