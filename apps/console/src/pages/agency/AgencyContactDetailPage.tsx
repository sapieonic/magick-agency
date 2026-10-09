import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PhoneOutgoing, Play } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { getAgencyCampaign } from '../../api/agencyCampaigns';
import { getCampaignAttempts, getCampaignContact } from '../../api/agencySpine';
import { getErrorMessage } from '../../utils/errors';
import { resolveContextFields } from '../../utils/agencyContext';
import {
  agentCellCopy,
  contactSummaryLine,
  dispositionLabel,
  formatSpineTimestamp,
  formatTalkTime,
  recordingCellCopy,
} from '../../utils/agencySpineCopy';
import { Breadcrumbs } from '../../components/common/Breadcrumbs';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorAlert } from '../../components/common/ErrorAlert';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { AgencyCampaignStatusBadge } from './AgencyCampaignStatusBadge';
import {
  attemptOutcomeLabel,
  contactStateLabel,
  suppressedReasonLabel,
  type AgencyAttempt,
  type AgencyContactDetail,
} from '../../types/agency-spine';
import type { AgencyCampaign } from '../../types/agency-campaign';
import styles from './AgencyContactDetailPage.module.css';

/**
 * One contact's history is short in the ordinary case — the retry budget is
 * single digits — so this is sized to show the whole thing in one request
 * almost always, while still paging when `our_fault_attempts` redials or a long
 * campaign push it past.
 */
const PAGE_SIZE = 50;

/**
 * One contact: every attempt against it, its uploaded columns, and a way to
 * each attempt's recording.
 *
 * This is the "why was this number called four times" view — the question a
 * compliance request actually arrives asking, which the platform previously had
 * no surface for at all.
 *
 * ── The CSV columns are filtered before they are rendered ───────────────────
 * `context` is served here and nowhere else, and it goes through
 * `resolveContextFields` — the SAME resolver the agent console uses — so the
 * campaign's `context_display.hidden` applies here too. That is a decision, not
 * a convenience: the operator marked those columns not-for-screen for the agent
 * floor, and this screen has a wider audience than the one that rule was
 * written about. Columns marked `Ignore` at ingest never reach the stored data
 * at all, so they cannot appear whatever the render rules say.
 *
 * ── Every attempt, not every connected call ─────────────────────────────────
 * The list below is the contact's whole history: attempts that were abandoned
 * because no agent was free, ones that failed before dialing, and ones that
 * connected. `/app/calls/softphone/history` can only ever show the last kind.
 */
export function AgencyContactDetailPage() {
  const { id, contactId } = useParams<{ id: string; contactId: string }>();
  const { tenantId, accountId } = useTenant();

  const [campaign, setCampaign] = useState<AgencyCampaign | null>(null);
  /**
   * Tracked separately from `loading`, which covers only the contact and its
   * attempts. Without it the page renders a hard "column settings could not be
   * loaded" message whenever the campaign response merely lands last — a
   * failure notice for a request still in flight.
   */
  const [campaignState, setCampaignState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [contact, setContact] = useState<AgencyContactDetail | null>(null);
  const [attempts, setAttempts] = useState<AgencyAttempt[]>([]);
  const [attemptsCursor, setAttemptsCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * Pagination failures are kept OUT of `error`, which is a whole-page state.
   *
   * `error` short-circuits the render before the header, so writing a failed
   * "Load older attempts" into it replaced a contact and its already-loaded
   * attempts with an error card — discarding a successful first load because a
   * second request failed, and offering a Retry that re-ran `load()` rather
   * than the page that actually failed.
   */
  const [moreError, setMoreError] = useState<string | null>(null);

  /**
   * Which contact the in-flight requests belong to.
   *
   * Nothing cancels a fetch when the operator moves to another contact or
   * campaign, so a slower earlier response lands after the newer one and wins.
   * On this screen that is not a flicker — every write is a claim about WHICH
   * NUMBER WAS CALLED: a late `load()` can put contact A's header and history
   * under contact B's URL, `onLoadMore` can append A's attempts onto B's list
   * (one contact's call history silently containing another's), and a late
   * campaign fetch can apply a different campaign's `context_display` rules,
   * revealing columns this campaign's operator marked not-for-screen.
   *
   * A generation counter rather than an `AbortController` because the responses
   * are already in flight and cheap; what must not happen is applying them.
   */
  const requestGeneration = useRef(0);

  const load = useCallback(async () => {
    if (!id || !contactId || !tenantId || !accountId) return;
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(null);
    setMoreError(null);
    try {
      // Both at once: the header needs the contact and the body needs the
      // attempts, and one waiting on the other doubles the time to first paint
      // for no ordering benefit.
      const [detail, page] = await Promise.all([
        getCampaignContact(id, contactId, tenantId, accountId),
        getCampaignAttempts(id, { contact_id: contactId }, { limit: PAGE_SIZE }, tenantId, accountId),
      ]);
      if (generation !== requestGeneration.current) return;
      setContact(detail);
      setAttempts(page.rows);
      setAttemptsCursor(page.next_cursor);
    } catch (err: unknown) {
      if (generation !== requestGeneration.current) return;
      setError(getErrorMessage(err, 'Could not load this contact.'));
    } finally {
      // Guarded too: an abandoned request clearing `loading` would drop the
      // spinner while the current contact is still on its way.
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [id, contactId, tenantId, accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The history pages, and it must.
   *
   * This page's heading is "Every call attempt", and it previously fetched a
   * fixed 100 and discarded the cursor — so a contact with more than that
   * showed a silently truncated history under a heading claiming completeness,
   * on the one surface built to answer "how many times did you call me". A
   * partial answer presented as a whole one is the failure this whole read
   * surface exists to avoid; it does not stop being that because the surface is
   * small.
   */
  const onLoadMore = useCallback(async () => {
    if (!id || !contactId || !attemptsCursor || loadingMore) return;
    const generation = requestGeneration.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await getCampaignAttempts(
        id, { contact_id: contactId }, { cursor: attemptsCursor, limit: PAGE_SIZE },
        tenantId ?? undefined, accountId ?? undefined,
      );
      // The append is keyed on the generation that ISSUED it. Without this the
      // rows land on whatever `attempts` currently holds — which, after the
      // operator has moved on, is a different contact's history.
      if (generation !== requestGeneration.current) return;
      setAttempts((current) => [...current, ...page.rows]);
      setAttemptsCursor(page.next_cursor);
    } catch (err: unknown) {
      if (generation !== requestGeneration.current) return;
      setMoreError(getErrorMessage(err, 'Could not load the rest of this contact’s attempts.'));
    } finally {
      if (generation === requestGeneration.current) setLoadingMore(false);
    }
  }, [id, contactId, attemptsCursor, loadingMore, tenantId, accountId]);

  useEffect(() => {
    if (!id || !tenantId || !accountId) return;
    // Its own flag rather than the shared generation: this effect is keyed on
    // the campaign, so it does not re-run when only `contactId` changes, and
    // taking a generation here would abandon a still-correct campaign fetch.
    let cancelled = false;
    setCampaignState('loading');
    getAgencyCampaign(id, tenantId, accountId)
      .then((fresh) => {
        if (cancelled) return;
        setCampaign(fresh); setCampaignState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setCampaign(null); setCampaignState('failed');
      });
    return () => { cancelled = true; };
  }, [id, tenantId, accountId]);

  /**
   * Resolved through the campaign's own display rules, and NOT rendered when
   * the campaign could not be loaded.
   *
   * `resolveContextFields(context, undefined)` means "no operator opinion —
   * render every column", which is the correct default at campaign build time
   * and the wrong one here: a failed campaign fetch would silently drop the
   * `hidden` list and put the columns the operator excluded on screen. So the
   * absence of the rules suppresses the columns rather than widening them.
   */
  const resolved = useMemo(() => {
    if (!contact || campaignState !== 'ready' || !campaign) return null;
    return resolveContextFields(contact.context ?? {}, campaign.context_display);
  }, [contact, campaign, campaignState]);

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorAlert message={error} onRetry={() => void load()} />;
  if (!contact) return null;

  const reason = suppressedReasonLabel(contact.suppressed_reason);

  return (
    <div className={styles.page}>
      <Breadcrumbs
        items={[
          { label: 'Campaigns', href: '/agency/campaigns' },
          ...(campaign ? [{ label: campaign.name, href: `/agency/campaigns/${campaign.id}` }] : []),
          { label: 'Contacts', href: `/agency/campaigns/${id}/contacts` },
          { label: contact.phone_e164 },
        ]}
      />

      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <h1 className={styles.title}>{contact.phone_e164}</h1>
          <span className={styles.state} data-state={contact.state}>
            {contactStateLabel(contact.state)}
          </span>
          {campaign && <AgencyCampaignStatusBadge status={campaign.status} />}
        </div>
      </header>

      <p className={styles.summary} data-testid="contact-summary">{contactSummaryLine(contact)}</p>

      {/*
        A suppressed contact gets its reason as a statement, not a table cell.
        This is the single most likely thing someone opened this page to find,
        and "why did you stop calling me" is answered in a sentence or it is not
        answered.
      */}
      {reason && (
        <p className={styles.suppressed} role="status" data-testid="contact-suppressed">
          This contact is suppressed: {reason.toLowerCase()}. No further calls will be placed.
        </p>
      )}

      <section className={styles.section} aria-labelledby="contact-columns-heading">
        <h2 className={styles.sectionTitle} id="contact-columns-heading">From your uploaded file</h2>
        {campaignState === 'loading' ? (
          // Distinct from the failure below. Showing "could not be loaded" for a
          // request still in flight is a false alarm on a compliance screen.
          <p className={styles.mutedNote} data-testid="contact-context-loading">Loading…</p>
        ) : resolved === null ? (
          <p className={styles.mutedNote} data-testid="contact-context-unavailable">
            This campaign’s column settings could not be loaded, so the uploaded columns are
            hidden. Reload to try again — some columns may be configured not to appear on screen.
          </p>
        ) : resolved.hero.length === 0 && resolved.fields.length === 0
            && resolved.empty.length === 0 ? (
              <p className={styles.mutedNote}>
                This contact has no additional columns, or the campaign is configured not to show
                them.
              </p>
            ) : (
              <>
                <dl className={styles.contextGrid} data-testid="contact-context">
                  {[...resolved.hero, ...resolved.fields].map((field) => (
                    <div key={field.label} className={styles.contextField}>
                      <dt className={styles.contextLabel}>{field.label}</dt>
                      {/* Always TEXT. The values are whatever the customer's CSV held. */}
                      <dd className={styles.contextValue}>{field.value}</dd>
                    </div>
                  ))}
                </dl>
                {/*
                  Columns whose value is blank or a placeholder, behind a
                  disclosure — the same shape the agent console uses.

                  They are NOT dropped. "What did you hold about me" is answered
                  wrongly by a screen that silently omits a column: the reader
                  cannot tell an absent column from an empty one, and a contact
                  whose columns are all placeholders used to render as "this
                  contact has no additional columns", which is false twice over.
                */}
                {resolved.empty.length > 0 && (
                  <details className={styles.emptyFields} data-testid="contact-context-empty">
                    <summary>
                      {resolved.empty.length === 1
                        ? '1 column was uploaded with no value'
                        : `${resolved.empty.length} columns were uploaded with no value`}
                    </summary>
                    <dl className={styles.contextGrid}>
                      {resolved.empty.map((field) => (
                        <div key={field.label} className={styles.contextField}>
                          <dt className={styles.contextLabel}>{field.label}</dt>
                          <dd className={styles.contextValue}>—</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                )}
              </>
            )}
        {contact.csv_line_number !== null && (
          <p className={styles.provenance}>Row {contact.csv_line_number} of the uploaded file.</p>
        )}
      </section>

      <section className={styles.section} aria-labelledby="contact-attempts-heading">
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle} id="contact-attempts-heading">
            {/*
              The heading tells the truth about what is on screen. It used to
              read "Every call attempt" over a table capped at 100 with the
              cursor discarded — a completeness claim the page could not honour.
            */}
            {attemptsCursor ? 'Call attempts' : 'Every call attempt'}
          </h2>
          <Link
            to={`/agency/campaigns/${id}/attempts?contact_id=${encodeURIComponent(contact.id)}`}
            className={styles.sectionLink}
          >
            Open in the attempts view
          </Link>
        </div>

        {attempts.length === 0 ? (
          <EmptyState
            icon={<PhoneOutgoing size={28} />}
            title="This number was never dialed"
            description={
              reason
                ? 'It was suppressed before any call was placed, so there is no attempt history.'
                : 'No call has been placed to this contact yet.'
            }
          />
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Try</th>
                  <th>When</th>
                  <th>Agent</th>
                  <th>Outcome</th>
                  <th>Disposition</th>
                  <th>Talk time</th>
                  <th>Notes</th>
                  <th>Call</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((attempt) => {
                  const agent = agentCellCopy(attempt);
                  const noRecording = recordingCellCopy(attempt);
                  return (
                    <tr key={attempt.id} data-testid={`contact-attempt-${attempt.id}`}>
                      <td className={styles.numeric}>{attempt.attempt_number}</td>
                      <td className={styles.when}>{formatSpineTimestamp(attempt.created_at)}</td>
                      <td className={agent.muted ? styles.mutedCell : undefined}>{agent.text}</td>
                      <td>{attemptOutcomeLabel(attempt.outcome)}</td>
                      <td>
                        {dispositionLabel(attempt.disposition_code, campaign?.disposition_catalog)
                          ?? <span className={styles.mutedCell}>—</span>}
                        {attempt.dispositioned_on_behalf && (
                          <span className={styles.onBehalf} title="Filed by someone other than the agent on the call">
                            on behalf
                          </span>
                        )}
                      </td>
                      <td className={styles.numeric}>{formatTalkTime(attempt.talk_seconds)}</td>
                      <td className={styles.notes}>
                        {/*
                          Agent-typed free text, shown deliberately — it is
                          frequently the actual answer to "why was this number
                          called again". Rendered as text, never as markup.
                        */}
                        {attempt.notes ?? <span className={styles.mutedCell}>—</span>}
                      </td>
                      <td>
                        {noRecording === null ? (
                          // Keyed on the attempt, and inside `/agency` — see the
                          // note on the campaign attempts list.
                          <Link
                            to={`/agency/campaigns/${id}/attempts/${attempt.id}`}
                            className={styles.recordingLink}
                          >
                            <Play size={13} aria-hidden="true" />
                            Open call
                          </Link>
                        ) : (
                          <span className={styles.mutedCell}>{noRecording}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {attemptsCursor && (
              <div className={styles.more}>
                {/*
                  A pagination failure is reported HERE, beside the control that
                  caused it, and never through the page-level `error` — that one
                  returns before the header, so a failed second page used to
                  take the contact and its first page off the screen with it.
                  Retry re-runs the page that failed, not the whole load.
                */}
                {moreError && (
                  <p className={styles.moreError} role="alert" data-testid="contact-attempts-more-error">
                    {moreError}
                  </p>
                )}
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => void onLoadMore()}
                  disabled={loadingMore}
                  data-testid="contact-attempts-more"
                >
                  {loadingMore ? 'Loading…' : moreError ? 'Try again' : 'Load older attempts'}
                </button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

export default AgencyContactDetailPage;
