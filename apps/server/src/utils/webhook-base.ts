/**
 * A webhook base URL with any trailing slashes removed, so `${base}/route`
 * never produces `//route` (which find-my-way does not collapse: a 404 the
 * carrier gets mid-call, with nothing logged on our side).
 *
 * Import-free on purpose — `core/webhook-url-builder.ts` (which re-exports it)
 * loads config at module scope, and the telephony adapters and the escalation
 * test-call service must not.
 */
export function normalizeWebhookBase(base: string): string {
  return base.replace(/\/+$/, '');
}
