import type { ReactNode } from 'react';
import type {
  CustomerTimelineCampaignCall,
  CustomerTimelineEntry,
  CustomerTimelineSoftphoneCall,
} from '@magick-agency/contracts/api/agency/customer-history';
import { attemptOutcomeLabel } from '@magick-agency/contracts/api/agency/agency-spine';
import { DNC_SOURCE_LABELS } from '@magick-agency/contracts/api/agency/dnc';
import { durationWords } from '../../../utils/format/duration';
import {
  CALLBACK_STATUS_LABELS,
  RECORDING_LABELS,
  dncScopeLabel,
  fieldValueLabel,
  formatWhen,
  overrideAppliedLabel,
} from '../../../utils/customerHistoryCopy';
import { CustomerCallLink } from './CustomerCallLink';
import styles from './CustomerHistory.module.css';

function agentName(agent: { name: string | null } | null): string {
  if (!agent) return 'No agent';
  return agent.name ?? 'A former user';
}

function Notes({ notes, hidden }: { notes: string | null; hidden: boolean }) {
  if (hidden) return <p className={styles.muted} data-testid="customer-notes-hidden">Notes hidden</p>;
  if (!notes) return null;
  return <p className={styles.note} data-testid="customer-notes">{notes}</p>;
}

function CallFacts({ entry }: { entry: CustomerTimelineCampaignCall | CustomerTimelineSoftphoneCall }) {
  return (
    <ul className={styles.meta}>
      <li>{agentName(entry.agent)}</li>
      <li>{attemptOutcomeLabel(entry.outcome)}</li>
      {entry.disposition_code && <li>Outcome code: {entry.disposition_code}</li>}
      {entry.talk_seconds != null && entry.talk_seconds > 0 && <li>Talk time {durationWords(entry.talk_seconds)}</li>}
      <li data-testid="customer-recording">{RECORDING_LABELS[entry.recording]}</li>
    </ul>
  );
}

function Row({ entry, title, children }: { entry: CustomerTimelineEntry; title: ReactNode; children?: ReactNode }) {
  return (
    <li className={styles.entry} data-testid="customer-timeline-entry" data-kind={entry.kind}>
      <div className={styles.entryHead}>
        <span className={styles.entryTitle}>{title}</span>
        <time className={styles.entryWhen} dateTime={entry.at}>{formatWhen(entry.at)}</time>
      </div>
      {children}
    </li>
  );
}

function CampaignCallRow({ entry }: { entry: CustomerTimelineCampaignCall }) {
  return (
    <Row entry={entry} title={<>Campaign call · {entry.campaign.name}</>}>
      <CallFacts entry={entry} />
      <ul className={styles.meta}>
        <li>Attempt {entry.attempt_number}</li>
        {entry.redial_of_attempt_id && (
          <li data-testid="customer-redial">Wrap-up redial {entry.redial_number}</li>
        )}
        {entry.callback_at && <li>Callback booked for {formatWhen(entry.callback_at)}</li>}
      </ul>
      <Notes notes={entry.notes} hidden={entry.notes_hidden} />
      {entry.override_applied.length > 0 && (
        <p className={styles.note} data-testid="customer-override">
          Override used: {overrideAppliedLabel(entry.override_applied)}
          {entry.override_note ? ` · “${entry.override_note}”` : ''}
        </p>
      )}
      <CustomerCallLink entry={entry} />
    </Row>
  );
}

function SoftphoneCallRow({ entry }: { entry: CustomerTimelineSoftphoneCall }) {
  const fields = entry.fields ? Object.entries(entry.fields) : [];
  return (
    <Row entry={entry} title={<>Soft-phone call{entry.campaign ? ` · ${entry.campaign.name}` : ''}</>}>
      <CallFacts entry={entry} />
      {entry.callback_at && (
        <ul className={styles.meta}>
          <li>Callback booked for {formatWhen(entry.callback_at)}</li>
        </ul>
      )}
      <Notes notes={entry.notes} hidden={entry.notes_hidden} />
      {fields.length > 0 && (
        <dl className={styles.fields} data-testid="customer-call-fields">
          {fields.map(([key, value]) => (
            <div key={key} className={styles.fieldPair}>
              <dt>{key}</dt>
              <dd>{fieldValueLabel(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {entry.dnc_override_note && <p className={styles.note}>Called despite do-not-call: “{entry.dnc_override_note}”</p>}
      {entry.hours_override_note && (
        <p className={styles.note}>Called outside calling hours: “{entry.hours_override_note}”</p>
      )}
      <CustomerCallLink entry={entry} />
    </Row>
  );
}

export function CustomerTimelineRow({ entry }: { entry: CustomerTimelineEntry }) {
  switch (entry.kind) {
    case 'campaign_call':
      return <CampaignCallRow entry={entry} />;
    case 'softphone_call':
      return <SoftphoneCallRow entry={entry} />;
    case 'callback':
      return (
        <Row entry={entry} title={<>Callback · {CALLBACK_STATUS_LABELS[entry.status]}</>}>
          <ul className={styles.meta}>
            <li>Due {formatWhen(entry.due_at)}</li>
            {entry.campaign && <li>{entry.campaign.name}</li>}
            <li>Booked by {agentName(entry.booked_by)}</li>
            {entry.dialled_at && <li>Next call {formatWhen(entry.dialled_at)}</li>}
          </ul>
        </Row>
      );
    case 'dnc_mark':
      return (
        <Row entry={entry} title="Added to a do-not-call list">
          <ul className={styles.meta}>
            <li>{dncScopeLabel(entry.entry)}</li>
            <li>{DNC_SOURCE_LABELS[entry.entry.source] ?? entry.entry.source}</li>
            {entry.entry.added_by && <li>By {entry.entry.added_by}</li>}
          </ul>
          {entry.entry.reason && <p className={styles.note}>“{entry.entry.reason}”</p>}
        </Row>
      );
    case 'roster_entry':
      return (
        <Row
          entry={entry}
          title={
            entry.upload_file_name
              ? `Added to ${entry.campaign.name} from ${entry.upload_file_name}`
              : `Added to ${entry.campaign.name}`
          }
        />
      );
  }
}

export function CustomerTimelineList({ entries }: { entries: CustomerTimelineEntry[] }) {
  return (
    <ol className={styles.timeline} aria-label="Timeline, newest first">
      {entries.map((entry) => (
        <CustomerTimelineRow key={entry.key} entry={entry} />
      ))}
    </ol>
  );
}
