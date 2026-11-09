import { CLIP_SLOT_LABELS } from '../../../utils/inbound/inboundCopy';
import {
  AGENCY_INBOUND_CLIP_SLOTS,
  AGENCY_INBOUND_SLOT_STANDARD,
  type AgencyInboundClipOption,
  type AgencyInboundClipSlot,
} from '../../../types/inbound';
import type { RecordingSource } from '../../../api/inboundRecordings';
import styles from '../../../components/agency/inbound/Inbound.module.css';
import { InboundRecordingsPanel } from '../InboundRecordingsPanel';
import { RecordingPreview } from './RecordingPreview';
import type { RouteSectionProps } from './fields';

/**
 * What a message's preview plays: the recording chosen for it, else our standard recording that
 * stands in for it (`AGENCY_INBOUND_SLOT_STANDARD`); null for the hold with none chosen (the
 * built-in hold tone is made as it plays, so there is no file to hear).
 */
export function slotPreview(
  slot: AgencyInboundClipSlot,
  chosen: string | null,
  clips: readonly AgencyInboundClipOption[],
): { source: RecordingSource; label: string } | null {
  const message = `the ${CLIP_SLOT_LABELS[slot].label} message`;
  if (chosen) {
    const clip = clips.find((c) => c.id === chosen);
    return { source: { kind: 'uploaded', clipId: chosen }, label: `${message} (${clip ? clip.name : 'the current recording'})` };
  }
  const standard = AGENCY_INBOUND_SLOT_STANDARD[slot];
  return standard ? { source: { kind: 'standard', recording: standard }, label: `${message} (our standard recording)` } : null;
}

/**
 * "What callers hear": a recording, or our standard one, for each message, each with a Play that
 * plays what the choice means; then the account's recordings (`InboundRecordingsPanel`).
 */
export function RouteClipsCard({
  draft,
  update,
  errors,
  clips,
  uploadAvailable,
  tenantId,
  accountId,
  onUploaded,
  onDeleted,
  onStale,
}: RouteSectionProps & {
  clips: AgencyInboundClipOption[];
  uploadAvailable: boolean;
  tenantId: string | undefined;
  accountId: string | undefined;
  onUploaded: (clip: AgencyInboundClipOption) => void;
  onDeleted: (clipId: string) => void;
  onStale: () => void;
}) {
  const chosenClips = new Set(Object.values(draft.clips).filter((id): id is string => id !== null));
  return (
    <section className="card" aria-labelledby="ib-clips" data-testid="inbound-route-clips">
      <h2 className={styles.cardTitle} id="ib-clips">What callers hear</h2>
      <p className={styles.cardLead}>
        Choose one of this account’s recordings for each message, or leave it on our standard recording: a short
        message in a British English voice, with the words shown under each choice. Press Play to hear what callers
        will hear. Callers who wait for an agent hear our “please hold” when there is no greeting, then the hold
        sound. Upload your own recordings below.
      </p>
      <div className={styles.fields}>
        {AGENCY_INBOUND_CLIP_SLOTS.map((slot) => {
          const id = `ib-clip-${slot}`;
          const current = draft.clips[slot];
          const known = current === null || clips.some((c) => c.id === current);
          const preview = slotPreview(slot, current, clips);
          return (
            <div key={slot} className="form-group">
              <label htmlFor={id}>{CLIP_SLOT_LABELS[slot].label}</label>
              <select
                id={id}
                value={current ?? ''}
                onChange={(e) => update({ clips: { ...draft.clips, [slot]: e.target.value || null } })}
                aria-describedby={[`${id}-hint`, errors.describedBy(`clips.${slot}`)].filter(Boolean).join(' ')}
              >
                <option value="">{CLIP_SLOT_LABELS[slot].none}</option>
                {known ? null : <option value={current!}>Current recording</option>}
                {clips.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <span className={styles.hint} id={`${id}-hint`}>{CLIP_SLOT_LABELS[slot].hint}</span>
              {preview ? (
                <RecordingPreview
                  key={current ?? 'standard'}
                  source={preview.source}
                  label={preview.label}
                  tenantId={tenantId}
                  accountId={accountId}
                  testId={`inbound-clip-preview-${slot}`}
                />
              ) : null}
              {errors.render(`clips.${slot}`)}
            </div>
          );
        })}
      </div>
      <InboundRecordingsPanel
        clips={clips}
        chosen={chosenClips}
        uploadAvailable={uploadAvailable}
        tenantId={tenantId}
        accountId={accountId}
        onUploaded={onUploaded}
        onDeleted={onDeleted}
        onStale={onStale}
      />
    </section>
  );
}
