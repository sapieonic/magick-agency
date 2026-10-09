import type { ReactNode } from 'react';
import { useProductSurface } from './useProductSurface';
import type { ProductSurface as Product } from './posthog';

/**
 * The component form of {@link useProductSurface}, for the agency routes that have
 * no shell to hang the hook on.
 *
 * ── Why this exists at all ─────────────────────────────────────────────────
 * The mechanism is "set by shell", and for `AppLayout` / `AgencyLayout` that is
 * exactly right. But four agency routes are deliberately **full-viewport and
 * outside both shells** — `/station`, `/dialer`, `/dialer/performance` and
 * `/dialer/attempts` — because an agent on a live call must not be able to
 * navigate away and drop the station socket. They are agency events with no shell
 * to attribute them, so under a strictly shell-set rule they reported **no
 * product at all**: dispositions and mid-call DNC marks, which are among the most
 * agency-specific things the platform records, would have been the events missing
 * from the agency's own funnel.
 *
 * Wrapping the route element rather than calling the hook inside each of the four
 * pages keeps the answer in one place. It sits INSIDE the capability and flag
 * gates, so a reader who is refused never registers a surface they were not shown.
 *
 * This is not a licence to tag arbitrary pages. The rule is unchanged — one
 * declaration per top-level surface, never per component — and a page inside a
 * shell must not use this, or the shell's cleanup and the page's will fight over
 * the same super property.
 */
export function ProductSurface({
  product,
  children,
}: {
  product: Product;
  children: ReactNode;
}) {
  useProductSurface(product);
  return <>{children}</>;
}
