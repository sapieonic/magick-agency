import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { PageCrumbsProvider, useSuppliedCrumbs } from '../../components/layout/PageCrumbs';

/** What a page put into the top bar's breadcrumb, as "label→to" text, for a page test. */
function SuppliedCrumbs() {
  const crumbs = useSuppliedCrumbs(useLocation().pathname);
  return (
    <span data-testid="supplied-crumbs">
      {crumbs ? crumbs.map((c) => (c.to ? `${c.label}→${c.to}` : c.label)).join(' / ') : 'none'}
    </span>
  );
}

/** Wrap a page (inside its router) so the crumbs it supplies can be read: `suppliedCrumbs()`. */
export function WithPageCrumbs({ children }: { children: ReactNode }) {
  return (
    <PageCrumbsProvider>
      {children}
      <SuppliedCrumbs />
    </PageCrumbsProvider>
  );
}

export function suppliedCrumbs(): string | null {
  return document.querySelector('[data-testid="supplied-crumbs"]')?.textContent ?? null;
}
