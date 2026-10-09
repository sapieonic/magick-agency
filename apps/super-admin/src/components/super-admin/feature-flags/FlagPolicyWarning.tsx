import { AlertTriangle } from 'lucide-react';
import type { FeatureFlagCatalogEntry } from '@magick-agency/contracts/api/platform/super-admin';
import styles from './featureFlags.module.css';

interface Props {
  flag: FeatureFlagCatalogEntry;
}

/**
 * The operator warning master attaches to a flag with a handling policy
 * (`policy.warning`, e.g. transcript logging writes personal data into Loki).
 * Rendered beside the flag's controls on the tenant tab and the global
 * registry, and inside the reason dialog before an enable. Renders nothing for
 * an ordinary flag — or for any flag when an older master sends no policy.
 */
export function FlagPolicyWarning({ flag }: Props) {
  const warning = flag.policy?.warning;
  if (!warning) return null;
  return (
    <div className={styles.policyWarning} role="note">
      <AlertTriangle size={14} aria-hidden="true" />
      <span>{warning}</span>
    </div>
  );
}
