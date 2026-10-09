import { ApiError } from '../api/client';
import { SESSION_REFUSAL_CODES, type SessionRefusalCode } from '../types/auth';

/*
 * NEW in Magick Agency (no cusui source). Agency refuses session path 4 — a
 * verified identity it has no user, stub or invite for — with 403
 * `no_membership` (extraction plan §3.1), where master provisioned a tenant and
 * answered `is_new: true`. This reads that refusal off a failed request so
 * `AuthContext` can keep it and `AgencyLoginPage` can show the
 * unrecognised-account screen for it. A module of its own, rather than an export
 * of `AuthContext`, so a page whose tests mock the context still gets the real
 * classifier.
 */

/**
 * The refusal code on a `POST /auth/session` 403, or `null` for any other
 * failure. Reads master's body shape (`{ error, code, message }`,
 * `SessionRefusal` in the contract).
 */
export function sessionRefusalCode(err: unknown): SessionRefusalCode | null {
  if (!(err instanceof ApiError) || err.statusCode !== 403) return null;
  const details = err.details;
  if (typeof details !== 'object' || details === null) return null;
  const code = (details as { code?: unknown }).code;
  return (SESSION_REFUSAL_CODES as readonly unknown[]).includes(code)
    ? (code as SessionRefusalCode)
    : null;
}
