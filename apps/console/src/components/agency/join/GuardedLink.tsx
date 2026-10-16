import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * A `<Link>` off this page that must not be taken while a claim is in flight.
 *
 * ── The race it closes ─────────────────────────────────────────────────────
 * `pending` disables every BUTTON on the card, which is what stops a double
 * claim — but the two links out of here were never part of that, and they are
 * reachable at exactly the wrong moment. Confirm the address mismatch, and while
 * `claimInvite` is in flight press "Sign in instead": this page unmounts, its
 * cleanup signs out, and that sign-out races the `adoptSession` that has just
 * bound the membership. The agent ends up signed out, on a door telling them to
 * use an account they were signed out of, holding an invitation that is already
 * spent — the one failure on this page that cannot be retried, because the token
 * is single-use.
 *
 * `aria-disabled` plus a suppressed default rather than removing the link.
 * Removal moves focus to `<body>` mid-action and takes the affordance away
 * without saying why; this keeps it in the document and in the tab order,
 * announced as unavailable, and it comes back the moment the claim settles —
 * which for a refused claim is immediately, because that is when the visitor
 * most needs it.
 *
 * Its `onClick` is what actually refuses, not the styling: `pointer-events` would
 * leave a keyboard Enter working, and this is a `<Link>`, so the default it must
 * suppress is a router navigation rather than a form submit.
 */
export function GuardedLink({
  to,
  disabled,
  className,
  children,
}: {
  to: string;
  disabled: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={className}
      aria-disabled={disabled || undefined}
      onClick={(e) => { if (disabled) e.preventDefault(); }}
    >
      {children}
    </Link>
  );
}
