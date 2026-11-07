import { memo, useMemo, type ReactNode } from 'react';
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
import { actorName } from '../../../utils/agency/insights/copy';
import { AUTO_DISPOSITION_HINT, autoDispositionLabel } from '../../../utils/agencySpineCopy';
import { CustomerCallLink } from './CustomerCallLink';
import styles from './CustomerHistory.module.css';

function Notes({ notes, hidden }: { notes: string | null; hidden: boolean }) {
  if (hidden) return <p className={styles.muted} data-testid="customer-notes-hidden">Notes hidden</p>;
  if (!notes) return null;
  return <p className={styles.note} data-testid="customer-notes">{notes}</p>;
}

function CallFacts({ entry }: { entry: CustomerTimelineCampaignCall | CustomerTimelineSoftphoneCall }) {
  return (
    <ul className={styles.meta}>
      <li>{actorName(entry.agent, 'No agent')}</li>
      <li>{attemptOutcomeLabel(entry.outcome)}</li>
      {entry.disposition_code && <li>Outcome code: {entry.disposition_code}</li>}
      {/* Filed by the campaign's unanswered-call mapping, not a person (campaign calls only). */}
      {entry.kind === 'campaign_call' && entry.auto_disposition_code && (
        <li title={AUTO_DISPOSITION_HINT} data-testid="customer-auto-disposition">
          Outcome code: {autoDispositionLabel(entry.auto_disposition_code)}
        </li>
      )}
      {entry.talk_seconds != null && entry.talk_seconds > 0 && <li>Talk time {durationWords(entry.talk_seconds)}</li>}
      <li data-testid="customer-recording">{RECORDING_LABELS[entry.recording]}</li>
    </ul>
  );
}

function Row({
  entry,
  title,
  children,
  chain,
}: {
  entry: CustomerTimelineEntry;
  title: ReactNode;
  children?: ReactNode;
  /** A wrap-up redial chain's first attempt, on the chain's rows. */
  chain?: { id: string; redial: boolean };
}) {
  return (
    <li
      className={chain?.redial ? `${styles.entry} ${styles.chained}` : styles.entry}
      data-testid="customer-timeline-entry"
      data-kind={entry.kind}
      data-chain={chain?.id}
    >
      <div className={styles.entryHead}>
        <span className={styles.entryTitle}>{title}</span>
        <time className={styles.entryWhen} dateTime={entry.at}>{formatWhen(entry.at)}</time>
      </div>
      {children}
    </li>
  );
}

/**
 * The wrap-up redial chains among the loaded rows: each chain's first attempt, and
 * how many of its redials are loaded. A redial names `chain_attempt_id` (the
 * chain's first attempt) and `redial_of_attempt_id` (the dial it redialled).
 */
interface RedialChains {
  firsts: Map<string, CustomerTimelineCampaignCall>;
  redials: Map<string, number>;
}

function redialChains(entries: readonly CustomerTimelineEntry[]): RedialChains {
  const firsts = new Map<string, CustomerTimelineCampaignCall>();
  const redials = new Map<string, number>();
  for (const e of entries) {
    if (e.kind !== 'campaign_call') continue;
    if (e.redial_of_attempt_id) redials.set(e.chain_attempt_id, (redials.get(e.chain_attempt_id) ?? 0) + 1);
    else if (e.attempt_id === e.chain_attempt_id) firsts.set(e.attempt_id, e);
  }
  return { firsts, redials };
}

function CampaignCallRow({ entry, chains }: { entry: CustomerTimelineCampaignCall; chains: RedialChains }) {
  const isRedial = entry.redial_of_attempt_id !== null;
  const first = isRedial ? chains.firsts.get(entry.chain_attempt_id) : undefined;
  const redialsLoaded = isRedial ? 0 : chains.redials.get(entry.attempt_id) ?? 0;
  const inChain = isRedial || redialsLoaded > 0;
  return (
    <Row
      entry={entry}
      title={<>Campaign call · {entry.campaign.name}</>}
      chain={inChain ? { id: entry.chain_attempt_id, redial: isRedial } : undefined}
    >
      <CallFacts entry={entry} />
      <ul className={styles.meta}>
        <li>Attempt {entry.attempt_number}</li>
        {isRedial && (
          <li data-testid="customer-redial">
            Wrap-up redial {entry.redial_number} of{' '}
            {first ? `the call at ${formatWhen(first.at)}` : 'an earlier call'}
          </li>
        )}
        {redialsLoaded > 0 && (
          <li data-testid="customer-redial-first">
            Redialled in wrap-up {redialsLoaded === 1 ? 'once' : `${redialsLoaded} times`}
          </li>
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

function CustomerTimelineRow({ entry, chains }: { entry: CustomerTimelineEntry; chains: RedialChains }) {
  switch (entry.kind) {
    case 'campaign_call':
      return <CampaignCallRow entry={entry} chains={chains} />;
    case 'softphone_call':
      return <SoftphoneCallRow entry={entry} />;
    case 'callback':
      return (
        <Row entry={entry} title={<>Callback · {CALLBACK_STATUS_LABELS[entry.status]}</>}>
          <ul className={styles.meta}>
            <li>Due {formatWhen(entry.due_at)}</li>
            {entry.campaign && <li>{entry.campaign.name}</li>}
            <li>Booked by {actorName(entry.booked_by, 'No agent')}</li>
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

/** Memoised: the page re-renders on every loading or export flag, and `entries` only changes with the rows. */
export const CustomerTimelineList = memo(function CustomerTimelineList({ entries }: { entries: CustomerTimelineEntry[] }) {
  const chains = useMemo(() => redialChains(entries), [entries]);
  return (
    <ol className={styles.timeline} aria-label="Timeline, newest first">
      {entries.map((entry) => (
        <CustomerTimelineRow key={entry.key} entry={entry} chains={chains} />
      ))}
    </ol>
  );
});
