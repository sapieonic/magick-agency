import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { getAgentAttempts, getMyAttempts } from '../api/agencyStats';
import { decideListResponse } from '../utils/agencyStaleResponse';
import { attemptFilterGroupCount } from '../utils/agencyAttemptFilters';
import { getErrorMessage } from '../utils/errors';
import {
  trackAgencyStaleResponseDiscarded,
  trackAgentAttemptsFiltered,
  trackAgentAttemptsLoadMoreFailed,
} from '../analytics/events';
import type { AgencyAttempt, AgencyAttemptFilters } from '../types/agency-spine';

/**
 * One person's dial history, across every campaign they worked — the read behind
 * "My calls" and behind its supervisor twin.
 *
 * ── Whose calls, decided by a discriminated subject ────────────────────────
 * The same union {@link useAgentPerformance} uses, for the same reason and against
 * the same pair of routes. `{ kind: 'me' }` reads `GET /agency/my-attempts`,
 * floored at `agency.station.connect` so a bare `agent` (hierarchy level 5) can
 * call it and scoped to the caller **server-side**. `{ kind: 'agent', userId }`
 * reads the supervisor twin, floored at `agency.supervise`.
 *
 * A union rather than an optional `userId`: an optional subject is a subject a
 * caller can supply by accident, and the whole point of the paired routes is that
 * an agent cannot form a request for somebody else's shift. Callers of the
 * `agent` form **must** gate on `hasPermission(role, 'agency.supervise')` —
 * the API's exact floor. Looser renders a list whose first read 403s; tighter
 * hides it from an `account_admin` who holds it.
 *
 * ── The filters live HERE, and that is the cursor-reset fix ────────────────
 * The tempting shape is filters in the component and a `load(filters)` call in
 * the hook. It is also how you ship the defect keyset pagination is most prone
 * to: **a filter change that does not reset the cursor appends page 2 of the old
 * query to page 1 of the new one**, producing a list that is internally
 * inconsistent and looks like a backend bug.
 *
 * So `filters` is hook state, and every change to it re-enters `load`, which
 * replaces the rows and drops the cursor on the floor. There is no code path in
 * which a caller can change a filter and keep a cursor, because the caller does
 * not hold the cursor at all. The panel keeps DRAFT filter state (so typing does
 * not fire a request per keystroke) and hands over a whole `AgencyAttemptFilters`
 * when Apply is pressed.
 *
 * ── Keyset, so there are no page numbers to offer ─────────────────────────
 * `next_cursor` is opaque and there is no `total` — deliberately, see
 * `AgencyKeysetPage`. That makes "load more" the only honest control: numbered
 * pages need a count the API will not produce, and a "page 4" button would have
 * nothing to jump with. Appending is therefore not a UX preference, it is the
 * shape of the data.
 *
 * ── Two guards, because they answer different questions ───────────────────
 * `generation` answers *is this response still the newest?* — via
 * `decideListResponse`, which is where the two-line rule and its reasoning live.
 * `mounted` answers *is there still a component here?*: a manual reload's
 * cleanup is never handed to `useEffect`, so navigating away shortly after one
 * otherwise leaves a promise chain that still calls `setState`. Same pair, same
 * reasoning, as `useAgentPerformance` — including that the flag is SET on mount
 * and not merely cleared on unmount, which is what keeps it true under
 * `React.StrictMode`'s setup → cleanup → setup.
 */

export type AgentAttemptsSubject = { kind: 'me' } | { kind: 'agent'; userId: string };

/** Everything the filter card can narrow by. `campaign_id` is not on the base type. */
export type AgentAttemptsFilters = AgencyAttemptFilters & { campaign_id?: string };

/**
 * The first page's state.
 *
 * Three arms rather than `rows` plus a `loading` boolean, because the three
 * absences this surface has to keep apart — *we could not read it*, *there is
 * genuinely nothing*, and *it has not arrived yet* — are indistinguishable once
 * they all collapse into an empty array.
 */
export type AgentAttemptsPage =
  | { status: 'loading' }
  | { status: 'ready'; rows: AgencyAttempt[]; nextCursor: string | null }
  | { status: 'error'; message: string };

export interface UseAgentAttempts {
  page: AgentAttemptsPage;
  /** The APPLIED filters — never the drafts the panel is still editing. */
  filters: AgentAttemptsFilters;
  /** Replace the applied filters. Always refetches from the first page. */
  /**
   * `usedFreeText` is analytics-only: whether the caller's free-text disposition
   * box (as opposed to a chip click) contributed to `filters.disposition_code`.
   * The array itself carries no origin, so the caller must say so at the one
   * point it still knows — see `applyFilters`'s own comment for why this
   * couldn't be observed from inside the hook.
   */
  applyFilters: (filters: AgentAttemptsFilters, meta?: { usedFreeText?: boolean }) => void;
  /** Re-read the first page under the current filters. */
  reload: () => void;
  loadMore: () => void;
  loadingMore: boolean;
  /**
   * A failed "load more", kept apart from `page.status === 'error'`.
   *
   * The rows already on screen are still good, so blanking them for a failure
   * that happened while asking for MORE of them would throw away what the reader
   * came for. Shown beside the button instead.
   */
  moreError: string | null;
}

/** One page. Matches the campaign spine's, so both lists page at the same rate. */
export const ATTEMPTS_PAGE_SIZE = 50;

export function useAgentAttempts(subject: AgentAttemptsSubject): UseAgentAttempts {
  const { tenantId, accountId } = useTenant();
  const [filters, setFilters] = useState<AgentAttemptsFilters>({});
  const [page, setPage] = useState<AgentAttemptsPage>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const generation = useRef(0);
  const mounted = useRef(true);
  /**
   * How many pages are on screen, for `agent_attempts_load_more_failed`'s
   * `pages_loaded` — kept apart from `page`/`nextCursor` because those describe
   * the ROWS, not the count of successful reads that produced them. Reset to 1
   * whenever a first page lands (a fresh query is always page one) and
   * incremented on every successful "load more"; a failed "load more" reads it
   * without touching it, so the value reported is the count BEFORE the failed
   * attempt.
   */
  const pagesLoaded = useRef(0);
  useEffect(() => {
    /*
      Set on the way IN as well as cleared on the way out. `React.StrictMode`
      (which `main.tsx` wraps the whole app in) runs every effect setup →
      cleanup → setup in development, so a cleanup-only effect leaves this
      `false` while the component is very much mounted — every response is then
      discarded as stale and the surface spins forever. A defect that exists
      only in development is still a defect: it is the build every reviewer and
      every developer sees.
    */
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * The subject as two primitives, so `load`'s identity does not change on every
   * render just because the caller passed a fresh object literal — which is what
   * every caller naturally does, and which would otherwise refetch the first page
   * on each keystroke elsewhere on the page. Two values rather than one encoded
   * `` `agent:${id}` `` key: that has to be taken apart again at the call, and an
   * id containing the separator would silently address the wrong person.
   */
  const subjectKind = subject.kind;
  const subjectUserId = subject.kind === 'agent' ? subject.userId : null;

  const read = useCallback(
    (active: AgentAttemptsFilters, cursor: string | undefined, ids: { tenantId: string; accountId: string }) =>
      subjectKind === 'me' || subjectUserId === null
        ? getMyAttempts(active, { cursor, limit: ATTEMPTS_PAGE_SIZE }, ids.tenantId, ids.accountId)
        : getAgentAttempts(
            subjectUserId,
            active,
            { cursor, limit: ATTEMPTS_PAGE_SIZE },
            ids.tenantId,
            ids.accountId,
          ),
    [subjectKind, subjectUserId],
  );

  const load = useCallback(() => {
    /**
     * Both ids, for the reason every agency surface waits for both: an `agent` is
     * below `account.read`'s `viewer` floor so `GET /accounts` 403s for them, and
     * a request sent before `TenantContext` resolves carries no `X-Account-Id`,
     * which the API answers with a 400 about a header this client never sent — an
     * error with nothing to do with the data being asked for.
     *
     * This early return can never become a permanent spinner, because the caller
     * renders `AccountUnavailable` once resolution SETTLES without an account.
     * That pairing is the whole guard; neither half works alone.
     */
    if (!tenantId || !accountId) return;

    const mine = (generation.current += 1);
    setPage({ status: 'loading' });
    // A new first page ends any pending append: its cursor belonged to the old
    // query, and its error belonged to a list that is no longer on screen.
    setLoadingMore(false);
    setMoreError(null);

    read(filters, undefined, { tenantId, accountId })
      .then((result) => {
        if (!mounted.current) return;
        const decision = decideListResponse({ seq: mine }, generation.current);
        if (decision.action === 'discard') {
          trackAgencyStaleResponseDiscarded({ surface: 'attempts_list', reason: decision.reason });
          return;
        }
        pagesLoaded.current = 1;
        setPage({ status: 'ready', rows: result.rows, nextCursor: result.next_cursor });
      })
      .catch((err: unknown) => {
        if (!mounted.current) return;
        // Discarded on the failure path too: an error about a superseded query
        // would sit above rows that loaded perfectly well under the new one.
        const decision = decideListResponse({ seq: mine }, generation.current);
        if (decision.action === 'discard') {
          trackAgencyStaleResponseDiscarded({ surface: 'attempts_list', reason: decision.reason });
          return;
        }
        setPage({
          status: 'error',
          // The server's own sentence: these failures are mostly permission- or
          // connectivity-shaped and ours would be a guess.
          message: getErrorMessage(err, 'We couldn’t load these calls.'),
        });
      });
  }, [tenantId, accountId, filters, read]);

  useEffect(load, [load]);

  const loadMore = useCallback(() => {
    if (page.status !== 'ready' || page.nextCursor === null) return;
    if (loadingMore || !tenantId || !accountId) return;

    /**
     * CAPTURED, not incremented. This is a continuation of the query already on
     * screen rather than a new one — so a filter change landing while it is in
     * flight moves the counter past this value and `decideListResponse` throws
     * the page away, instead of appending rows from the old filter beneath the
     * new filter's first page.
     */
    const mine = generation.current;
    const cursor = page.nextCursor;
    setLoadingMore(true);
    setMoreError(null);

    read(filters, cursor, { tenantId, accountId })
      .then((result) => {
        if (!mounted.current) return;
        const decision = decideListResponse({ seq: mine }, generation.current);
        if (decision.action === 'discard') {
          trackAgencyStaleResponseDiscarded({ surface: 'attempts_list', reason: decision.reason });
          return;
        }
        pagesLoaded.current += 1;
        setPage((prev) =>
          // Appended, never replaced: a keyset page is a continuation. The guard
          // on `prev.status` is not defensive noise — `load` can have reset the
          // state between the check above and this update.
          prev.status === 'ready'
            ? { status: 'ready', rows: [...prev.rows, ...result.rows], nextCursor: result.next_cursor }
            : prev,
        );
        setLoadingMore(false);
      })
      .catch((err: unknown) => {
        if (!mounted.current) return;
        const decision = decideListResponse({ seq: mine }, generation.current);
        if (decision.action === 'discard') {
          trackAgencyStaleResponseDiscarded({ surface: 'attempts_list', reason: decision.reason });
          return;
        }
        // Kept apart from a failed FIRST page (above): the rows already on
        // screen are still good, and `pages_loaded` is read BEFORE this attempt
        // would have incremented it — the count the reader was looking at when
        // "load more" failed.
        trackAgentAttemptsLoadMoreFailed({ subject: subjectKind, pages_loaded: pagesLoaded.current });
        setMoreError(getErrorMessage(err, 'We couldn’t load any more calls.'));
        setLoadingMore(false);
      });
  }, [page, loadingMore, tenantId, accountId, filters, read, subjectKind]);

  /**
   * Applying filters is the ONLY way to change them, and it goes through
   * `setFilters` — which re-enters `load`, which replaces the rows and drops the
   * cursor. See the header: there is deliberately no path that changes a filter
   * while keeping a cursor.
   */
  const applyFilters = useCallback(
    (next: AgentAttemptsFilters, meta?: { usedFreeText?: boolean }) => {
      /*
        The one place a filter change resets the cursor (see the header), so it
        is also the one place to record what changed. `disposition_code`
        collapses a chip click and a typed-then-added code into the same array
        before it reaches this hook (`AgentAttemptsPanel`'s `draftCodes`), so
        there is no origin left to tell apart from the array alone —
        `used_free_text` is the caller's own answer, from the one place
        upstream that still knows which control the operator used.
      */
      trackAgentAttemptsFiltered({
        subject: subjectKind,
        filter_group_count: attemptFilterGroupCount(next),
        has_date_range: Boolean(next.from || next.to),
        disposition_chip_count: next.disposition_code?.length ?? 0,
        used_free_text: meta?.usedFreeText ?? false,
        campaign_scoped: Boolean(next.campaign_id),
      });
      setFilters(next);
    },
    [subjectKind],
  );

  return useMemo(
    () => ({ page, filters, applyFilters, reload: load, loadMore, loadingMore, moreError }),
    [page, filters, applyFilters, load, loadMore, loadingMore, moreError],
  );
}
