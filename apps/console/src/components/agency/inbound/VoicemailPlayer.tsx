import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { fetchVoicemailBlobUrl } from '../../../api/inbound';
import { useTenant } from '../../../contexts/TenantContext';
import styles from './Inbound.module.css';

/**
 * A Missed row's voicemail (P2, `voicemail_url`). Fetched only when the reader asks for it — a
 * page of fifty rows must not download fifty recordings — with the console's bearer token,
 * which an `<audio src>` cannot send, so it plays from a blob URL revoked when the row goes.
 * The player is the browser's own: its controls are keyboard-operable and labelled.
 */
export function VoicemailPlayer({ voicemailUrl, callerLabel }: { voicemailUrl: string; callerLabel: string }) {
  const { tenantId, accountId } = useTenant();
  const [state, setState] = useState<
    { status: 'idle' } | { status: 'loading' } | { status: 'ready'; url: string } | { status: 'unavailable'; message: string }
  >({ status: 'idle' });
  const urlRef = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, []);

  const load = async () => {
    if (!tenantId || state.status === 'loading') return;
    setState({ status: 'loading' });
    const audio = await fetchVoicemailBlobUrl(voicemailUrl, tenantId, accountId ?? undefined);
    if (!mounted.current) {
      if (audio.status === 'ready') URL.revokeObjectURL(audio.url);
      return;
    }
    if (audio.status === 'ready') urlRef.current = audio.url;
    setState(audio);
  };

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
