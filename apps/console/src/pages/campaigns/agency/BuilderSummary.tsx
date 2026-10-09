import { describeDays, type CampaignConfigState } from '../../../utils/agencyCampaignConfigForm';
import type { AgencyIngestJob } from '../../../types/agency-campaign';
import type { UploadPhase } from '../../../hooks/useRosterIngest';
import type { BuilderStepId } from './builderFlow';
import styles from './BuilderSummary.module.css';

export interface BuilderSummaryProps {
  name: string;
  callerIds: readonly string[];
  phase: UploadPhase;
  job: AgencyIngestJob | null;
  config: CampaignConfigState;
  current: BuilderStepId;
  onJump: (id: BuilderStepId) => void;
}

function contactsLine(phase: UploadPhase, job: AgencyIngestJob | null): string {
  if (phase === 'uploading') return 'Uploading…';
  if (phase === 'analyzing') return 'Reading columns…';
  if (phase === 'mapping') return job?.file_name ?? 'File ready to map';
  if (phase === 'ingesting') return 'Importing…';
  if (phase === 'done' && job) {
    if (job.dry_run) return 'Checked — nothing imported yet';
    return `${job.accepted.toLocaleString()} contacts ready`;
  }
  return 'Not added yet';
}

/**
 * Living summary of the campaign as it is being built.
 *
 * The point is orientation, not a second editor: each row is a jump back
 * to the step that owns it, so an operator who spots a wrong timezone on
 * review does not have to remember which screen that lived on.
 */
export function BuilderSummary({
  name,
  callerIds,
  phase,
  job,
  config,
  current,
  onJump,
}: BuilderSummaryProps) {
  const contactsImported = phase === 'done' && job !== null && !job.dry_run;
  const hoursPreview = `${describeDays(config.window.days)} · ${config.window.start}–${config.window.end} · ${config.window.timezone}`;

  return (
    <aside className={styles.rail} aria-label="Campaign summary">
      <h2 className={styles.heading}>Your campaign</h2>
      <dl className={styles.list}>
        <SummaryRow
          label="Name"
          value={name.trim() || 'Not named yet'}
          ready={name.trim().length > 0}
          current={current === 'basics'}
          onClick={() => onJump('basics')}
        />
        <SummaryRow
          label="Call from"
          value={
            callerIds.length === 0
              ? 'No numbers yet'
              : callerIds.length === 1
                ? callerIds[0]!
                : `${callerIds[0]} +${callerIds.length - 1} more`
          }
          ready={callerIds.length > 0}
          current={current === 'basics'}
          onClick={() => onJump('basics')}
        />
        <SummaryRow
          label="Contacts"
          value={contactsLine(phase, job)}
          ready={contactsImported}
          current={current === 'contacts'}
          onClick={() => onJump('contacts')}
        />
        <SummaryRow
          label="Hours"
          value={hoursPreview}
          ready
          current={current === 'hours'}
          onClick={() => onJump('hours')}
        />
        <SummaryRow
          label="Agents"
          value={`${config.dispositions.length} outcomes · ${
            config.wrapupSeconds === 0 ? 'no wrap-up' : `${config.wrapupSeconds}s wrap-up`
          }`}
          ready
          current={current === 'behaviour'}
          onClick={() => onJump('behaviour')}
        />
      </dl>
      <p className={styles.note}>Nothing is dialed until you start the campaign.</p>
    </aside>
  );
}

function SummaryRow({
  label,
  value,
  ready,
  current,
  onClick,
}: {
  label: string;
  value: string;
  ready: boolean;
  current: boolean;
  onClick: () => void;
}) {
  return (
    <div className={styles.row} data-current={current || undefined} data-ready={ready || undefined}>
      <dt>{label}</dt>
      <dd>
        <button type="button" className={styles.jump} onClick={onClick}>
          {value}
        </button>
      </dd>
    </div>
  );
}
