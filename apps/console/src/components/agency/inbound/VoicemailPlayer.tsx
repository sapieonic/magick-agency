import { Play } from 'lucide-react';
import { fetchVoicemailBlobUrl } from '../../../api/inbound';
import { useTenant } from '../../../contexts/TenantContext';
import { useLazyBlobAudio } from '../../../hooks/useLazyBlobAudio';
import styles from './Inbound.module.css';

/**
 * A Missed row's voicemail (P2, `voicemail_url`). Fetched only when the reader asks for it — a
 * page of fifty rows must not download fifty recordings — with the console's bearer token,
 * which an `<audio src>` cannot send, so it plays from a blob URL revoked when the row goes.
 * The player is the browser's own: its controls are keyboard-operable and labelled.
 */
export function VoicemailPlayer({ voicemailUrl, callerLabel }: { voicemailUrl: string; callerLabel: string }) {
  const { tenantId, accountId } = useTenant();
  const { state, load } = useLazyBlobAudio(() =>
    tenantId ? fetchVoicemailBlobUrl(voicemailUrl, tenantId, accountId ?? undefined) : null,
  );

  if (state.status === 'ready') {
    return (
      <audio
        className={styles.voicemail}
        controls
        autoPlay
        src={state.url}
        aria-label={`Voicemail from ${callerLabel}`}
        data-testid="missed-voicemail-audio"
      />
    );
  }

  return (
    <span className={styles.voicemailRow}>
      <button
        type="button"
        className="btn-secondary"
        onClick={() => void load()}
        disabled={state.status === 'loading'}
        aria-label={`Play the voicemail from ${callerLabel}`}
        data-testid="missed-voicemail-play"
      >
        <Play size={13} aria-hidden="true" />
        {state.status === 'loading' ? 'Loading…' : 'Play voicemail'}
      </button>
      {state.status === 'unavailable' ? (
        <span className="error-text" role="alert" data-testid="missed-voicemail-error">
          {state.message}
        </span>
      ) : null}
    </span>
  );
}
