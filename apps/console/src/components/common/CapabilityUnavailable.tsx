import { Lock } from 'lucide-react';
import { EmptyState } from './EmptyState';

/**
 * Calm, neutral in-place screen shown when a governed capability is turned off
 * for the active account. Rendered INSIDE AppLayout (sidebar intact, URL
 * preserved) — never a redirect. Deliberately not an error: no retry, no red
 * styling, and it never names the capability key or the word "governance".
 */
export function CapabilityUnavailable() {
  return (
    <div style={{ padding: '3rem 1rem' }}>
      <EmptyState
        icon={<Lock size={40} aria-hidden />}
        title="Not available for your account"
        description="This feature isn't part of your current plan. Contact your administrator if you think it should be."
      />
    </div>
  );
}
