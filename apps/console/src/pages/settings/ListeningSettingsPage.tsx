import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { Headphones } from 'lucide-react';
import { PageDescription } from '../../components/common/PageDescription';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { usePermission } from '../../hooks/usePermission';
import { LIVE_LISTEN_FLAG, LIVE_LISTEN_UNRECORDED_FLAG } from '../../utils/listen/liveListenFlag';
import { LISTEN_SETTINGS_COPY } from '../../utils/listen/listenCopy';
import styles from './ListeningSettingsPage.module.css';

/**
 * Settings → Live call listening (`docs/listening.md` §12, decision LS20 c): whether supervisors in
 * this account may listen to calls in progress and, when they may, whether calls that are not
 * recorded are included. Read-only, from the client flag map (`GET /feature-flags`, both flags
 * client-exposed), never a settings read of its own: the platform's administrators turn them on
 * and off, so the page says who to ask. The server still decides each row and each grant.
 *
 * While the flags are still being read the line says "Checking…", and a failed read offers Try
 * again: the flag map fails closed, so reading it then would say "Off" of an account that is on.
 */
export default function ListeningSettingsPage() {
  const supervise = usePermission('agency.supervise');
  const { isEnabled, status, reload } = useFeatureFlags();
  const on = isEnabled(LIVE_LISTEN_FLAG);
  const unrecorded = isEnabled(LIVE_LISTEN_UNRECORDED_FLAG);

  if (!supervise) {
    return (
      <div className={styles.page}>
        <PageHeader title={LISTEN_SETTINGS_COPY.title} />
        <EmptyState icon={<Headphones size={22} />} title={LISTEN_SETTINGS_COPY.title} description={LISTEN_SETTINGS_COPY.forbidden} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <PageHeader title={LISTEN_SETTINGS_COPY.title} />
      <PageDescription pageKey="listening-settings" description={LISTEN_SETTINGS_COPY.description} />
      {status === 'error' ? (
        <ErrorAlert message={LISTEN_SETTINGS_COPY.failed} onRetry={reload} />
      ) : (
        <section className="card" aria-labelledby="listening-setting-title">
          <h2 className={styles.cardTitle} id="listening-setting-title">
            {LISTEN_SETTINGS_COPY.cardTitle}
          </h2>
          <p className={styles.state} data-testid="listening-setting-state">
            {status === 'loading' ? LISTEN_SETTINGS_COPY.loading : on ? LISTEN_SETTINGS_COPY.on : LISTEN_SETTINGS_COPY.off}
          </p>
          {status === 'ready' && on ? (
            <p className={styles.detail} data-testid="listening-setting-unrecorded">
              {unrecorded ? LISTEN_SETTINGS_COPY.unrecordedIncluded : LISTEN_SETTINGS_COPY.unrecordedExcluded}
            </p>
          ) : null}
          {status === 'ready' ? (
            <p className={styles.change} data-testid="listening-setting-change">
              {LISTEN_SETTINGS_COPY.change}
            </p>
          ) : null}
        </section>
      )}
    </div>
  );
}
