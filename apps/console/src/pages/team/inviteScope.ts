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
 * The account an account-scoped inviter is held to, or `null` for a tenant-wide one.
 *
 * Mirrors the server's rule (`accountScopeMismatch` in `user.routes.ts`): the request's
 * membership is the inviter's row for the account they are in, else their tenant-wide
 * row, and a scoped one may only invite into its own account. So offering "All accounts"
 * or a sibling account to a scoped inviter would offer a 403.
 */
export function inviterScopedAccount(
  memberships: ReadonlyArray<Pick<Membership, 'tenant_id' | 'account_id' | 'status'>>,
  tenantId: string | null,
  accountId: string | null,
): string | null {
  const mine = memberships.filter((m) => m.tenant_id === tenantId && m.status === 'active');
  if (accountId && mine.some((m) => m.account_id === accountId)) return accountId;
  if (mine.some((m) => m.account_id === null)) return null;
  // No row for this account and none tenant-wide: the server would refuse anything; hold
  // the form to the account in view rather than offer the whole workspace.
  return accountId;
}
