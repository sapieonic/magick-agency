import { AlertTriangle } from 'lucide-react';
import { EmptyState } from './EmptyState';

/**
 * What a screen shows when the active account could **not be resolved at all**.
 *
 * Deliberately **not** `CapabilityUnavailable`. That one says "this feature isn't
 * part of your current plan", which is a calm, confident and — here — completely
 * false explanation: nothing is turned off, we simply do not know which account
 * the user is in. Telling someone their plan is the problem when the problem is a
 * failed request sends them to the wrong person and they never come back.
 *
 * Three things this has to do that a spinner cannot:
 *  - **say something happened** — the failure mode it replaces was silent, with
 *    no error and nothing in the console;
 *  - **name a next action** the user can actually take (retry, then their
 *    administrator);
 *  - **stop**, so the screen reaches a terminal state instead of implying that
 *    waiting longer will help.
 *
 * `detail` is the underlying message where there is one. Rendered because these
 * failures are mostly permission-shaped and the server's own sentence is more use
 * than ours — but it is additive, never the whole message: master masks upstream
 * errors, so `detail` is sometimes only a request id.
 */
export function AccountUnavailable({
  detail,
  onRetry,
}: {
  detail?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div style={{ padding: '3rem 1rem' }}>
      <EmptyState
        icon={<AlertTriangle size={40} aria-hidden />}
        title="We couldn’t open your account"
        description={
          `Your sign-in worked, but we couldn’t work out which account to put you in, so nothing on this page can load. Try again — if it keeps happening, ask your administrator to check your access.` +
          (detail ? ` (${detail})` : '')
        }
        action={
          onRetry ? (
            <button type="button" onClick={onRetry}>
              Try again
            </button>
          ) : undefined
        }
      />
    </div>
  );
}
