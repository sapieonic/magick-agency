import { useCallback, useEffect, useMemo, useState } from 'react';
import { PhoneOff, Search, Trash2 } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useTeam } from '../../hooks/useTeam';
import { useToast } from '../../contexts/ToastContext';
import { addDncEntries, listDncEntries, removeDncEntry } from '../../api/dnc';
import { hasPermission } from '../../utils/permissions';
import { formatDate } from '../../utils/format';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorAlert } from '../../components/common/ErrorAlert';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { PageDescription } from '../../components/common/PageDescription';
import {
  DNC_SOURCE_LABELS,
  type DncAddSummary,
  type DncEntry,
  type DncSource,
} from '../../types/dnc';
import styles from './DncPage.module.css';

const PAGE_SIZE = 50;

/**
 * Where this row is enforced — three scopes, three genuinely different answers.
 *
 * ── Why this is not a boolean ────────────────────────────────────────────────
 * It used to be `isEnforced`, rendering everything narrower than tenant-wide as
 * "Not enforced". That was true while master only ever wrote tenant-wide rows
 * from a mark. Campaign-scoped marks make it false, and false in the worst
 * direction: it prints "this does not stop any call" beside the number of a
 * customer who asked not to be called, next to a suppression that is live.
 *
 * The two enforcement points are separate and only the first is workspace-wide:
 *
 *  1. **Dial time.** `pre-dial-gates.ts` asks `DncRegistry.check(tenantId, …)`,
 *     which reads the flat `dnc:{tenantId}` Redis set. Master publishes into it
 *     from `listTenantWidePhones` — `account_id IS NULL AND campaign_id IS NULL`
 *     (`dnc.repository.ts:308`). So ONLY a tenant-wide row is consulted here.
 *  2. **Roster import.** Master's ingest calls `dncRepository.findSuppressed`,
 *     whose predicate is `(account_id IS NULL OR account_id = $3) AND
 *     (campaign_id IS NULL OR campaign_id = $4)`. A scoped row therefore DOES
 *     drop the number — from that campaign's imports, or from that account's
 *     campaigns' imports. This is the point the old copy denied outright.
 *
 * A campaign-scoped row additionally has its campaign's existing roster rows
 * suppressed at the moment an agent marks it (core's `suppressByPhone`), but
 * that is a property of the mark, not of the row — the same row added through
 * the public API (`dnc.routes.ts` accepts `campaign_id`) gets no such sweep. So
 * the cell and its tooltip claim the import-time guarantee, which every row of
 * that scope really carries, and describe the mark-time sweep as what it is.
 *
 * Scoped rows are shown rather than filtered out, which is the opposite of what
 * a "compliance view shows only enforced entries" reading would suggest, and
 * deliberately so. There is no other surface for them: filtering would leave a
 * scoped row invisible AND unremovable — reinstating the missing-correction-path
 * gap this page exists to close (`MAG-116`) — and would hide the case where a
 * number is suppressed less widely than an operator assumes, which is exactly
 * the failure `MAG-110` says an operator must be able to notice.
 *
 * Naming the campaign is deliberately NOT attempted here: `dnc_entries` has no
 * FK to `agency_campaigns` (it lives in core's database), so it is a lookup that
 * can fail, and a row whose campaign cannot be named must still show its scope.
 * Left to `MAG-129`.
 */
type DncScopeKind = 'tenant' | 'campaign' | 'account';

function scopeOf(entry: DncEntry): DncScopeKind {
  // Campaign first: it is the narrowest, and master's own lookup treats a
  // campaign_id as the deciding column when both are set.
  if (entry.campaign_id !== null) return 'campaign';
  if (entry.account_id !== null) return 'account';
  return 'tenant';
}

/**
 * The cell answers "enforced where?" in the space a table cell has; the tooltip
 * answers "how, and where not". Neither may claim a scope is enforced more
 * widely than it is — an operator who reads "One campaign" as "everywhere" will
 * not add the tenant-wide entry the customer actually asked for.
 */
const SCOPE_LABEL: Record<DncScopeKind, string> = {
  tenant: 'Every campaign',
  campaign: 'One campaign',
  account: 'One account',
};

const SCOPE_TOOLTIP: Record<DncScopeKind, string> = {
  // "Enforced everywhere" is what this said, and it was the widest claim on the
  // page — read as the platform honouring the number, which it does not. DNC is
  // an agency-dialing suppression list (Q2): the dial-time gate lives in core's
  // `agency/pre-dial-gates.ts` and nothing in AI dispatch consults it. The
  // widest true claim is every agency campaign in the workspace.
  tenant:
    'Enforced for all agency dialing: this number is in the dialer’s block list, so no agency '
    + 'campaign in this workspace will call it, and it is dropped from every roster import. It '
    + 'does not stop AI calls or broadcasts.',
  campaign:
    'Enforced for one campaign only: this number is dropped from that campaign’s roster imports, '
    + 'and an agent’s mid-call mark also suppresses the contacts already on it. It is NOT in the '
    + 'dialer’s block list, so every other campaign in this workspace can still call this number. '
    + 'Add a workspace-wide entry if the customer asked never to be called.',
  account:
    'Enforced for one account’s campaigns, at roster import only: this number is dropped when '
    + 'contacts are imported. It is NOT in the dialer’s block list, so a contact already imported '
    + 'can still be called, and campaigns in other accounts are unaffected. Add a workspace-wide '
    + 'entry if the customer asked never to be called.',
};

/**
 * Where the entry came from — narrowed for `regulator` (Q2).
 *
 * `types/dnc.ts` mirrors master's shapes and labels each source generically;
 * "Regulator list" beside a suppression on a platform screen reads as a
 * regulatory record the platform honours everywhere. It is not one. The stored
 * value is untouched — master still writes and filters `source: 'regulator'` —
 * only the words it renders as change, and only this one entry needed it.
 */
const SOURCE_LABEL: Record<DncSource, string> = {
  ...DNC_SOURCE_LABELS,
  regulator: 'Regulator list (agency only)',
};

const SOURCE_TOOLTIP: Partial<Record<DncSource, string>> = {
  regulator:
    'Loaded from a regulator-supplied list. Like every entry here it suppresses agency dialing '
    + 'only — it is not a platform-wide compliance record.',
};

export function DncPage() {
  const { tenantId, accountId, role } = useTenant();
  const { showToast, showErrorToast } = useToast();

  const [entries, setEntries] = useState<DncEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [phoneFilter, setPhoneFilter] = useState('');
  const [appliedFilter, setAppliedFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [addInput, setAddInput] = useState('');
  const [addReason, setAddReason] = useState('');
  const [adding, setAdding] = useState(false);
  const [lastSummary, setLastSummary] = useState<DncAddSummary | null>(null);
  const [removing, setRemoving] = useState<DncEntry | null>(null);

  const canManage = hasPermission(role, 'agency.dnc.manage');

  /**
   * "Who suppressed this number" is the central question during a compliance
   * dispute, and a raw user id does not answer it. Resolved against the team
   * roster; a member who has since left the tenant falls back to the id, which
   * is still more use than a blank.
   *
   * A NULL `added_by` renders as an explicit "Unattributed" rather than an empty
   * cell — an empty cell reads as a rendering fault, and the distinction matters
   * because `MAG-107` means older rows genuinely lost their attribution.
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
      { limit: PAGE_SIZE, offset, ...(appliedFilter ? { phone: appliedFilter } : {}) },
      tenantId,
      accountId,
    )
      .then((res) => {
        setEntries(res.entries);
        setTotal(res.total);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Could not load the Do Not Call list.'),
      )
      .finally(() => setLoading(false));
  }, [tenantId, accountId, offset, appliedFilter]);

  useEffect(load, [load]);

  const onAdd = useCallback(async () => {
    const numbers = addInput
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (numbers.length === 0) return;

    setAdding(true);
    try {
      // `account_id` is deliberately not sent: an account-scoped row never
      // enters core's flat `dnc:{tenantId}` Redis set, so it would appear on
      // this list while failing to suppress a single dial. Tenant-wide is the
      // only scope that actually stops a call.
      const summary = await addDncEntries(
        {
          phone_numbers: numbers,
          source: 'api',
          ...(addReason.trim() ? { reason: addReason.trim() } : {}),
        },
        tenantId ?? undefined,
        accountId ?? undefined,
      );
      setLastSummary(summary);
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
  }, [addInput, addReason, offset, tenantId, accountId, load, showErrorToast]);

  const onRemove = useCallback(async () => {
    if (!removing) return;
    const entry = removing;
    setRemoving(null);
    try {
      await removeDncEntry(entry.id, tenantId ?? undefined, accountId ?? undefined);
      /*
        Q2, on the one sentence that outlives the act. "can be called again" was
        precisely the confirm dialog's over-claim — narrowed there to agency
        campaigns, then restated unqualified in the toast that stays on screen
        after Remove is pressed. This is the last thing the operator reads about
        this number, so it is the one that most has to be right: nothing about an
        AI call, a broadcast or a Softphone dial changed, because none of them
        ever consulted this list.
      */
      showToast(`${entry.phone_e164} removed — agency campaigns can dial it again.`, 'success');
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
  }, [removing, entries.length, offset, tenantId, accountId, load, showToast, showErrorToast]);

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Do Not Call</h1>

      {/*
        Q2: this list is agency-only, and the copy has to say so. It stops
        agency campaigns from dialing a number; it has no bearing on AI calls,
        broadcasts or the Softphone, none of which consult it. Presenting it as
        platform-wide compliance would leave an operator believing a customer
        who asked not to be called is protected everywhere — the one
        misunderstanding on this page that costs a customer something.
      */}
      <PageDescription
        pageKey="agency-dnc"
        description={
          'Agency campaigns don’t dial the numbers on this list — every campaign for a '
          + 'workspace-wide entry, or only the campaign or account the Scope column names. It does '
          + 'not apply to AI calls, broadcasts or the Softphone. Agents add numbers from the '
          + 'station when a customer asks; you can also add them in bulk here.'
        }
        tips={[
          'A workspace-wide entry blocks the number in every agency campaign and account.',
          'Adding a number that is already listed is harmless — it stays listed once.',
          'Removing a number lets agency campaigns dial it again — if the customer asked not to '
          + 'be called, leave it listed.',
          'An entry scoped to one campaign or account IS enforced, but only there and only when '
          + 'contacts are imported — it is not in the dialer’s block list. See the Scope column.',
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
          <button
            type="button"
            className="btn-primary"
            onClick={() => void onAdd()}
            disabled={adding || addInput.trim().length === 0}
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
            <div className={styles.summary}>
              <strong>{lastSummary.added}</strong> added,{' '}
              <strong>{lastSummary.already_present}</strong> already listed,{' '}
              <strong>{lastSummary.invalid}</strong> not usable.
              {lastSummary.invalid > 0 && (
                <ul className={styles.invalidList}>
                  {lastSummary.results
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
            onChange={(e) => setPhoneFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setOffset(0);
                setAppliedFilter(phoneFilter.trim());
              }
            }}
            placeholder="Search a number…"
          />
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setOffset(0);
            setAppliedFilter(phoneFilter.trim());
          }}
        >
          Search
        </button>
      </div>

      {error && <ErrorAlert message={error} onRetry={load} />}

      {loading && <LoadingSpinner />}

      {!loading && entries.length === 0 && (
        <EmptyState
          icon={<PhoneOff size={32} />}
          title={appliedFilter ? 'No match' : 'Nothing on the list'}
          description={
            appliedFilter
              ? 'No suppressed number matches that search.'
              : 'When an agent marks a customer as do-not-call, they appear here and agency '
                + 'campaigns stop dialing them.'
          }
        />
      )}

      {!loading && entries.length > 0 && (
        <>
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
                    {(() => {
                      const kind = scopeOf(entry);
                      return (
                        <span
                          className={kind === 'tenant' ? styles.scopeGlobal : styles.scopeNarrow}
                          title={SCOPE_TOOLTIP[kind]}
                          data-testid={`dnc-scope-${kind}`}
                        >
                          {SCOPE_LABEL[kind]}
                        </span>
                      );
                    })()}
                  </td>
                  <td>{formatDate(entry.created_at)}</td>
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
                        onClick={() => setRemoving(entry)}
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
        The title carries the scope too, not just the body. "Make this number
        callable again?" is the question the operator answers, and read alone it
        promises a change this page cannot make — the body's qualification comes
        after the decision has already been framed.
      */}
      <ConfirmDialog
        open={removing !== null}
        title="Let agency campaigns dial this number again?"
        message={
          removing
            ? `${removing.phone_e164} will be removed from the Do Not Call list, and agency `
              + 'campaigns will be able to dial it again. If it was added at a customer’s request, '
              + 'removing it undoes that request.'
            : ''
        }
        confirmLabel="Remove"
        danger
        onConfirm={() => void onRemove()}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}

export default DncPage;
