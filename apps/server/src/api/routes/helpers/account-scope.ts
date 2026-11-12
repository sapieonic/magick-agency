/*
 * The account-scope refusal: a read or write that is one account's work, asked without
 * `X-Account-Id`, is answered `400 account_scope_required` (a reason the console can act on)
 * before any handler work, instead of the internal handler's missing-header complaint.
 */
import type { FastifyReply } from 'fastify';
import { sendRefusal } from './refusal.js';

/** The message of a read scoped to one account. */
export const ACCOUNT_SCOPE_REQUIRED_MESSAGE = 'This read is scoped to one account. Send X-Account-Id.';

/**
 * `accountId` when there is one, else the 400 `account_scope_required` sent with `message`
 * and null (the caller then returns `reply`).
 */
export function accountOrRefuse(
  accountId: string | null | undefined,
  reply: FastifyReply,
  message: string = ACCOUNT_SCOPE_REQUIRED_MESSAGE,
): string | null {
  if (accountId) return accountId;
  void sendRefusal(reply, 400, 'account_scope_required', message);
  return null;
}
