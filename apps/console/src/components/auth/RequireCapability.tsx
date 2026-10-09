import { useEffect, type ReactNode } from 'react';
import { useGovernance } from '../../contexts/GovernanceContext';
import { trackFeatureGateUnavailable } from '../../analytics/events';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { CapabilityUnavailable } from '../common/CapabilityUnavailable';

/*
 * Magick Agency's capability map has exactly the three agency keys
 * (`contexts/GovernanceContext.tsx`), so only they are known gates; an unknown
 * key still renders its children (fail-open) and is simply not tracked.
 */
type KnownCapabilityGate =
  // Agency Dialer — the direct mirror of the API's governance catalog entries.
  // `agency` gates the product surface; the two children gate recording and
  // call analysis within it, and both are children of an off-by-default parent,
  // so turning `agency` off takes them with it.
  | 'agency'
  | 'agency.recording'
  | 'agency.analytics';

const KNOWN_CAPABILITY_GATES = new Set<KnownCapabilityGate>([
  'agency',
  'agency.recording',
  'agency.analytics',
] as const);

/**
 * Route guard for a governed capability. Renders a NEUTRAL IN-PLACE screen
 * (inside AppLayout, URL preserved — never a redirect) when the active-context
 * map has resolved and the capability is explicitly `false`. While the map is
 * still loading it shows a spinner (not the unavailable screen) to avoid a
 * flash-then-flip; an empty/failed map is fail-open (renders children), since
 * the API's L2 (403) is the real enforcement.
 */
export default function RequireCapability({
  capability,
  children,
}: {
  capability: string;
  children: ReactNode;
}) {
  const { isEnabled, loading } = useGovernance();
  const unavailable = !loading && !isEnabled(capability);

  useEffect(() => {
    if (!unavailable || !KNOWN_CAPABILITY_GATES.has(capability as KnownCapabilityGate)) {
      return;
    }

    trackFeatureGateUnavailable({
      gate_type: 'capability',
      gate: capability as KnownCapabilityGate,
    });
  }, [capability, unavailable]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (unavailable) {
    return <CapabilityUnavailable />;
  }

  return <>{children}</>;
}
