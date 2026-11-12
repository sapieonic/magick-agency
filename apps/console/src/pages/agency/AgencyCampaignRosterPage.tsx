import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Download, ListChecks, RefreshCw, RotateCcw, Search, Upload, UserPlus, Users } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useCampaignCrumbs } from '../../hooks/useCampaignCrumbs';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { getAgencyCampaign } from '../../api/agencyCampaigns';
import { downloadSpineCsv, getCampaignContacts } from '../../api/agencySpine';
import { listCampaignAgents } from '../../api/agency';
import { getAssignmentProgress } from '../../api/agencyAssignment';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { AgencyAssignmentDialog, type AssignmentAgentOption } from '../../components/agency/AgencyAssignmentDialog';
import {
  ASSIGNMENT_KIND_COPY,
  CONTACT_ASSIGNMENT_FLAG,
  FORMER_MEMBER_LABEL,
  UNASSIGNED_LABEL,
  assigneeLabel,
  assignmentResultToast,
} from '../../utils/agencyAssignmentCopy';
import {
  EMPTY_SELECTION,
  isPageTicked,
  selectedInOrder,
  togglePage,
  toggleRow,
  type RowSelection,
} from '../../utils/agencyAssignmentOps';
import {
  AGENCY_ASSIGNMENT_RANGE_MAX,
  type AgencyAssignmentKind,
  type AgencyAssignmentProgressRow,
} from '@magick-agency/contracts/api/agency/assignment';
import { outcomeReportFilename } from '../../api/exportCsv';
import { hasPermission } from '../../utils/permissions';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import {
  PHONE_FILTER_PLACEHOLDER,
  ROSTER_DESCRIPTION,
  SPINE_PRIVACY_NOTE,
  dispositionLabel,
  exportTruncationNotice,
  formatSpineTimestamp,
} from '../../utils/agencySpineCopy';
import { CampaignTabs } from '../../components/agency/CampaignTabs';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { PageDescription } from '../../components/common/PageDescription';
import { FilterChip } from '../../components/agency/FilterChip';
import { FiltersCard } from '../../components/agency/FiltersCard';
import { AppliedFilterChips } from '../../components/agency/AppliedFilterChips';
import { AgencyRetryDialog } from '../../components/agency/AgencyRetryDialog';
import { DEFAULT_DISPOSITIONS } from '../../utils/agencyCampaignConfigForm';
import { retryCreatedToast, selectorFromContactFilters } from '../../utils/agencyRetrySelector';
import { formatCount } from '../../utils/format/number';
import {
  isRosterFiltered,
  rosterFilterGroupCount,
  rosterFiltersFromParams,
  rosterFiltersToParams,
  rosterLinkFilterChips,
} from '../../utils/agencyRosterFilters';
import { AgencyCampaignStatusBadge } from './AgencyCampaignStatusBadge';
import {
  AGENCY_UNASSIGNED_FILTER,
  CONTACT_STATE_LABELS,
  SUPPRESSED_REASON_LABELS,
  attemptOutcomeLabel,
  contactStateLabel,
  suppressedReasonLabel,
  type AgencyContactFilters,
  type AgencyRosterContact,
} from '../../types/agency-spine';
import type { AgencyAssignedAgent, AgencyCampaign, AgencyDispositionEntry } from '../../types/agency-campaign';
import spine from '../../components/agency/SpineListLayout.module.css';
import styles from './AgencyCampaignRosterPage.module.css';

const PAGE_SIZE = 50;

/**
 * The toolbar's operations, in the order a supervisor reaches for them. "Selected
 * rows" is first because it acts on what is already ticked on screen.
 */
const TOOLBAR_KINDS: readonly AgencyAssignmentKind[] = [
  'range',
  'random_split',
  'count',
  'filter',
  'reassign',
  'unassign',
  'rebalance',
];

/** Every applied filter but the owner, for a page that does not offer it (flag off). */
function withoutOwnerFilter(filters: AgencyContactFilters): AgencyContactFilters {
  if (!filters.assigned_to) return filters;
  const { assigned_to: _owner, ...rest } = filters;
  void _owner;
  return rest;
}

/**
 * The campaign's contact roster.
 *
 * ── This page's URL used to be an upload form ───────────────────────────────
 * `/agency/campaigns/:id/contacts` rendered "Add contacts" — its own heading
 * said so — and there was no way to see the contacts anywhere in the product.
 * The upload flow has not gone away; it has moved behind an explicit action at
 * `…/contacts/add`, which is what it always was.
 *
 * ── Suppressed contacts are the reason this exists ──────────────────────────
 * A contact suppressed before it was ever dialed has no call and no attempt, so
 * it appears in no other list in the platform. It is also the row a compliance
 * question is most often about — "why did you stop calling this number", or
 * worse, "why did you call it at all". The state filter puts it one click away
 * and the reason is spelled out rather than shown as a code.
 *
 * A terminal campaign is the primary case: nothing here is gated on the
 * campaign being live and there is no polling.
 *
 * ── It is also where retry campaigns are discovered ─────────────────────────
 * A supervisor authoring a retry is already looking at the set they mean, so
 * **Retry these contacts** carries the filters on screen straight into the
 * dialog — which is why the applied filters live in the URL rather than in this
 * component (`agencyRosterFilters.ts`): the query string
 * the supervisor was already looking at BECOMES the selector, and that is only
 * literally true if there is one representation of it.
 *
 * `phone` is a filter here and is NOT a retry dimension. It is stripped before
 * the dialog calls anything, and the dialog says so — see
 * `selectorFromContactFilters`. Neither silently narrowing nor silently
 * widening is acceptable: the result is a campaign that dials a set nobody
 * chose, discovered after the calls were placed.
 */
export function AgencyCampaignRosterPage() {
  const { id } = useParams<{ id: string }>();
  const { tenantId, accountId, role } = useTenant();
  const { showToast, showErrorToast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [campaign, setCampaign] = useState<AgencyCampaign | null>(null);
  useCampaignCrumbs(id, campaign, [{ label: 'Contacts' }]);
  const [rows, setRows] = useState<AgencyRosterContact[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  /** The server's exact count of the filtered roster (`?include_total=1`), or null without one. */
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  /*
    ── The applied filters live in the URL; the drafts do not ────────────────
    Everything below `Apply` is a draft the supervisor is still assembling, and
    writing a history entry per keystroke is the reason `useSuperAdminUsage`
    separates the two the same way. `filters` is derived from the query string
    on every render rather than mirrored into state, so there is exactly one
    answer to "what is applied" — a mirrored copy is what makes a back-button
    press show one thing and request another.
  */
  const urlFilters = useMemo(() => rosterFiltersFromParams(searchParams), [searchParams]);
  const assignmentEnabled = useFeatureFlagEnabled(CONTACT_ASSIGNMENT_FLAG);
  const filters = useMemo(
    () => (assignmentEnabled ? urlFilters : withoutOwnerFilter(urlFilters)),
    [assignmentEnabled, urlFilters],
  );
  const [draftStates, setDraftStates] = useState<string[]>(() => filters.state ?? []);
  const [draftReasons, setDraftReasons] = useState<string[]>(
    () => filters.suppressed_reason ?? [],
  );
  const [draftDispositions, setDraftDispositions] = useState<string[]>(
    () => filters.last_disposition ?? [],
  );
  const [draftPhone, setDraftPhone] = useState(() => filters.phone ?? '');
  const [draftAssignees, setDraftAssignees] = useState<string[]>(() => filters.assigned_to ?? []);
  const [retryOpen, setRetryOpen] = useState(false);

  const canExport = hasPermission(role, 'agency.supervise');
  const canUpload = hasPermission(role, 'agency.campaigns.write');
  /*
    The server names BOTH permissions on the retry create: the act is creating a
    campaign (`agency.campaigns.write`) and acting on another campaign's call
    results (`agency.supervise`). They share an `account_admin` floor today, and
    naming both here is what keeps this affordance correct if either moves —
    a button that renders and then 403s is worse than no button.
  */
  const canRetry = canExport && canUpload;

  /*
    ── Contact assignment ────────────────────────────────────────────────────
    Behind `agency_contact_assignment_enabled` (fails closed) and floored on
    `agency.supervise`, the permission every assignment route and the campaign
    agents read are floored on: a supervisor sees who owns each contact, filters
    by owner, ticks rows and assigns them. Without both, the page is unchanged —
    no column, no chip, no checkboxes, and an `assigned_to` in a link is not
    sent (the server would refuse a filter the page does not offer).
  */
  const canAssign = canExport && assignmentEnabled;
  const [agents, setAgents] = useState<AgencyAssignedAgent[]>([]);
  /**
   * Everyone holding contacts on the campaign, staffed or not (the progress read's
   * per-agent rows): an agent taken off it with `on_unstaff = keep`, or a former
   * member, still owns contacts a supervisor must be able to find and move.
   */
  const [holders, setHolders] = useState<AgencyAssignmentProgressRow[]>([]);
  const [selection, setSelection] = useState<RowSelection>(EMPTY_SELECTION);
  const [assignKind, setAssignKind] = useState<AgencyAssignmentKind | null>(null);
  const [reloadHolders, setReloadHolders] = useState(0);

  /** Applied filters → the URL. The single writer. */
  const applyToUrl = useCallback(
    (next: AgencyContactFilters, options: { replace?: boolean } = {}) => {
      setSearchParams(rosterFiltersToParams(next), { replace: options.replace ?? false });
    },
    [setSearchParams],
  );

  const requestSeq = useRef(0);

  const load = useCallback(async (active: AgencyContactFilters) => {
    if (!id || !tenantId || !accountId) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      // The first page asks for the exact total, counted with the list's own predicate:
      // it is the number an Insights drill-down is checked against. Later pages keep it.
      const page = await getCampaignContacts(
        id, active, { limit: PAGE_SIZE, includeTotal: true }, tenantId, accountId,
      );
      if (seq !== requestSeq.current) return;
      setRows(page.rows);
      setNextCursor(page.next_cursor);
      setTotal(typeof page.total === 'number' ? page.total : null);
      // A new list is a new set of rows: a tick on a row that is no longer shown
      // would be sent by "Selected rows" without the supervisor seeing it.
      setSelection(EMPTY_SELECTION);
    } catch (err: unknown) {
      if (seq !== requestSeq.current) return;
      setError(getErrorMessage(err, 'Could not load this campaign’s contacts.'));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [id, tenantId, accountId]);

  useEffect(() => {
    if (!id || !tenantId || !accountId) return;
    getAgencyCampaign(id, tenantId, accountId).then(setCampaign).catch(() => setCampaign(null));
  }, [id, tenantId, accountId]);

  useEffect(() => {
    void load(filters);
  }, [load, filters]);

  // The staffed agents: the "Assigned to" names, the owner chips and the only
  // legal targets of an operation. A failure leaves the list empty, which the
  // dialog says in words ("Nobody is staffed…") rather than offering nobody.
  useEffect(() => {
    if (!canAssign || !id || !tenantId || !accountId) return;
    let live = true;
    listCampaignAgents(id, tenantId, accountId)
      .then((result) => { if (live) setAgents(result.agents); })
      .catch(() => { if (live) setAgents([]); });
    return () => { live = false; };
  }, [canAssign, id, tenantId, accountId]);

  // Who holds contacts: read again after a commit, which can change the holders
  // but never the staffing. A failure leaves only the staffed agents as owners.
  useEffect(() => {
    if (!canAssign || !id || !tenantId || !accountId) return;
    let live = true;
    getAssignmentProgress(id, {}, tenantId, accountId)
      .then((result) => { if (live) setHolders(result.agents); })
      .catch(() => { if (live) setHolders([]); });
    return () => { live = false; };
  }, [canAssign, id, tenantId, accountId, reloadHolders]);

  const agentOptions = useMemo((): AssignmentAgentOption[] => agents.map((agent) => ({
    user_id: agent.user_id,
    name: agent.name ?? agent.email ?? 'Unnamed agent',
  })), [agents]);
  /**
   * Sources of a reassign / unassign: the staffed agents, then every other holder
   * (named by the progress read, or "Former member" for a user who is gone).
   */
  const ownerOptions = useMemo((): AssignmentAgentOption[] => {
    const staffed = new Set(agentOptions.map((agent) => agent.user_id));
    return [
      ...agentOptions,
      ...holders
        .filter((row) => !staffed.has(row.agent_user_id))
        .map((row) => ({ user_id: row.agent_user_id, name: row.agent_name ?? FORMER_MEMBER_LABEL })),
    ];
  }, [agentOptions, holders]);
  // Names for the "Assigned to" column and preview lines: an id with none is a
  // former member (`agentName` / `assigneeLabel` say so).
  const agentNames = useMemo(() => new Map<string, string>([
    ...holders.flatMap((row) => (row.agent_name ? [[row.agent_user_id, row.agent_name] as [string, string]] : [])),
    ...agentOptions.map((agent) => [agent.user_id, agent.name] as [string, string]),
  ]), [holders, agentOptions]);
  const agentName = useCallback(
    (userId: string) => agentNames.get(userId) ?? FORMER_MEMBER_LABEL,
    [agentNames],
  );
  /*
    The owner chips: the pool, every staffed agent and every other holder of
    contacts, plus any id already in the applied filter that is none of these (a
    link to a former member's contacts must still show, and clear, its own filter).
  */
  const assigneeOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [
      { value: AGENCY_UNASSIGNED_FILTER, label: UNASSIGNED_LABEL },
      ...ownerOptions.map((owner) => ({ value: owner.user_id, label: owner.name })),
    ];
    for (const value of filters.assigned_to ?? []) {
      if (!options.some((option) => option.value === value)) {
        options.push({ value, label: FORMER_MEMBER_LABEL });
      }
    }
    return options;
  }, [ownerOptions, filters.assigned_to]);

  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const selectedIds = useMemo(() => selectedInOrder(selection, rowIds), [selection, rowIds]);
  const reachable = Math.min(rowIds.length, AGENCY_ASSIGNMENT_RANGE_MAX);
  const pageTicked = isPageTicked(selection, rowIds);

  /*
    A link arriving with filters already on it has to fill the draft controls,
    or the panel shows an empty form above a narrowed list and Apply silently
    widens it back. Keyed on the applied set, so a back-button press moves the
    controls with the list.
  */
  useEffect(() => {
    setDraftStates(filters.state ?? []);
    setDraftReasons(filters.suppressed_reason ?? []);
    setDraftDispositions(filters.last_disposition ?? []);
    setDraftPhone(filters.phone ?? '');
    setDraftAssignees(filters.assigned_to ?? []);
  }, [filters]);

  const onLoadMore = useCallback(async () => {
    if (!id || !nextCursor || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    try {
      const page = await getCampaignContacts(
        id, filters, { cursor: nextCursor, limit: PAGE_SIZE },
        tenantId ?? undefined, accountId ?? undefined,
      );
      if (seq !== requestSeq.current) return;
      setRows((current) => [...current, ...page.rows]);
      setNextCursor(page.next_cursor);
    } catch (err: unknown) {
      showErrorToast(err, 'Could not load more contacts.');
    } finally {
      setLoadingMore(false);
    }
  }, [id, nextCursor, loadingMore, filters, tenantId, accountId, showErrorToast]);

  const onExport = useCallback(async () => {
    if (!id) return;
    setExporting(true);
    try {
      const result = await downloadSpineCsv(
        id, 'contacts',
        filters as Record<string, string | string[] | undefined>,
        tenantId ?? undefined, accountId ?? undefined,
      );
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `contacts-${outcomeReportFilename(campaign?.name ?? null, id)}`;
      link.click();
      URL.revokeObjectURL(url);
      if (result.truncated) {
        // A million-contact campaign truncates by design, so this is an error
        // toast rather than a success with a footnote — an operator who reads it
        // as "done" hands over a file missing most of the roster.
        // `'contacts'`, so the remedy names filters that exist on THIS page.
        showToast(
          exportTruncationNotice(result.reason, result.rowLimit, result.rows, 'contacts'),
          'error',
        );
      } else {
        showToast('Export downloaded.', 'success');
      }
    } catch (err: unknown) {
      showErrorToast(err, 'Could not export this roster.');
    } finally {
      setExporting(false);
    }
  }, [id, filters, campaign, tenantId, accountId, showToast, showErrorToast]);

  const applyFilters = useCallback(() => {
    applyToUrl({
      // The two filters only a link sets (no control on this form) are kept, so
      // Apply narrows an Insights drill-down rather than silently undoing it.
      ...(filters.waiting ? { waiting: filters.waiting } : {}),
      ...(filters.attempted ? { attempted: filters.attempted } : {}),
      ...(draftStates.length > 0 ? { state: draftStates } : {}),
      ...(draftReasons.length > 0 ? { suppressed_reason: draftReasons } : {}),
      ...(draftDispositions.length > 0 ? { last_disposition: draftDispositions } : {}),
      ...(draftAssignees.length > 0 ? { assigned_to: draftAssignees } : {}),
      ...(draftPhone.trim() ? { phone: draftPhone.trim() } : {}),
    });
  }, [applyToUrl, filters, draftStates, draftReasons, draftDispositions, draftAssignees, draftPhone]);

  const clearFilters = useCallback(() => {
    applyToUrl({});
  }, [applyToUrl]);

  const filtered = useMemo(() => isRosterFiltered(filters), [filters]);

  const linkChips = useMemo(() => rosterLinkFilterChips(filters), [filters]);
  const removeLinkChip = useCallback((chipId: string) => {
    const chip = linkChips.find((c) => c.id === chipId);
    if (chip) applyToUrl(chip.without);
  }, [linkChips, applyToUrl]);

  // How many independent filter groups are APPLIED, for the small badge on the
  // filter panel — a supervisor should see at a glance that the view is narrowed.
  const activeFilterCount = useMemo(() => rosterFilterGroupCount(filters), [filters]);

  /** One click to the rows a compliance question is usually about. */
  const showSuppressedOnly = useCallback(() => {
    applyToUrl({ state: ['suppressed'] });
  }, [applyToUrl]);

  /*
    ── The disposition filter's vocabulary ───────────────────────────────────
    The campaign's own catalog, plus the three built-in codes — the API's rule for
    `last_disposition` exactly (`disposition_catalog` ∪ `BUILT_IN_DISPOSITION_CODES`),
    so a code offered here is a code the retry preview will accept.

    Built-ins are unioned rather than assumed present: an operator may have
    removed one from the catalog *after* calls were filed under it, and those
    contacts are precisely the ones a supervisor is looking for. A campaign that
    has not loaded yet offers nothing rather than a guess — an option is chosen,
    not read, and a chip matching no row reads as "this never happened".
  */
  const dispositionOptions = useMemo((): AgencyDispositionEntry[] => {
    if (!campaign) return [];
    const catalog = campaign.disposition_catalog ?? [];
    const missing = DEFAULT_DISPOSITIONS.filter(
      (builtIn) => !catalog.some((entry) => entry.code === builtIn.code),
    );
    return [...catalog, ...missing];
  }, [campaign]);

  /*
    The active filters, minus the dimensions a retry has no notion of. Computed
    here rather than inside the dialog so the SAME value drives the request and
    the sentence naming what was dropped — see `selectorFromContactFilters`.
  */
  const retrySelection = useMemo(() => selectorFromContactFilters(filters), [filters]);

  return (
    <div className={styles.page}>

      {/*
        The campaign workspace's section bar, in the same slot on every one of
        its screens. These four sections used to be reachable only
        as secondary buttons on the detail page's header row — the same row
        that carries Stop — so getting from Contacts to Call attempts meant
        going back through the campaign first.
      */}
      {id && (
        <CampaignTabs campaignId={id} active="contacts" role={role} campaignStatus={campaign?.status} />
      )}

      <header className={spine.header}>
        <div className={spine.headerCopy}>
          <span className={spine.titleIcon} aria-hidden="true"><Users size={20} /></span>
          <h1 className={spine.title}>Contacts</h1>
          {campaign && <AgencyCampaignStatusBadge status={campaign.status} />}
        </div>
        <div className={spine.actions}>
          <button
            type="button"
            className={`${spine.actionButton} btn-secondary`}
            onClick={() => void load(filters)}
            disabled={loading}
          >
            <RefreshCw size={16} />
            Refresh
          </button>
          {/*
            The upload is an ACTION on this page now, not the page itself.

            ⚠️ There is deliberately NO redirect: `…/contacts` now means the
            roster, and an external bookmark to the old "Add contacts" screen
            lands here instead. That is the right outcome — the roster carries
            this button, so the operator is one click from where they meant to
            go — but it IS a change in what that URL means, so check any docs or
            onboarding mail that deep-links it. (An earlier version of this
            comment asserted a redirect in `App.tsx`; none exists, and none is
            needed.)
          */}
          {canUpload && (
            <Link
              to={`/agency/campaigns/${id}/contacts/add`}
              className={`${spine.actionButton} btn-secondary`}
            >
              <Upload size={16} />
              Add contacts
            </Link>
          )}
          {canExport && (
            <button
              type="button"
              className={`${spine.actionButton} btn-secondary`}
              onClick={() => void onExport()}
              disabled={exporting || loading}
              title="Download everything matching the filters above, not just the rows on screen"
            >
              <Download size={16} />
              {exporting ? 'Preparing…' : 'Export CSV'}
            </button>
          )}
          {/*
            ── Retry these contacts ──────────────────────────────────────────
            This is where the feature is DISCOVERED: the supervisor is already
            looking at the set they mean, and the filters on screen become the
            selector. It sits beside Export because the two
            answer the same question about the same rows — "take this filtered
            set and do something with it" — and unlike Export it needs the
            campaign loaded, because the child inherits that campaign's config
            and the dialog names it.

            Offered on any campaign, including a running one: creating a retry
            is always allowed and the child is created as a draft. What a
            running parent blocks is STARTING the child, which the dialog says
            in as many words rather than leaving to a refusal later.
          */}
          {canRetry && campaign && (
            <button
              type="button"
              className={`${spine.actionButton} btn-secondary`}
              onClick={() => setRetryOpen(true)}
              disabled={loading}
              data-testid="roster-retry-action"
              title="Create a new campaign seeded from the contacts matching these filters"
            >
              <RotateCcw size={16} />
              Retry these contacts
            </button>
          )}
        </div>
      </header>

      <PageDescription
        pageKey="agency-campaign-roster"
        description={ROSTER_DESCRIPTION}
        tips={[
          /*
            "…including ones that were never dialed" is true and reads as the
            whole story, which it is not. The commonest way into `suppressed` on
            a collections campaign is the opposite: dialed, answered, and written
            up with an outcome configured to stop calling — the campaign's own
            successes. A supervisor who read this tip over a list of 23 such rows
            concluded two thirds of the list was never worked.

            So the tip now says the reason is per-contact and that some were
            worked first, which covers both populations.
          */
          'Suppressed contacts are listed with the reason — some were never dialled, others were '
          + 'worked first and then closed.',
          'Open a contact to see every attempt against it and the columns from your uploaded file.',
          'Export CSV downloads everything matching the filters, not just the rows on screen.',
          /*
            The filters are in the address bar, which is worth saying once: it
            is what makes a narrowed roster shareable, and it is what "Retry
            these contacts" acts on.
          */
          'Filters are part of the address, so a narrowed list can be bookmarked or sent to a '
          + 'colleague — and Retry these contacts builds a new campaign from exactly that set.',
        ]}
      />

      <p className={styles.privacyNote}>{SPINE_PRIVACY_NOTE}</p>

      <FiltersCard activeCount={activeFilterCount}>
        <fieldset className={styles.stateFilter}>
          <legend className={spine.filterLegend}>Where the contact got to</legend>
          <div className={styles.options}>
            {Object.entries(CONTACT_STATE_LABELS).map(([value, label]) => (
              <FilterChip
                key={value}
                label={label}
                checked={draftStates.includes(value)}
                onChange={(checked) => setDraftStates((current) => (
                  checked ? [...current, value] : current.filter((v) => v !== value)
                ))}
              />
            ))}
          </div>
        </fieldset>

        <fieldset className={styles.stateFilter}>
          <legend className={spine.filterLegend}>Why it was suppressed</legend>
          <div className={styles.options}>
            {Object.entries(SUPPRESSED_REASON_LABELS).map(([value, label]) => (
              <FilterChip
                key={value}
                label={label}
                checked={draftReasons.includes(value)}
                onChange={(checked) => setDraftReasons((current) => (
                  checked ? [...current, value] : current.filter((v) => v !== value)
                ))}
              />
            ))}
          </div>
        </fieldset>

        {/*
          `last_disposition` — the question this console could not answer.
          "Show me everyone marked voicemail" is worth having on its own, and it
          is also the dimension a retry cohort is most often built on: the codes
          are the operator's own words for what happened on the call, which no
          telephony outcome captures.

          Hidden while the campaign has no catalog, rather than rendered empty:
          the codes are per-campaign and there is nothing generic to offer.
        */}
        {dispositionOptions.length > 0 && (
          <fieldset className={styles.stateFilter}>
            <legend className={spine.filterLegend}>How the agent wrote it up</legend>
            <div className={styles.options}>
              {dispositionOptions.map((entry) => (
                <FilterChip
                  key={entry.code}
                  label={entry.label || entry.code}
                  checked={draftDispositions.includes(entry.code)}
                  onChange={(checked) => setDraftDispositions((current) => (
                    checked ? [...current, entry.code] : current.filter((v) => v !== entry.code)
                  ))}
                />
              ))}
            </div>
          </fieldset>
        )}

        {canAssign && (
          <fieldset className={styles.stateFilter} data-testid="roster-assignee-filter">
            <legend className={spine.filterLegend}>Assigned to</legend>
            <div className={styles.options}>
              {assigneeOptions.map((option) => (
                <FilterChip
                  key={option.value}
                  label={option.label}
                  checked={draftAssignees.includes(option.value)}
                  onChange={(checked) => setDraftAssignees((current) => (
                    checked ? [...current, option.value] : current.filter((v) => v !== option.value)
                  ))}
                />
              ))}
            </div>
          </fieldset>
        )}

        <div className={spine.fieldRow}>
          <label className={spine.field}>
            <span className={spine.fieldLabel}>Phone number</span>
            <span className={spine.inputWrap}>
              <Search size={14} className={spine.inputIcon} aria-hidden="true" />
              <input
                type="text"
                className={spine.fieldInput}
                value={draftPhone}
                placeholder={PHONE_FILTER_PLACEHOLDER}
                onChange={(e) => setDraftPhone(e.target.value)}
              />
            </span>
          </label>
        </div>

        <div className={spine.filterFooter}>
          <div className={spine.filterActions}>
            <button type="button" className="btn-primary" onClick={applyFilters}>Apply</button>
            {filtered && (
              <button type="button" className="btn-secondary" onClick={clearFilters}>Clear</button>
            )}
            <button
              type="button"
              className="btn-secondary"
              onClick={showSuppressedOnly}
              data-testid="roster-suppressed-shortcut"
            >
              Show suppressed only
            </button>
          </div>
        </div>
      </FiltersCard>

      <AppliedFilterChips chips={linkChips} onRemove={removeLinkChip} testIdPrefix="roster" />

      {error && <ErrorAlert message={error} onRetry={() => void load(filters)} />}

      <p className={spine.count} data-testid="roster-count" aria-live="polite" aria-atomic="true">
        {!loading && rows.length > 0 && (
          <>
            <ListChecks size={14} className={spine.countIcon} aria-hidden="true" />
            {rosterCountCopy(rows.length, total, nextCursor !== null)}
          </>
        )}
      </p>

      {canAssign && campaign && (
        <div className={styles.assignBar} role="toolbar" aria-label="Assign contacts" data-testid="assign-toolbar">
          <span className={styles.assignCount} data-testid="assign-selection-count" aria-live="polite">
            {selectedIds.length > 0
              ? `${formatCount(selectedIds.length)} selected`
              : 'Tick rows, or assign by rule'}
          </span>
          {selectedIds.length > 0 && (
            <button type="button" className="btn-secondary" onClick={() => setSelection(EMPTY_SELECTION)}>
              Clear selection
            </button>
          )}
          {TOOLBAR_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`${spine.actionButton} btn-secondary`}
              onClick={() => setAssignKind(kind)}
              disabled={loading || (kind === 'range' && selectedIds.length === 0)}
              title={kind === 'range' && selectedIds.length === 0
                ? 'Tick the rows to assign first'
                : ASSIGNMENT_KIND_COPY[kind].explain}
              data-testid={`assign-op-${kind}`}
            >
              {kind === 'range' ? <UserPlus size={16} aria-hidden="true" /> : null}
              {ASSIGNMENT_KIND_COPY[kind].label}
            </button>
          ))}
        </div>
      )}

      {loading && <LoadingSpinner />}

      {!loading && rows.length === 0 && !error && (
        <EmptyState
          icon={<Users size={32} />}
          title={filtered ? 'Nothing matches those filters' : 'No contacts yet'}
          description={
            filtered
              ? 'Clear the filters to see the whole roster.'
              : 'Upload a CSV to give this campaign something to dial.'
          }
        />
      )}

      {!loading && rows.length > 0 && (
        <>
          <div className={spine.tableWrap}>
            <table className={spine.table}>
              <caption className={styles.srOnly}>
                {`Contacts on ${campaign?.name ?? 'this campaign'}, newest first`}
              </caption>
              <thead>
                <tr>
                  {canAssign && (
                    <th className={styles.selectCell}>
                      <input
                        type="checkbox"
                        aria-label={`Select the first ${formatCount(reachable)} rows`}
                        title={rowIds.length > AGENCY_ASSIGNMENT_RANGE_MAX
                          ? `Selects the first ${AGENCY_ASSIGNMENT_RANGE_MAX} — one operation takes at most that many`
                          : 'Select every row shown'}
                        checked={pageTicked}
                        onChange={() => setSelection((current) => togglePage(current, rowIds))}
                        data-testid="roster-select-page"
                      />
                    </th>
                  )}
                  <th>Number</th>
                  <th>State</th>
                  <th>Attempts</th>
                  <th>Last outcome</th>
                  <th>Last disposition</th>
                  <th>Why suppressed</th>
                  <th>Next attempt</th>
                  {canAssign && <th>Assigned to</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((contact) => {
                  const reason = suppressedReasonLabel(contact.suppressed_reason);
                  return (
                    <tr
                      key={contact.id}
                      data-testid={`roster-row-${contact.id}`}
                      className={selection.selected.has(contact.id) ? styles.selectedRow : undefined}
                      data-selected={selection.selected.has(contact.id) ? 'true' : undefined}
                    >
                      {canAssign && (
                        <td className={styles.selectCell}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${contact.phone_e164}`}
                            checked={selection.selected.has(contact.id)}
                            onChange={(event) => {
                              // Shift-click selects the range from the last row
                              // clicked, the spreadsheet gesture.
                              const shift = (event.nativeEvent as MouseEvent).shiftKey === true;
                              const checked = event.currentTarget.checked;
                              setSelection((current) => toggleRow(current, rowIds, contact.id, checked, shift));
                            }}
                            data-testid={`roster-select-${contact.id}`}
                          />
                        </td>
                      )}
                      <td>
                        <Link
                          to={`/agency/campaigns/${id}/contacts/${contact.id}`}
                          className={styles.phoneLink}
                        >
                          {contact.phone_e164}
                        </Link>
                      </td>
                      <td>
                        <span
                          className={styles.state}
                          data-state={contact.state}
                          data-testid={`roster-state-${contact.id}`}
                        >
                          {contactStateLabel(contact.state)}
                        </span>
                      </td>
                      <td className={styles.numeric}>
                        {contact.attempt_count}
                        {contact.our_fault_attempts > 0 && (
                          <span
                            className={styles.ourFault}
                            title="Redials caused by a system fault. These do not use up the contact’s retry allowance."
                          >
                            +{contact.our_fault_attempts}
                          </span>
                        )}
                      </td>
                      <td>
                        {contact.last_outcome
                          ? attemptOutcomeLabel(contact.last_outcome)
                          : <span className={styles.mutedCell}>Never dialled</span>}
                      </td>
                      <td>
                        {dispositionLabel(contact.last_disposition, campaign?.disposition_catalog)
                          ?? <span className={styles.mutedCell}>—</span>}
                      </td>
                      <td>
                        {reason
                          ? <span className={styles.suppressedReason}>{reason}</span>
                          : <span className={styles.mutedCell}>—</span>}
                      </td>
                      <td className={styles.when}>
                        {/*
                          Only meaningful while the contact can still be dialed.
                          On a completed or suppressed row the column holds
                          whatever the last scheduling write left behind, and
                          rendering it as a future date would promise a call
                          that will never be placed.
                        */}
                        {contact.state === 'pending' || contact.state === 'in_flight'
                          ? formatSpineTimestamp(contact.next_attempt_at)
                          : <span className={styles.mutedCell}>—</span>}
                      </td>
                      {canAssign && (
                        <td data-testid={`roster-assignee-${contact.id}`}>
                          {contact.assigned_user_id === null
                            ? <span className={styles.mutedCell}>{UNASSIGNED_LABEL}</span>
                            : assigneeLabel(contact.assigned_user_id, agentNames)}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {nextCursor && (
            <div className={spine.more}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void onLoadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : 'Load more contacts'}
              </button>
            </div>
          )}
        </>
      )}

      {/*
        Mounted only while open, so the preview read is not issued on every
        roster page view — it is a count over the whole campaign, not over the
        page on screen.
      */}
      {campaign && assignKind && id && (
        <AgencyAssignmentDialog
          campaignId={id}
          kind={assignKind}
          agents={agentOptions}
          owners={ownerOptions}
          agentName={agentName}
          selectedIds={selectedIds}
          dispositionOptions={dispositionOptions}
          origin="roster"
          onClose={() => setAssignKind(null)}
          onCommitted={(result) => {
            setAssignKind(null);
            showToast(assignmentResultToast(result), 'success');
            void load(filters);
            setReloadHolders((n) => n + 1);
          }}
        />
      )}

      {campaign && retryOpen && (
        <AgencyRetryDialog
          open
          campaign={campaign}
          selector={retrySelection.selector}
          droppedFilters={retrySelection.dropped}
          droppedValues={retrySelection.droppedValues}
          origin="filters"
          onClose={() => setRetryOpen(false)}
          onCreated={(result) => {
            setRetryOpen(false);
            showToast(retryCreatedToast(result), 'success');
            // Straight to the child, because the next thing a supervisor does
            // is check its roster and press Start — and the child is a draft, so
            // nothing is dialing while they get there.
            navigate(`/agency/campaigns/${result.campaign.id}`);
          }}
        />
      )}
    </div>
  );
}

export default AgencyCampaignRosterPage;

/**
 * The count line. With the server's exact total: "1,234 contacts — showing 50". Without one:
 * what is on screen, never an "N of M" nothing counted.
 */
function rosterCountCopy(shown: number, total: number | null, more: boolean): string {
  const noun = (n: number) => `contact${n === 1 ? '' : 's'}`;
  if (total !== null) {
    return `${formatCount(total)} ${noun(total)}` + (shown < total ? ` — showing ${formatCount(shown)}` : '');
  }
  return `Showing ${shown.toLocaleString()} ${noun(shown)}` + (more ? ' — there are more' : '');
}
