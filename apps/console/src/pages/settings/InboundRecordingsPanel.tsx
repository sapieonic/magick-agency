import { useRef, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { deleteInboundRecording, uploadInboundRecording, type RecordingRefusal } from '../../api/inboundRecordings';
import {
  INBOUND_REFUSAL_COPY,
  RECORDING_UPLOAD_REFUSAL_COPY,
  recordingLength,
  recordingUsedBy,
} from '../../utils/inbound/inboundCopy';
import { AGENCY_INBOUND_CLIP_UPLOAD_LIMITS as LIMITS, type AgencyInboundClipOption } from '../../types/inbound';
import styles from './InboundRecordings.module.css';
import { RecordingPreview } from './inbound-route/RecordingPreview';

/** What an upload or delete refusal says, in the editor's words. */
export function recordingRefusalCopy(refusal: RecordingRefusal): string {
  if (refusal.code === 'inbound_clip_invalid' || refusal.uploadReason) {
    return refusal.uploadReason ? RECORDING_UPLOAD_REFUSAL_COPY[refusal.uploadReason] : INBOUND_REFUSAL_COPY.inbound_clip_invalid;
  }
  if (refusal.code === 'inbound_clip_in_use') {
    const used = recordingUsedBy(refusal.routes);
    return used
      ? `${used}. Choose another recording there, then delete it.`
      : 'It’s used elsewhere in this account (an announcement), so it can’t be deleted.';
  }
  if (refusal.code === 'unknown') return refusal.message;
  return INBOUND_REFUSAL_COPY[refusal.code];
}

/**
 * The route editor's recordings (`docs/inbound.md` §8.4): upload a WAV, MP3 or OGG (checked by the
 * server before it is stored), and the account's recordings, each with a Play, the routes that
 * play it and a delete that is offered only for one no route plays. Without audio storage on the deployment
 * there is no upload, and the panel says callers hear our standard recordings.
 *
 * The page owns the list (the clip selects read it): an upload adds to it, a delete removes from
 * it, and a delete the server refuses as in use asks the page to reload it.
 */
export function InboundRecordingsPanel({
  clips,
  chosen,
  uploadAvailable,
  tenantId,
  accountId,
  onUploaded,
  onDeleted,
  onStale,
}: {
  clips: AgencyInboundClipOption[];
  /** The recordings chosen on the route being edited (saved or not): not deleted from under it. */
  chosen: ReadonlySet<string>;
  uploadAvailable: boolean;
  tenantId: string | undefined;
  accountId: string | undefined;
  onUploaded: (clip: AgencyInboundClipOption) => void;
  onDeleted: (clipId: string) => void;
  /** The list no longer matches the server's (a delete refused as in use, or gone). */
  onStale: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'done'; text: string } | null>(null);
  const [confirming, setConfirming] = useState<AgencyInboundClipOption | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const upload = async () => {
    if (!file) {
      setMessage({ tone: 'error', text: RECORDING_UPLOAD_REFUSAL_COPY.no_file });
      return;
    }
    if (file.size > LIMITS.max_bytes) {
      setMessage({ tone: 'error', text: RECORDING_UPLOAD_REFUSAL_COPY.too_large });
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await uploadInboundRecording(file, name, tenantId, accountId);
    setBusy(false);
    if (!result.ok) {
      setMessage({ tone: 'error', text: recordingRefusalCopy(result.refusal) });
      return;
    }
    onUploaded(result.value);
    setFile(null);
    setName('');
    if (fileInput.current) fileInput.current.value = '';
    setMessage({ tone: 'done', text: `“${result.value.name}” uploaded. Choose it for a message above.` });
  };

  const remove = async (clip: AgencyInboundClipOption) => {
    setConfirming(null);
    setBusy(true);
    setMessage(null);
    const result = await deleteInboundRecording(clip.id, tenantId, accountId);
    setBusy(false);
    if (result.ok) {
      onDeleted(clip.id);
      setMessage({ tone: 'done', text: `“${clip.name}” deleted.` });
      return;
    }
    setMessage({ tone: 'error', text: recordingRefusalCopy(result.refusal) });
    if (result.refusal.code === 'inbound_clip_in_use' || result.refusal.code === 'inbound_clip_not_found') onStale();
  };

  return (
    <div className={styles.panel} data-testid="inbound-recordings">
      <h3 className={styles.title}>Your recordings</h3>
      {uploadAvailable ? (
        <>
          <div className={styles.upload}>
            <div className="form-group">
              <label htmlFor="ib-recording-file">Upload a recording</label>
              <input
                ref={fileInput}
                id="ib-recording-file"
                type="file"
                accept={[...LIMITS.extensions, 'audio/wav', 'audio/mpeg', 'audio/ogg'].join(',')}
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setMessage(null);
                }}
                aria-describedby="ib-recording-file-hint"
                data-testid="inbound-recording-file"
              />
            </div>
            <div className="form-group">
              <label htmlFor="ib-recording-name">Name (optional)</label>
              <input
                id="ib-recording-name"
                value={name}
                maxLength={LIMITS.name_max}
                placeholder={file ? file.name.replace(/\.[^.]+$/, '') : 'Welcome message'}
                onChange={(e) => setName(e.target.value)}
                data-testid="inbound-recording-name"
              />
            </div>
            <button
              type="button"
              className={`btn-secondary ${styles.uploadButton}`}
              onClick={() => void upload()}
              disabled={busy || !file}
              data-testid="inbound-recording-upload"
            >
              <Upload size={14} aria-hidden="true" />
              {busy ? 'Working…' : 'Upload'}
            </button>
          </div>
          <p className={styles.note} id="ib-recording-file-hint">
            WAV, MP3 or OGG, up to {LIMITS.max_bytes / (1024 * 1024)} MB and {LIMITS.max_seconds / 60} minutes. Each file is
            checked before it’s saved.
          </p>
        </>
      ) : (
        <p className={styles.note} data-testid="inbound-recordings-unavailable">
          Recordings can’t be uploaded here yet: this service has no audio storage set up. Every message without one of
          your recordings plays our standard recording. Contact support to have storage set up.
        </p>
      )}
      <p role="status" aria-live="polite" className={message?.tone === 'error' ? styles.error : styles.note} data-testid="inbound-recordings-message">
        {message?.text ?? ''}
      </p>
      {clips.length === 0 ? (
        <p className={styles.note}>No recordings yet. Every message plays our standard recording.</p>
      ) : (
        <ul className={styles.list} aria-label="This account’s recordings">
          {clips.map((clip) => {
            const used = recordingUsedBy(clip.routes);
            const inUse = clip.routes.length > 0 || chosen.has(clip.id);
            const length = recordingLength(clip.duration_seconds);
            const metaId = `ib-recording-${clip.id}-meta`;
            return (
              <li key={clip.id} className={styles.item} data-testid={`inbound-recording-${clip.id}`}>
                <span className={styles.itemText}>
                  <span className={styles.name}>{clip.name}</span>
                  <span className={styles.meta} id={metaId}>
                    {[length, used || (chosen.has(clip.id) ? 'Chosen on this route' : 'Not used by any route')].filter(Boolean).join(' · ')}
                  </span>
                  <RecordingPreview
                    source={{ kind: 'uploaded', clipId: clip.id }}
                    label={clip.name}
                    tenantId={tenantId}
                    accountId={accountId}
                    testId={`inbound-recording-preview-${clip.id}`}
                  />
                </span>
                <button
                  type="button"
                  className={styles.delete}
                  onClick={() => setConfirming(clip)}
                  disabled={busy || inUse}
                  aria-label={`Delete ${clip.name}`}
                  aria-describedby={metaId}
                  title={inUse ? 'In use: choose another recording where it’s used first' : undefined}
                  data-testid={`inbound-recording-delete-${clip.id}`}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={confirming !== null}
        title="Delete this recording?"
        message={confirming ? `“${confirming.name}” will be deleted. No route plays it, so callers hear nothing different.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={() => confirming && void remove(confirming)}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
