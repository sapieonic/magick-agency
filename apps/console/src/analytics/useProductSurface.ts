import { useEffect } from 'react';
import { clearProductSurface, setProductSurface, type ProductSurface } from './posthog';

/**
 * Tag every event fired inside this shell with the product it belongs to.
 *
 * ── Why the shell and not the call sites ────────────────────────────────────
 * The event catalog is flat, so without a product axis the same event from the
 * `/app` zone and from the agency shell lands in one bucket with nothing to
 * separate them. The axis cannot be added at the call sites: there are around 200
 * of them, and autocapture, pageviews and error events have no call site at
 * all. The shell is the one place that knows the answer for everything mounted
 * under it, which is exactly what a super property is for.
 *
 * Used by `AppLayout` (`'ai'`), `AgencyLayout` (`'agency'`), and — through
 * `ProductSurface` — the four agency routes that are deliberately full-viewport
 * and OUTSIDE both shells (`/station`, `/dialer`, `/dialer/performance`,
 * `/dialer/attempts`). Those are the reason a component form exists: they are
 * agency events with no layout to attribute them, so a strictly shell-set rule
 * left the agent station — dispositions, mid-call DNC marks — reporting no
 * product at all.
 *
 * A page outside all of those — login, onboarding, super-admin — is deliberately
 * unattributed rather than inheriting the last surface that was open; see
 * `clearProductSurface`. One declaration per top-level surface, never per
 * component: two live at once and their cleanups fight over the same property.
 */
export function useProductSurface(product: ProductSurface): void {
  useEffect(() => {
    setProductSurface(product);
    return () => clearProductSurface(product);
  }, [product]);
}
