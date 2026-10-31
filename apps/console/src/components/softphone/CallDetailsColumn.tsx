import { useId, useMemo } from 'react';
import { CallFieldsForm } from './CallFieldsForm';
import { resolveContextFields } from '../../utils/agencyContext';
import { attemptOutcomeLabel } from '../../types/agency-spine';
import { formatDayMonth } from '../../utils/format/date';
import { dispositionLabel } from '../../utils/agencySpineCopy';
import type { SoftphoneState } from '../../hooks/useSoftphone';
import type { AgencyManualCallContact } from '../../types/softphone';
import type { AgencyContextDisplay, AgencyDisposition } from '../../types/agency';
import styles from './SoftphoneView.module.css';

/**
 * `calling_window_open` is the campaign's window in the campaign's default
 * timezone; the dial is checked in the contact's when the number is on the
 * roster (SP2), so this can only say "may".
 */
export const SOFTPHONE_WINDOW_CLOSED_HINT =
  'Outside this campaign’s calling hours (campaign time). Calling may need a reason.';

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '—';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}

/**
 * Column 2: which campaign the call is logged to, the roster contact the number
 * matched, and the call details the agent fills in.
 *
 * ── The campaign is a tag, fixed once dialled ────────────────────────────────
 * Caller ID, recording and summary profile are written onto the call when it is
 * placed and cannot change afterwards (`docs/softphone.md` §2), so the "Log to"
 * picker is live only before Call and says "Fixed for this call" after.
 */
export function CallDetailsColumn({ sp }: { sp: SoftphoneState }) {
  const selectId = useId();
  const campaign = sp.campaign;
  const untagged = sp.bootstrap?.untagged ?? null;
  const profile = campaign ? campaign.analysis_profile : (untagged?.analysis_profile ?? null);
  const records = campaign ? campaign.record_calls : Boolean(untagged?.record_calls);

  return (
    <div className={styles.column}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>Call details</h2>
        <p className={styles.hint}>Saved with the call, shown beside the summary</p>
      </div>

      <div className={styles.campaignCard} data-testid="log-to">
        <span
          className={`${styles.campaignMark} ${campaign ? '' : styles.campaignMarkNone}`}
          aria-hidden="true"
        >
          {campaign ? initials(campaign.campaign_name) : '—'}
        </span>
        <div className={styles.campaignText}>
          {sp.setupEditable ? (
            <>
              <label htmlFor={selectId} className={styles.fieldLabel}>
                Log to
              </label>
              <select
                id={selectId}
                className={styles.campaignSelect}
                value={sp.tagCampaignId ?? ''}
                onChange={(event) => sp.setTagCampaignId(event.target.value || null)}
                data-testid="log-to-select"
              >
                <option value="">Not logged to a campaign</option>
                {sp.taggableCampaigns.map((c) => (
                  <option key={c.campaign_id} value={c.campaign_id}>
                    {c.campaign_name}
                    {c.status !== 'running' ? ` (${c.status})` : ''}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <span className={styles.campaignName} data-testid="log-to-fixed">
              {campaign ? campaign.campaign_name : 'Not logged to a campaign'}
            </span>
          )}
          <span className={styles.hint}>
            {campaign
              ? 'Uses this campaign’s outcomes, caller IDs and summary profile'
              : 'Uses the soft phone’s own outcomes and your account’s numbers'}
          </span>
          {sp.setupEditable && campaign && !campaign.calling_window_open ? (
            <span className={styles.hint} data-testid="window-closed-hint">
              {SOFTPHONE_WINDOW_CLOSED_HINT}
            </span>
          ) : null}
        </div>
        {sp.setupEditable || (sp.finishOnly && !sp.call) ? null : <span className={styles.hint}>Fixed for this call</span>}
      </div>

      {sp.call?.contact ? (
        <ContactCard
          contact={sp.call.contact}
          display={campaign?.context_display}
          catalog={campaign?.disposition_catalog}
          campaignId={campaign?.campaign_id ?? sp.call.tag?.campaign_id ?? null}
          campaignName={campaign?.campaign_name ?? sp.call.tag?.campaign_name ?? 'this campaign'}
        />
      ) : null}

      <CallFieldsForm
        fields={sp.fields}
        values={sp.fieldValues}
        errors={sp.fieldErrors}
        disabled={sp.placing || (sp.finishOnly && !sp.call)}
        loading={sp.bootstrap === null}
        onChange={sp.setFieldValue}
      />

      <p className={styles.aiNote}>
        <span className={styles.sourceBadge}>AI</span>
        <span>
          {records
            ? profile
              ? `After the call, the summary profile ${profile.name} writes its summary and custom dimensions.`
              : 'After the call, your account’s default summary profile writes its summary.'
            : 'Calls logged here are not recorded, so they are not summarised.'}
        </span>
      </p>
    </div>
  );
}

function ContactCard({
  contact,
  display,
  catalog,
  campaignId,
  campaignName,
}: {
  contact: AgencyManualCallContact;
  display: AgencyContextDisplay | undefined;
  catalog: AgencyDisposition[] | undefined;
  campaignId: string | null;
  campaignName: string;
}) {
  const resolved = useMemo(
    () => (contact.context ? resolveContextFields(contact.context, display) : null),
    [contact.context, display],
  );
  const shown = resolved ? [...resolved.hero, ...resolved.fields].filter((f) => !f.isEmpty).slice(0, 6) : [];
  const last = contact.prior_attempts?.[0] ?? null;
  const lastWhen = last?.ended_at ?? last?.dialed_at ?? null;
  const lastLine = last
    ? `Last campaign call: ${lastWhen ? `${formatDayMonth(new Date(lastWhen))}, ` : ''}${
        dispositionLabel(last.disposition_code, last.campaign_id === campaignId ? catalog : undefined) ?? attemptOutcomeLabel(last.outcome)
      }.`
    : 'No earlier campaign calls.';

  return (
    <section className={styles.contactCard} aria-label="Roster contact" data-testid="roster-contact">
      <div className={styles.contactHead}>
        <span className={`${styles.pill} ${styles.pillSuccess}`}>On the roster</span>
        <span>This number is a contact in {campaignName}. {lastLine}</span>
      </div>
      {shown.length > 0 ? (
        <dl className={styles.contactFacts}>
          {shown.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className={styles.hint} data-testid="contact-claim">
        {contact.claimed
          ? 'Its outcome updates this contact in the campaign.'
          : 'The campaign isn’t waiting on this contact, so only a Do Not Call outcome changes it.'}
      </p>
    </section>
  );
}
