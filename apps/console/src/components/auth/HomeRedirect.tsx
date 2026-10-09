import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import { LoadingSpinner } from '../common/LoadingSpinner';

/**
 * Where the app root goes — which depends on what the tenant has bought.
 *
 * ── The defect this closes (handoff E4) ─────────────────────────────────────
 * A pure-agency tenant — one that holds the Agency Dialer and none of the
 * primary application's own products — signed in and landed on `/app`: an AI
 * dashboard of AI call stats, an AI getting-started checklist and channel cards
 * for channels they do not have. Nothing was broken and everything was empty.
 * The workspace they pay for was two clicks away behind a nav entry they had to
 * find. Routing the default shell on entitlement is the whole fix.
 *
 * ── Capabilities are the signal, and the `calls` NODE cannot be part of it ──
 * Of the four gating layers, governance capabilities are the one that answers
 * "what does this tenant have": RBAC answers "who is this person", core's
 * feature flags answer "is the code switched on", and route guards are the
 * consequence rather than the input.
 *
 * The obvious predicate — `agency && !calls` — cannot work, and it is worth
 * writing down why rather than letting the next reader rediscover it. `calls` is
 * `mandatory: true` in master's catalog (`src/governance/catalog.ts:35`): the
 * resolver forces it to `true` for every tenant and an override cannot turn it
 * off. So `calls === false` is unreachable and an `&& !calls` clause is an
 * `&& false`. The same fact is why `agency` is a ROOT capability rather than a
 * child of `calls` (§7 — "`calls` is `mandatory:true` and could never gate it").
 *
 * That is a fact about one NODE, and an earlier revision of this comment turned
 * it into a rule about the whole `calls` SUBTREE. It does not follow. Nothing
 * under `calls` is a source of agency-ness — but the other half of this test is
 * proving AI-ness, and for that the subtree is evidence like any other:
 * `calls.dialer` is `default: false` and disableable (`catalog.ts:38`), so a
 * `true` there is not an always-on platform fact, it is an operator having
 * granted the Softphone — which §7b places squarely in the AI zone. Every
 * non-mandatory key below is judged on its own catalog row, not on its ancestry.
 *
 * ── What counts as a primary-app product, key by key ───────────────────────
 * Two kinds of evidence, both meaning "this tenant uses the AI product":
 *
 *  1. **On by default, disableable.** `campaigns` (Broadcasts), `messaging`,
 *     `ivr`, `scheduling` — all `default: true`. Switching these off is what an
 *     operator provisioning a pure-agency tenant actually does, so an explicit
 *     `false` on each is the positive signal.
 *  2. **Off by default, so a `true` is a GRANT.** `calls.dialer` (Softphone),
 *     `sip` (Customer SIP Trunks), `knowledge_bases`, and `escalation` (human
 *     transfer out of an AI call) — all `default: false`. Nobody holds one of
 *     these by accident. Requiring `false` costs the operator nothing, because
 *     off is already the default: these add no override to the provisioning act.
 *
 * `scheduling` is in the list on evidence, having been left out of an earlier
 * revision on a claim that turned out to be false. The claim was that scheduling
 * only composes broadcasts and messages, so with those off it reaches nothing. It
 * does not: `pages/schedules/SchedulesPage.tsx` and
 * `CreateRecurringSchedulePage.tsx` both offer an `ai_voice_call` schedule, which
 * needs nothing beyond the mandatory `calls` tree. A collections agency running
 * human dialing plus scheduled AI follow-up calls is a both-products tenant, and
 * was being redirected out of half of what it bought every morning.
 *
 * Deliberately NOT in the list, each for a reason about its own row:
 *
 *  - `calls` — `mandatory: true`; see above.
 *  - `calls.analytics`, `calls.recording` — `default: true` children of that
 *    mandatory node. Every tenant has them on and no operator turns them off to
 *    describe a product boundary, so requiring `false` would only stop this
 *    feature from ever firing.
 *  - `calls.dialer.analytics` — master's resolver gates a child on its entire
 *    parent chain, so it cannot be `true` unless `calls.dialer` is, which is
 *    tested. Redundant, not excluded.
 *  - `messaging.*`, `agency.*` — same parent gating, under keys already tested or
 *    under `agency` itself.
 *
 * ── The honest cost: this predicate is strict, and fires rarely ────────────
 * `campaigns`, `messaging`, `ivr` and `scheduling` are `default: true` with only
 * sparse DB overrides, so firing requires an operator to have written FOUR
 * explicit `false` overrides. The likely provisioning act for a pure-agency
 * tenant is one override (`agency: true`), which does not fire. Tightening the
 * predicate — which is what adding `scheduling` and the four grant keys did —
 * makes it fire less often still.
 *
 * That is the safe direction (a missing redirect leaves today's behaviour; a
 * wrong one strands a paying customer), but read it for what it is: this infers
 * "agency-only" from the ABSENCE of everything else, which is not the question
 * "what did we sell this tenant". Until a tenant carries a positive marker of its
 * own — a provisioning preset, or a tenant attribute master sets when it sells
 * the agency offering alone — this feature fires for tenants an operator has
 * explicitly stripped, and not for most agency-only tenants. It is worth having
 * anyway (it is free when it does fire, and harmless when it does not), but do
 * not read the code as evidence that pure-agency tenants land in `/agency`.
 *
 * ── Fail safe, and which way "safe" points ─────────────────────────────────
 * A wrong redirect strands a paying customer outside the product they opened; a
 * missing redirect leaves them exactly where they are today. So the two errors
 * are not symmetrical and only positive knowledge redirects:
 *
 *  1. **Map still loading** — wait, then decide (below).
 *  2. **Fetch failed** — `GovernanceProvider` keeps the previous/seed map and
 *     clears `loading`, so a failed read leaves the keys absent. Every clause
 *     below tests `=== true` / `=== false` rather than truthiness, so an absent
 *     key is never read as "off" and the predicate answers `false`. → `/app`.
 *  3. **Both products** — `false`. → `/app`.
 *  4. **The agency flag is off in core** — `false`, even with the capability on.
 *     `/agency` is gated on `agency_dialer_enabled` as well, so redirecting on
 *     the capability alone would land the reader on a plan-gate refusal with no
 *     shell around it — stranded, just one layer further in. `useFeatureFlags`
 *     fails closed, which makes this clause free.
 *
 * ── Only 1 waits, and the wait needed a bound of its own ──────────────────
 * Waiting is what stops this being a feature that never fires.
 * `GovernanceProvider` seeds its map from the login payload but reads that seed
 * as `useState`'s initial value only — it mounts at app boot while auth is still
 * resolving, so the seed is `{}` and the map is empty until the active-context
 * fetch lands. Deciding during `loading` therefore means deciding on an empty
 * map, i.e. always `/app`, i.e. never.
 *
 * **But `status === 'loading'` is not bounded, and an earlier revision of this
 * comment asserted that it was** — that the flag status is only `'loading'` while
 * account resolution is genuinely in flight. True of governance, false of the
 * flags. With no tenant at all, `TenantContext`'s auto-select effect returns
 * early on an empty `tenants` list, so `activeTenantId` stays `null`; the account
 * effect then parks `accountResolution` at `'loading'` ("nothing to resolve
 * yet"), and `FeatureFlagsContext` maps that to `status === 'loading'` for the
 * life of the session — every other exit needs an `activeTenantId` that nothing
 * will now set. A signed-in user with no tenant (their only membership revoked;
 * provisioned but never assigned) therefore met a bare full-viewport spinner,
 * with no top bar and so no way to sign out. Before this route existed they fell
 * through to `/app`: half-empty but escapable. Trapping them is strictly worse
 * than the empty dashboard this component exists to avoid.
 *
 * Hence the bound: **no tenant means nothing to decide about.** There is no
 * entitlement question without a tenant — the map can only be the login seed,
 * which carries no `agency` — so this lands on `/app`, which renders `AppLayout`,
 * which has a `TopBar` with a sign-out in it. `tenants` comes from `useAuth`
 * rather than from `TenantContext` because `tenantId === null` cannot tell the two
 * cases apart: it is equally the state of a cold entry, for the one render before
 * the auto-select effect fires, and bailing on that would kill the feature for
 * every first sign-in with no `magick-active-tenant` in `localStorage`.
 * `RequireAuth` renders this component only after auth settles with a user, and
 * `tenants` is written in the same state update as that user, so an empty list
 * here is final rather than early.
 *
 * The bound is deliberately LOCAL. What it works around is
 * `FeatureFlagsContext`'s no-account branch, where a permanent `'loading'` is now
 * the THIRD variant of a hole that file has closed twice already — its own
 * docstring enumerates the other two (`accountResolution === 'error'`, and
 * settled-but-accountless: a tenant with zero accounts, or a `'degraded'`
 * fallback whose narrowed list came back empty). Closing it there, by reporting
 * `'error'` when there is no tenant, is the general answer and was considered and
 * rejected for this change: `status` has many consumers, and flipping a permanent
 * `'loading'` into `'error'` turns spinners into error UI across the app — a far
 * wider blast radius than this trap justifies. This component is the only
 * consumer that can strand somebody with no way out; every other one renders
 * inside a shell that still has navigation. So the bound belongs here. If a later
 * reader does close it in the context, this guard becomes redundant rather than
 * wrong.
 *
 * A spinner is honest for the remaining, genuinely in-flight case, for the reason
 * `AgencyHomeRedirect` gives at its own — this route renders no content of its
 * own either way, so waiting costs nothing and avoids a flash of the wrong shell.
 *
 * ── This is a ROUTING decision, not an enforcement one ─────────────────────
 * Nothing here gates access. `RequireCapability` still fails open on purpose and
 * must keep doing so (§7); master's 403 is the real enforcement. Everything this
 * component can get wrong is a matter of which of two reachable pages somebody
 * lands on first.
 *
 * ── Why the root and not `/app`'s index route ──────────────────────────────
 * Putting it on `<Route index>` under `/app` would have killed the deliberate
 * exit. `AgencyLayout` links back to `/app` for the platform zone — team,
 * credits, invoices, settings, the audit log — and §7b requires that link to
 * survive: "a pure-agency supervisor legitimately administers in `/app` and
 * operates in `/agency`". A redirect on `/app` would bounce that exit straight
 * back into `/agency`, leaving the platform zone unreachable for exactly the
 * tenant this component exists to serve. The root is the only place the decision
 * can be made once, on arrival, without contradicting an intent the reader has
 * already expressed by clicking something.
 */

/*
 * PORT NOTE (magick-agency): cusui's `PRIMARY_APP_PRODUCTS` and
 * `isAgencyOnlyTenant` are removed. They answered "does this tenant hold the
 * agency capability and NONE of the AI product's" from master's governance map;
 * in Magick Agency every tenant is agency-only by construction (there is no AI
 * product, and the section-level `agency` gate is always on, plan §3.2). So the
 * predicate reduces to the dialer flag alone, below. The `/app` shell this falls
 * back to is the platform zone (team, notifications, call summaries) — see
 * `pages/AppHomeRedirect.tsx`, `/app`'s index.
 */

export function HomeRedirect() {
  const { tenants } = useAuth();
  const { loading } = useGovernance();
  const { isEnabled, status } = useFeatureFlags();

  /**
   * No tenant, so no entitlement question — and, crucially, nothing that will
   * ever finish resolving. See the bound in the docstring: without this, a
   * signed-in user with no tenant membership waits on a `status` that stays
   * `'loading'` for the whole session, on a page with no way to sign out.
   */
  if (tenants.length === 0) {
    return <Navigate to="/app" replace />;
  }

  if (loading || status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const agencyOnly = isEnabled('agency_dialer_enabled');

  return <Navigate to={agencyOnly ? '/agency' : '/app'} replace />;
}

export default HomeRedirect;
