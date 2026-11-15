import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, PhoneOff, Search, Trash2 } from 'lucide-react';
import { dncSearchShortfall } from '@magick-agency/domain/dnc-search';
import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../../contexts/AuthContext';
import { listAgencyCampaigns } from '../../api/agencyCampaigns';
import type { AgencyCampaign } from '../../types/agency-campaign';
import {
  DNC_EVERY_CAMPAIGN,
  actsForWholeOrganisation,
  dncScopeWords,
  mayManageEveryCampaignDnc,
} from '../../utils/dncScopeWords';
import {
  addChoiceBody,
  addChoiceHint,
  addSummaryParts,
  entryScopeWords,
  removalCopy,
  removedToast,
  type DncAddChoice,
} from './dnc/dncPageCopy';
import { useTeam } from '../../hooks/useTeam';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { addDncEntries, listDncEntries, removeDncEntry } from '../../api/dnc';
import { hasPermission } from '../../utils/permissions';
import { formatDate } from '@magick-agency/web-ui/format';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { PageDescription } from '../../components/common/PageDescription';
import { SOFTPHONE_FLAG, useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import {
  DNC_SOURCE_LABELS,
  type DncAddSummary,
  type DncEntry,
  type DncEntryScope,
  type DncListParams,
  type DncSource,
} from '../../types/dnc';
import styles from './DncPage.module.css';

const PAGE_SIZE = 50;

/**
 * Where this row is enforced — three scopes, three genuinely different answers.
 *
 * Every enforcement point reads the one `dnc_entries` table with the same widening
 * predicate (decision B8), `(account_id IS NULL OR account_id = <the dial's account>)
 * AND (campaign_id IS NULL OR campaign_id = <the dial's campaign>)`:
 *
 *  1. **Dial time.** `pre-dial-gates.ts` asks `DncRegistry.check` with the
 *     campaign's account and id, so a tenant-wide row, an account row for that
 *     account, or a row for that campaign stops the dial.
 *  2. **Roster import.** The ingest's `dncRepository.findSuppressed`, the same
 *     predicate: the number is dropped from the imports it would stop dialling.
 *  3. **The soft phone** (`docs/softphone.md` §4.1 step 2). A call logged to a
 *     campaign reads that campaign's scopes; a call logged to none reads the
 *     tenant, its account, and a row for ANY campaign of that account.
 *
 * A campaign-scoped row additionally has its campaign's existing roster rows
 * suppressed at the moment an agent marks it (the station's `suppressByPhone`), but
 * that is a property of the mark, not of the row — the same row added here gets no
 * such sweep (the dial-time check still stops every dial). So the tooltip claims the
 * guarantees every row of that scope carries, and describes the mark-time sweep as
 * what it is.
 *
 * The cell names the scope in the words used everywhere (`dncScopeWords`, DS7):
 * "Every campaign", "North account", "Campaign: Q4 Renewals". The names come from
 * the server (`account_name`, `campaign_name`); a campaign that no longer exists
 * (`campaign_id` has no FK) is said to be so rather than left blank.
 */
/**
 * The soft-phone half of each scoped row's tooltip, shown only where the soft phone is on
 * (`agency_softphone_enabled`): where it is off, no soft-phone call exists to be stopped.
 */
const SCOPE_SOFTPHONE_NOTE: Partial<Record<DncEntryScope, string>> = {
  campaign: ' A soft-phone call from the same account that is not logged to a campaign is stopped too.',
  account: ' The soft phone stops a call to it from that account.',
};

const SCOPE_TOOLTIP: Record<DncEntryScope, string> = {
  // "Enforced everywhere" is what this said, and it was the widest claim on the
  // page — read as every kind of call honouring the number. DNC is an
  // agency-dialing suppression list: the dial-time gate lives in the API's
  // `agency/pre-dial-gates.ts`. The widest true claim is every agency campaign in
  // the workspace.
  tenant:
    'Enforced for all agency dialling: this number is in the dialler’s block list, so no agency '
    + 'campaign in this organisation will call it, and it is dropped from every roster import. It '
    + 'does not stop AI calls or broadcasts.',
  campaign:
    'Enforced for one campaign only: that campaign won’t dial this number and drops it from its '
    + 'roster imports, and an agent’s mid-call mark also suppresses the contacts already on it. '
    + 'Every other campaign in this organisation can still call this number. Add an “Every '
    + 'campaign” entry if the customer asked never to be called.',
  account:
    'Enforced for one account: none of that account’s campaigns will dial this number, and it is '
    + 'dropped from that account’s roster imports. Campaigns in other accounts are unaffected. Add '
    + 'an “Every campaign” entry if the customer asked never to be called.',
};

/**
 * Where the entry came from — narrowed for `regulator` (the list governs agency dialing only).
 *
 * `types/dnc.ts` mirrors the server's shapes and labels each source generically;
 * "Regulator list" beside a suppression on a platform screen reads as a
 * regulatory record the platform honours everywhere. It is not one. The stored
 * value is untouched — the server still writes and filters `source: 'regulator'` —
 * only the words it renders as change, and only this one entry needed it.
 */
const SOURCE_LABEL: Record<DncSource, string> = {
  ...DNC_SOURCE_LABELS,
  regulator: 'Regulator list (agency only)',
};

const SOURCE_TOOLTIP: Partial<Record<DncSource, string>> = {
  regulator:
    'Loaded from a regulator-supplied list. Like every entry here it suppresses agency dialling '
    + 'only — it is not a platform-wide compliance record.',
};

/** The list's scope filter: everything, one reach, or one campaign (`c:<id>`). */
type ScopeFilter = '' | DncEntryScope | `c:${string}`;

function scopeFilterParams(filter: ScopeFilter, accountId: string | null): Partial<DncListParams> {
  if (filter === '') return {};
  if (filter.startsWith('c:')) return { campaign_id: filter.slice(2) };
  if (filter === 'account') return { scope: 'account', ...(accountId ? { account_id: accountId } : {}) };
  return { scope: filter as DncEntryScope };
}

export function DncPage() {
  const { tenantId, accountId, role, accounts } = useTenant();
  const { memberships } = useAuth();
  const softphoneOn = useFeatureFlagEnabled(SOFTPHONE_FLAG);
  const { showToast, showErrorToast } = useToast();

  const [entries, setEntries] = useState<DncEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [phoneFilter, setPhoneFilter] = useState('');
  const [appliedFilter, setAppliedFilter] = useState('');
  /** Why the typed search was not sent (too few digits), shown under the box; null when it was. */
  const [searchShort, setSearchShort] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [addInput, setAddInput] = useState('');
  const [addReason, setAddReason] = useState('');
  const [adding, setAdding] = useState(false);
  const [lastSummary, setLastSummary] = useState<{ summary: DncAddSummary; choice: DncAddChoice } | null>(null);
  const [removing, setRemoving] = useState<DncEntry | null>(null);
  /** The other entries for the number being removed; undefined while read, null when it failed. */
  const [removingOthers, setRemovingOthers] = useState<DncEntry[] | null | undefined>(undefined);

  /**
   * The scope of an add, chosen every time (DS1): nothing is preselected, so no add happens at a
   * scope nobody picked. "Every campaign" is offered only to whom the server allows it (DS3).
   */
  const [addScope, setAddScope] = useState<DncEntryScope | null>(null);
  const [addCampaignId, setAddCampaignId] = useState('');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('');
  const [campaigns, setCampaigns] = useState<AgencyCampaign[]>([]);
  const [campaignsFailed, setCampaignsFailed] = useState(false);

  const canManage = hasPermission(role, 'agency.dnc.manage');
  const mayEveryCampaign = mayManageEveryCampaignDnc(memberships, tenantId, accountId);
  /** A member of the whole organisation lists every entry; anyone else, their account's. */
  const seesEverything = actsForWholeOrganisation(memberships, tenantId, accountId);
  const accountName = (accounts ?? []).find((a) => a.id === accountId)?.name ?? null;

  /** This account's campaigns: the add's campaign choice and the list's campaign filter. */
  useEffect(() => {
    if (!tenantId || !accountId) return;
    let live = true;
    setCampaignsFailed(false);
    listAgencyCampaigns(tenantId, accountId)
      .then((list) => { if (live) setCampaigns(list); })
      .catch(() => { if (live) { setCampaigns([]); setCampaignsFailed(true); } });
    return () => { live = false; };
  }, [tenantId, accountId]);

  const addChoice: DncAddChoice | null = useMemo(() => {
    if (addScope === 'tenant') return mayEveryCampaign ? { scope: 'tenant' } : null;
    if (addScope === 'account') return accountId ? { scope: 'account', accountId, accountName } : null;
    if (addScope === 'campaign') {
      const campaign = campaigns.find((c) => c.id === addCampaignId);
      return campaign ? { scope: 'campaign', campaignId: campaign.id, campaignName: campaign.name, accountName } : null;
    }
    return null;
  }, [addScope, addCampaignId, campaigns, mayEveryCampaign, accountId, accountName]);

  /**
   * "Who suppressed this number" is the central question during a compliance
   * dispute, and a raw user id does not answer it. Resolved against the team
   * roster; a member who has since left the tenant falls back to the id, which
   * is still more use than a blank.
   *
   * A NULL `added_by` renders as an explicit "Unattributed" rather than an empty
   * cell — an empty cell reads as a rendering fault, and the distinction matters
   * because older rows genuinely lost their attribution.
   */
  const { members } = useTeam();
  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of members) {
      map.set(member.user.id, member.user.display_name || member.user.email);
    }
    return map;
  }, [members]);

  const addedByLabel = useCallback(
    (addedBy: string | null): string => {
      if (!addedBy) return 'Unattributed';
      return nameById.get(addedBy) ?? addedBy;
    },
    [nameById],
  );

  const load = useCallback(() => {
    if (!tenantId || !accountId) return;
    setLoading(true);
    setError(null);
    listDncEntries(
      {
        limit: PAGE_SIZE,
        offset,
        ...(appliedFilter ? { phone: appliedFilter } : {}),
        ...scopeFilterParams(scopeFilter, accountId),
      },
      tenantId,
      accountId,
    )
      .then((res) => {
        setEntries(res.entries);
        setTotal(res.total);
      })
      .catch((err: unknown) => {
        // A failed read shows no rows: the last answer's rows under the error would read as
        // this one's (another search's matches, or the whole list under a search).
        setEntries([]);
        setTotal(0);
        setError(err instanceof Error ? err.message : 'Could not load the Do Not Call list.');
      })
      .finally(() => setLoading(false));
  }, [tenantId, accountId, offset, appliedFilter, scopeFilter]);

  useEffect(load, [load]);

  /**
   * Run the typed search, unless it has too few digits: then say so under the box and send
   * nothing (the server's own rule, `dncSearchShortfall`, which it refuses with a 400), so the
   * list keeps the last search's answer and no Retry resends text that cannot run.
   */
  const applySearch = useCallback(() => {
    const text = phoneFilter.trim();
    const short = dncSearchShortfall(text);
    setSearchShort(short ? short.message : null);
    if (short) return;
    setOffset(0);
    setAppliedFilter(text);
  }, [phoneFilter]);

  const onAdd = useCallback(async () => {
    const numbers = addInput
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (numbers.length === 0 || !addChoice) return;

    setAdding(true);
    try {
      // The scope is the operator's choice, stated in the body (`addChoiceBody`): every
      // scope is enforced at dial time (B8), and none is implied by a missing field.
      const choice = addChoice;
      const summary = await addDncEntries(
        {
          phone_numbers: numbers,
          source: 'api',
          ...addChoiceBody(choice),
          ...(addReason.trim() ? { reason: addReason.trim() } : {}),
        },
        tenantId ?? undefined,
        accountId ?? undefined,
      );
      setLastSummary({ summary, choice });
      setAddInput('');
      setAddReason('');
      // `setOffset` is asynchronous, so calling `load()` here unconditionally
      // fires a request that still closes over the OLD offset. That request and
      // the one the offset change triggers then race, and whichever settles
      // last wins — leaving page-2 rows under a page-1 pager. Reload directly
      // only when the offset is already 0 and no effect will fire.
      if (offset === 0) load();
      else setOffset(0);
    } catch (err: unknown) {
      showErrorToast(err, 'Could not add those numbers.');
    } finally {
      setAdding(false);
    }
  }, [addInput, addReason, addChoice, offset, tenantId, accountId, load, showErrorToast]);

  /** Ask before removing, having read what else blocks the number (DS5). */
  const startRemove = useCallback((entry: DncEntry) => {
    setRemoving(entry);
    setRemovingOthers(undefined);
    listDncEntries({ phone: entry.phone_e164, limit: 50 }, tenantId ?? undefined, accountId ?? undefined)
      .then((res) => setRemovingOthers(res.entries.filter((e) => e.id !== entry.id && e.phone_e164 === entry.phone_e164)))
      .catch(() => setRemovingOthers(null));
  }, [tenantId, accountId]);

  const onRemove = useCallback(async () => {
    if (!removing) return;
    const entry = removing;
    const stillBlocked = (removingOthers?.length ?? 0) > 0;
    setRemoving(null);
    try {
      await removeDncEntry(entry.id, tenantId ?? undefined, accountId ?? undefined);
      /*
        The one sentence that outlives the act. "can be called again" was
        precisely the confirm dialog's over-claim — narrowed there to agency
        campaigns, then restated unqualified in the toast that stays on screen
        after Remove is pressed. This is the last thing the operator reads about
        this number, so it is the one that most has to be right: what changed is
        that agency campaigns may dial it, and nothing else.
      */
      showToast(removedToast(entry, stillBlocked), 'success');
      // Removing the only row on a later page would otherwise reload that same
      // offset, now past the end, and the pager is rendered only when there are
      // rows — so the operator lands on "Nothing on the list" while the earlier
      // pages still exist, with no control to get back. Step back a page
      // instead, and let the offset change drive the reload.
      if (entries.length === 1 && offset > 0) setOffset((o) => Math.max(0, o - PAGE_SIZE));
      else load();
    } catch (err: unknown) {
      showErrorToast(err, 'Could not remove that number.');
    }
  }, [removing, removingOthers, entries.length, offset, tenantId, accountId, load, showToast, showErrorToast]);

  return (
    <div className={styles.page}>
      <PageHeader
        title="Do Not Call"
        // No "never": a soft-phone agent may still call by writing down why, and a scoped
        // entry holds only where its Scope column says. AI calls and broadcasts ignore the list.
        subtitle={softphoneOn
          ? 'Numbers agency campaigns don’t dial and the soft phone stops, and who listed them.'
          : 'Numbers agency campaigns don’t dial, and who listed them.'}
      />

      {/*
        This list governs agency campaigns and the soft phone, and the copy has to
        say so. It stops agency campaigns from dialing a number, and stops a
        soft-phone dial unless the agent overrides it with a written reason, which
        is audited (SP1, `docs/softphone.md`). Presenting it as
        compliance for every kind of call would leave an operator believing a customer
        who asked not to be called is protected everywhere — the one
        misunderstanding on this page that costs a customer something.
      */}
      <PageDescription
        pageKey="agency-dnc"
        description={
          'Agency campaigns don’t dial the numbers on this list, where each entry’s Scope says: '
          + 'every campaign, every campaign of one account, or one campaign. '
          // The soft phone's sentence only where it is on (SP4): elsewhere it describes a
          // surface the account does not have.
          + (softphoneOn
            ? 'The soft phone checks it too: a call logged to a campaign is stopped by the entries that '
              + 'campaign honours, and a call logged to no campaign by an entry for the organisation, its '
              + 'account or any of the account’s campaigns. An agent who is stopped can call only by '
              + 'writing down why — that reason is logged with their name. '
            : '')
          + 'It does not apply to AI calls or broadcasts. Agents add numbers '
          + (softphoneOn ? 'from the station and the soft phone ' : 'from the station ')
          + 'when a customer asks; you can also add them in bulk here.'
        }
        tips={[
          'Choose where each add applies: every campaign, this account’s campaigns, or one campaign.',
          'An “Every campaign” entry blocks the number in every agency campaign of every account.',
          'Adding a number that is already listed is harmless — it stays listed once, and a number '
          + 'already blocked more widely is not added again.',
          'Removing a number lets the campaigns its Scope names dial it again — if the customer asked '
          + 'not to be called, leave it listed.',
        ]}
      />

      {canManage && (
        <div className={styles.addBox}>
          <label className={styles.addLabel} htmlFor="dnc-numbers">
            Add numbers
          </label>
          <textarea
            id="dnc-numbers"
            className={styles.addInput}
            value={addInput}
            onChange={(e) => setAddInput(e.target.value)}
            placeholder={'One per line, or comma separated\n+919876543210\n+919876543211'}
            rows={4}
          />
          <label className={styles.addLabel} htmlFor="dnc-reason">
            Reason <span className={styles.optional}>(optional)</span>
          </label>
          <input
            id="dnc-reason"
            className={styles.reasonInput}
            value={addReason}
            onChange={(e) => setAddReason(e.target.value)}
            placeholder="e.g. regulator list, customer request"
            maxLength={1000}
          />
          <fieldset className={styles.scopeChoice}>
            <legend className={styles.addLabel}>Where should these numbers be blocked?</legend>
            {mayEveryCampaign && (
              <label className={styles.scopeOption}>
                <input
                  type="radio"
                  name="dnc-add-scope"
                  value="tenant"
                  checked={addScope === 'tenant'}
                  onChange={() => setAddScope('tenant')}
                />
                {DNC_EVERY_CAMPAIGN}
              </label>
            )}
            <label className={styles.scopeOption}>
              <input
                type="radio"
                name="dnc-add-scope"
                value="account"
                checked={addScope === 'account'}
                onChange={() => setAddScope('account')}
              />
              {dncScopeWords('account', { accountName })}
            </label>
            <label className={styles.scopeOption}>
              <input
                type="radio"
                name="dnc-add-scope"
                value="campaign"
                checked={addScope === 'campaign'}
                onChange={() => setAddScope('campaign')}
              />
              One campaign
            </label>
            {addScope === 'campaign' && (
              <select
                className={styles.scopeSelect}
                aria-label="Campaign"
                value={addCampaignId}
                onChange={(e) => setAddCampaignId(e.target.value)}
              >
                <option value="">
                  {campaignsFailed ? 'Couldn’t load the campaigns' : campaigns.length === 0 ? 'No campaigns in this account' : 'Choose a campaign'}
                </option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.status === 'running' || c.status === 'paused' ? c.name : `${c.name} (${c.status})`}
                  </option>
                ))}
              </select>
            )}
            <p className={styles.scopeHint} data-testid="dnc-add-scope-hint">
              {addChoice
                ? addChoiceHint(addChoice)
                : 'Choose where to block them before adding.'}
            </p>
          </fieldset>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void onAdd()}
            disabled={adding || addInput.trim().length === 0 || addChoice === null}
          >
            {adding ? 'Adding…' : 'Add to Do Not Call'}
          </button>

          {/*
            The per-number breakdown, always. A bulk add is normally partly
            redundant — re-uploading a regulator list is the common case — and
            "412 added, 88 already listed, 3 invalid" is the answer. Note
            `already_present` is reported as a success, because it is: the
            caller's intent is satisfied.
          */}
          {lastSummary && (
            <div className={styles.summary} data-testid="dnc-add-summary">
              {addSummaryParts(lastSummary.summary, lastSummary.choice).join(', ')}.
              {lastSummary.summary.invalid > 0 && (
                <ul className={styles.invalidList}>
                  {lastSummary.summary.results
                    .filter((r) => r.outcome === 'invalid_phone')
                    .map((r, i) => (
                      <li key={`${r.input}-${i}`}>
                        <code>{r.input}</code> — not a usable phone number
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <div className={styles.filterRow}>
        <div className={styles.searchWrap}>
          <Search size={14} className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            aria-label="Search the Do Not Call list by number"
            value={phoneFilter}
            onChange={(e) => {
              setPhoneFilter(e.target.value);
              setSearchShort(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applySearch();
            }}
            aria-invalid={searchShort ? true : undefined}
            aria-describedby={searchShort ? 'dnc-search-short' : undefined}
            /* The server reads any common form of the whole number, or matches the digits typed
               as the end of one (`dncPhoneSearch`); too few digits is checked here first
               (`applySearch`) and said under the box. */
            placeholder="Whole number, or last 4+ digits"
          />
        </div>
        <button type="button" className="btn-secondary" onClick={applySearch}>
          Search
        </button>
        <select
          className={styles.scopeSelect}
          aria-label="Show entries for"
          value={scopeFilter}
          onChange={(e) => {
            setOffset(0);
            setScopeFilter(e.target.value as ScopeFilter);
          }}
        >
          <option value="">All entries</option>
          {seesEverything && <option value="tenant">{DNC_EVERY_CAMPAIGN}</option>}
          <option value="account">{dncScopeWords('account', { accountName })}</option>
          <option value="campaign">Any one campaign</option>
          {campaigns.map((c) => (
            <option key={c.id} value={`c:${c.id}`}>{dncScopeWords('campaign', { campaignName: c.name })}</option>
          ))}
        </select>
      </div>
      {searchShort && (
        <p id="dnc-search-short" className={styles.searchShort} role="alert">
          <AlertCircle size={13} aria-hidden="true" />
          {searchShort}
        </p>
      )}

      {error && <ErrorAlert message={error} onRetry={load} />}

      {loading && <LoadingSpinner />}

      {!loading && !error && entries.length === 0 && (
        <EmptyState
          icon={<PhoneOff size={32} />}
          title={appliedFilter ? 'No match' : 'Nothing on the list'}
          description={
            appliedFilter
              ? 'No number on the list matches. Type the whole number, in any format, or at least its last 4 digits.'
              : 'When an agent marks a customer as do-not-call, they appear here and agency '
                + 'campaigns stop dialling them.'
          }
        />
      )}

      {!loading && entries.length > 0 && (
        <>
          {/* Scrolls sideways on its own on a phone, not the whole page. */}
          <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Number</th>
                <th>Scope</th>
                <th>Added</th>
                <th>By</th>
                <th>How</th>
                <th>Reason</th>
                {canManage && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className={styles.phone}>{entry.phone_e164}</td>
                  <td>
                    <span
                      className={entry.scope === 'tenant' ? styles.scopeGlobal : styles.scopeNarrow}
                      title={SCOPE_TOOLTIP[entry.scope] + (softphoneOn ? SCOPE_SOFTPHONE_NOTE[entry.scope] ?? '' : '')}
                      data-testid={`dnc-scope-${entry.scope}`}
                    >
                      {entryScopeWords(entry)}
                    </span>
                  </td>
                  <td className={styles.nowrap}>{formatDate(entry.created_at)}</td>
                  <td className={entry.added_by ? undefined : styles.unattributed}>
                    {addedByLabel(entry.added_by)}
                  </td>
                  <td title={SOURCE_TOOLTIP[entry.source]}>
                    {SOURCE_LABEL[entry.source] ?? entry.source}
                  </td>
                  <td className={styles.reason}>{entry.reason || '—'}</td>
                  {canManage && (
                    <td>
                      <button
                        type="button"
                        className={styles.removeBtn}
                        onClick={() => startRemove(entry)}
                        aria-label={`Remove ${entry.phone_e164}`}
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          <div className={styles.pager}>
            <span className={styles.pagerLabel}>
              {offset + 1}–{Math.min(offset + entries.length, total)} of {total}
            </span>
            <button
              type="button"
              className="btn-secondary"
              disabled={offset === 0}
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={offset + entries.length >= total}
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
            >
              Next
            </button>
          </div>
        </>
      )}

      {/*
        The title carries the scope too, not just the body (DS5): "Let Q4 Renewals dial this
        number again?" is the question the operator answers. The body says what else still
        blocks the number, read when the dialog opened; Remove waits for that answer.
      */}
      {(() => {
        const copy = removing
          ? removalCopy(removing, removingOthers === undefined ? [] : removingOthers, seesEverything)
          : null;
        return (
          <ConfirmDialog
            open={removing !== null}
            title={copy?.title ?? ''}
            message={removingOthers === undefined ? 'Checking what else blocks this number…' : copy?.message ?? ''}
            confirmLabel="Remove"
            danger
            disabled={removingOthers === undefined}
            onConfirm={() => void onRemove()}
            onCancel={() => setRemoving(null)}
          />
        );
      })()}
    </div>
  );
}

export default DncPage;
