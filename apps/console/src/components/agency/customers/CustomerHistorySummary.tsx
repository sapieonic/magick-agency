import { memo } from 'react';
import type {
  CustomerHistoryContact,
  CustomerHistoryDncEntry,
  CustomerHistorySummary as Summary,
} from '@magick-agency/contracts/api/agency/customer-history';
import { attemptOutcomeLabel, contactStateLabel, suppressedReasonLabel } from '@magick-agency/contracts/api/agency/agency-spine';
import { DNC_SOURCE_LABELS } from '@magick-agency/contracts/api/agency/dnc';
import { AgencyCampaignStatusBadge } from '../../../pages/agency/AgencyCampaignStatusBadge';
import {
  CHANNEL_LABELS,
  CONTACTS_TRUNCATED_NOTE,
  campaignChainLabel,
  dncScopeLabel,
  formatWhen,
  overrideFollowUpLabel,
  overrideGrantLabel,
} from '../../../utils/customerHistoryCopy';
import { actorName } from '../../../utils/agency/insights/copy';
import styles from './CustomerHistory.module.css';

function ContactCard({ contact, showAccount }: { contact: CustomerHistoryContact; showAccount: boolean }) {
  const reason = contact.state === 'suppressed' ? suppressedReasonLabel(contact.suppressed_reason) : null;
  return (
    <li className={styles.contact} data-testid="customer-contact">
      <div className={styles.contactHead}>
        <span className={styles.contactCampaign}>{campaignChainLabel(contact.campaigns.length > 0 ? contact.campaigns : [contact.campaign])}</span>
        <AgencyCampaignStatusBadge status={contact.campaign.status} />
      </div>
      {contact.fields.length > 0 && (
        <dl className={styles.fields}>
          {contact.fields.map((f) => (
            <div key={f.column} className={styles.fieldPair}>
              <dt>{f.column}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <ul className={styles.meta}>
        <li>
          {contactStateLabel(contact.state)}
          {reason ? `: ${reason}` : ''}
        </li>
        <li>
          {contact.attempt_count} {contact.attempt_count === 1 ? 'call placed' : 'calls placed'}
        </li>
        <li>{contact.assigned_to ? `Assigned to ${actorName(contact.assigned_to)}` : 'Shared pool'}</li>
        <li>
          Added {formatWhen(contact.entered_at)}
          {contact.upload_file_name ? ` from ${contact.upload_file_name}` : ''}
        </li>
        {showAccount && contact.account_name && <li>Account: {contact.account_name}</li>}
      </ul>
    </li>
  );
}

export function DncStatus({ entries }: { entries: CustomerHistoryDncEntry[] }) {
  return (
    <section className={`card ${styles.section}`} aria-labelledby="customer-dnc-heading">
      <h2 id="customer-dnc-heading" className={styles.sectionTitle}>Do-not-call status</h2>
      {entries.length === 0 ? (
        <p className={styles.muted} data-testid="customer-dnc-none">Not on any do-not-call list</p>
      ) : (
        <ul className={styles.list}>
          {entries.map((entry) => (
            <li key={entry.id} data-testid="customer-dnc-entry">
              <strong>{dncScopeLabel(entry)}</strong>
              <span className={styles.muted}>
                {' · '}
                {/* The source label already says who in general ("Marked by an agent"); the person follows it. */}
                {DNC_SOURCE_LABELS[entry.source] ?? entry.source}
                {entry.added_by ? ` · ${entry.added_by}` : ''}
                {' · '}
                {formatWhen(entry.created_at)}
              </span>
              {entry.reason && <div className={styles.note}>“{entry.reason}”</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Memoised: the page re-renders on every loading or export flag; `summary` is the answer's, `showAccounts` a boolean. */
export const CustomerHistorySummary = memo(function CustomerHistorySummary({
  summary,
  showAccounts,
}: {
  summary: Summary;
  showAccounts: boolean;
}) {
  const { contacts, totals, open } = summary;
  const last = totals.last_contacted;
  const nothingOpen = open.callbacks.length === 0 && open.overrides.length === 0 && open.live_calls.length === 0;

  return (
    <div className={styles.summary}>
      <section className={`card ${styles.section}`} aria-labelledby="customer-contacts-heading">
        <h2 id="customer-contacts-heading" className={styles.sectionTitle}>Who this number belongs to</h2>
        {summary.contacts_truncated && (
          <p className={styles.muted} data-testid="customer-contacts-truncated">{CONTACTS_TRUNCATED_NOTE}</p>
        )}
        {contacts.length === 0 ? (
          <p className={styles.muted}>This number is not on any roster you can see.</p>
        ) : (
          <ul className={styles.contacts}>
            {contacts.map((c) => (
              <ContactCard key={c.contact_id} contact={c} showAccount={showAccounts} />
            ))}
          </ul>
        )}
      </section>

      <section className={`card ${styles.section}`} aria-labelledby="customer-totals-heading">
        <h2 id="customer-totals-heading" className={styles.sectionTitle}>Calls</h2>
        <dl className={styles.totals}>
          <div>
            <dt>Calls placed</dt>
            <dd data-testid="customer-total-calls">{totals.calls}</dd>
          </div>
          <div>
            <dt>Connected</dt>
            <dd data-testid="customer-total-connected">{totals.connected}</dd>
          </div>
        </dl>
        <p className={styles.lastContacted} data-testid="customer-last-contacted">
          {last
            ? `Last contacted ${formatWhen(last.at)} by ${actorName(last.agent, 'no agent')} · ${CHANNEL_LABELS[last.channel]} · ${attemptOutcomeLabel(last.outcome)}${last.disposition_code ? ` · ${last.disposition_code}` : ''}`
            : 'Never contacted'}
        </p>
      </section>

      <DncStatus entries={summary.dnc} />

      <section className={`card ${styles.section}`} aria-labelledby="customer-open-heading">
        <h2 id="customer-open-heading" className={styles.sectionTitle}>Open now</h2>
        {nothingOpen ? (
          <p className={styles.muted}>No callbacks due, overrides or live calls.</p>
        ) : (
          <ul className={styles.list}>
            {open.live_calls.map((call, i) => (
              <li key={`live-${i}`} data-testid="customer-live-call" className={styles.live}>
                <strong>Live now:</strong> {CHANNEL_LABELS[call.channel]}
                {call.campaign ? ` in ${call.campaign.name}` : ''} · {actorName(call.agent, 'no agent yet')} · started{' '}
                {formatWhen(call.started_at)}
              </li>
            ))}
            {open.callbacks.map((cb) => (
              <li key={`cb-${cb.contact_id}-${cb.due_at}`} data-testid="customer-open-callback">
                <strong>Callback due {formatWhen(cb.due_at)}</strong> · {cb.campaign.name} · for{' '}
                {cb.owner ? actorName(cb.owner) : 'the shared pool'}
                {cb.booked_by ? ` · booked by ${actorName(cb.booked_by)}` : ''}
              </li>
            ))}
            {open.overrides.map((o) => (
              <li key={`ov-${o.contact_id}-${o.granted_at}`} data-testid="customer-open-override">
                <strong>Override from {o.disposition_code}</strong> · {o.campaign.name} · {overrideGrantLabel(o)} · granted{' '}
                {formatWhen(o.granted_at)} ·{' '}
                <span data-testid="customer-open-override-follow-up">{overrideFollowUpLabel(o)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
});
