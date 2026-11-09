import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { fetchRecordingBlobUrl, type RecordingAudio, type RecordingSource } from '../../../api/inboundRecordings';
import styles from '../InboundRecordings.module.css';

/**
 * Hear a recording in the route editor (`docs/inbound.md` §8.4): one of the account's, or our
 * standard recording a message plays when it has none. Fetched only when asked for, with the
 * console's bearer token (an `<audio src>` cannot send it), into a blob URL revoked when the
 * preview goes; then the browser's own player, keyboard-operable and labelled, in its place (the
 * Missed list's voicemail player does the same). A parent that changes `source` gives the preview
 * a new `key`, so a new choice starts from Play.
 */
export function RecordingPreview({
  source,
  label,
  tenantId,
  accountId,
  testId,
}: {
  source: RecordingSource;
  /** What is played, for the button and the player: "Welcome", "the Closed message (our standard recording)". */
  label: string;
  tenantId: string | undefined;
  accountId: string | undefined;
  testId: string;
}) {
  const [state, setState] = useState<{ status: 'idle' } | { status: 'loading' } | RecordingAudio>({ status: 'idle' });
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
    const audio = await fetchRecordingBlobUrl(source, tenantId, accountId);
    if (!mounted.current) {
      if (audio.status === 'ready') URL.revokeObjectURL(audio.url);
      return;
    }
    if (audio.status === 'ready') urlRef.current = audio.url;
    setState(audio);
  };

  if (state.status === 'ready') {
    return <audio className={styles.player} controls autoPlay src={state.url} aria-label={label} data-testid={`${testId}-audio`} />;
  }
  return (
    <span className={styles.previewRow}>
      <button
        type="button"
        className={styles.previewButton}
        onClick={() => void load()}
        disabled={state.status === 'loading' || !tenantId}
        aria-label={`Play ${label}`}
        data-testid={`${testId}-play`}
      >
        <Play size={13} aria-hidden="true" />
        {state.status === 'loading' ? 'Loading…' : 'Play'}
      </button>
      {state.status === 'unavailable' ? (
        <span className={styles.error} role="alert" data-testid={`${testId}-error`}>
          {state.message}
        </span>
      ) : null}
    </span>
  );
}
