import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { TenantProvider } from './contexts/TenantContext';
import { FeatureFlagsProvider } from './contexts/FeatureFlagsContext';
import { GovernanceProvider } from './contexts/GovernanceContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './contexts/ToastContext';
import RequireAuth from './components/auth/RequireAuth';
import RequireCapability from './components/auth/RequireCapability';
import RequireFlag from './components/auth/RequireFlag';
import HomeRedirect from './components/auth/HomeRedirect';
import { ProductSurface } from './analytics/ProductSurface';
import { AppLayout } from './components/layout/AppLayout';
import { AgentLanding } from './components/agency/AgentLanding';

/*
 * PORT NOTE (magick-agency): cusui's `src/App.tsx` @ ee5beb44, cut to the
 * console's scope (docs/briefs/phase-9-console.md). Kept verbatim, comments
 * included: the agency doors (`/agency/login`, `/agency/join/:token`), the root
 * `HomeRedirect`, the four full-viewport agent routes (`/station`, `/dialer`,
 * `/dialer/performance`, `/dialer/attempts`), the whole `/agency` tree, and the
 * `/app` shell — now the PLATFORM zone only: Team, Notifications and Call
 * Summaries. Changed:
 *  - `/login` renders `AgencyLoginPage`. cusui's `LoginPage` (AI marketing, a
 *    sign-up tab, the super-admin mode) and `/onboarding` are not ported: agency
 *    has no self-serve sign-up (session path 4 is refused, plan §3.1).
 *  - `/app`'s index is `AppHomeRedirect` (cusui: the AI `DashboardPage`).
 *  - `call-summaries` is gated on agency's `agency.analytics` capability and
 *    `agency_call_analysis` flag (cusui: `calls.dialer.analytics` and the
 *    softphone's `dialer_call_analysis`).
 *  - Providers: `MetadataProvider` (AI metadata) and `SuperAdminProvider` (the
 *    super-admin console is its own app) are not mounted; `GovernanceProvider`
 *    now derives from the session's settings map. `IndependenceDayDecor` is not
 *    ported.
 * Every other cusui route (calls, prompts, IVR, automations, broadcasts,
 * messaging, SIP, escalation, knowledge, schedules, contact lists, accounts,
 * credits, API keys, audit log, tenant settings, phone numbers, super-admin) is
 * AI or out of scope and is not ported; the catch-all still sends them to `/app`.
 */

const AppHomeRedirect = lazy(() => import('./pages/AppHomeRedirect'));
const AgencyLoginPage = lazy(() => import('./pages/agency/AgencyLoginPage'));
const AgencyJoinPage = lazy(() => import('./pages/agency/AgencyJoinPage'));
const VerifyEmailPage = lazy(() => import('./pages/auth/VerifyEmailPage'));
const AgentConsolePage = lazy(() => import('./pages/agency/AgentConsolePage'));
const TeamPage = lazy(() => import('./pages/team/TeamPage'));
const NotificationSettingsPage = lazy(() => import('./pages/settings/NotificationSettingsPage'));
const AnalysisProfilesPage = lazy(() => import('./pages/settings/AnalysisProfilesPage'));
const AgencyCampaignBuilderPage = lazy(() => import('./pages/campaigns/agency/CampaignBuilderPage'));
const AgencyLayout = lazy(() =>
  import('./components/layout/AgencyLayout').then((m) => ({ default: m.AgencyLayout })),
);
const AgencyCampaignsPage = lazy(() => import('./pages/agency/AgencyCampaignsPage'));
const AgencyAnalyticsPage = lazy(() => import('./pages/agency/AgencyAnalyticsPage'));
const AgentHomePage = lazy(() => import('./pages/agency/AgentHomePage'));
const AgentPerformancePage = lazy(() => import('./pages/agency/AgentPerformancePage'));
const AgentAttemptsPage = lazy(() => import('./pages/agency/AgentAttemptsPage'));
const AgencyHomeRedirect = lazy(() => import('./pages/agency/AgencyHomeRedirect'));
const AgencyCampaignDetailPage = lazy(() => import('./pages/agency/AgencyCampaignDetailPage'));
const DncPage = lazy(() => import('./pages/agency/DncPage'));
const AgencyCampaignSettingsPage = lazy(() => import('./pages/agency/AgencyCampaignSettingsPage'));
const AgencyCampaignContactsPage = lazy(() => import('./pages/agency/AgencyCampaignContactsPage'));
const AgencyCampaignRosterPage = lazy(() => import('./pages/agency/AgencyCampaignRosterPage'));
const AgencyCampaignAttemptsPage = lazy(() => import('./pages/agency/AgencyCampaignAttemptsPage'));
const AgencyAttemptCallPage = lazy(() => import('./pages/agency/AgencyAttemptCallPage'));
const AgencyContactDetailPage = lazy(() => import('./pages/agency/AgencyContactDetailPage'));
const AgencyCampaignActivityPage = lazy(() => import('./pages/agency/AgencyCampaignActivityPage'));

export default function App() {
  return (
    <ThemeProvider>
    <ToastProvider>
    <AuthProvider>
      <TenantProvider>
        <FeatureFlagsProvider>
        <GovernanceProvider>
          <BrowserRouter>
            <Suspense fallback={null}>
            <Routes>
              <Route path="/login" element={<AgencyLoginPage />} />
              {/*
                The Agency Dialer's own front door.

                ── Beside `/login`, and OUTSIDE the `/agency` shell ─────────────
                Declared here rather than as a child of `/agency` because that
                route is wrapped in `RequireAuth`: a sign-in page inside it would
                bounce every signed-out visitor to `/login`, which is the one
                thing this page exists to stop. It is also outside the capability
                and flag gates for the same reason — those resolve per tenant and
                per account, and there is no tenant to resolve for somebody who
                has not signed in yet.

                The path still reads `/agency/login`, because the URL is the
                thing an agency hands to staff and `dialer.example/agency/login`
                says what it is. React Router ranks the more specific static
                path above `/agency`'s children, so this wins without the shell
                needing to know it exists.

                ── One identity system, two entrances ──────────────────────────
                Not a second auth tree. Agency staff are ordinary master users
                with tenant memberships, and this page calls the same
                `signInEmail`/`signInGoogle` as `LoginPage` and produces the same
                session; super-admin's separate JWT is the pattern this
                deliberately does NOT follow. What differs is the signup (there
                is none, because `POST /auth/session` provisions a tenant for an
                address master does not recognise), the pitch, and the landing —
                which defaults to `/agency` so `AgencyHomeRedirect` resolves the
                persona instead of this page guessing it. See
                `pages/agency/AgencyLoginPage`.
              */}
              <Route path="/agency/login" element={<AgencyLoginPage />} />
              {/*
                Where an emailed agency invite lands.

                ── Fully public, and every missing guard is a decision ──────────
                No `RequireAuth`, no `RequireCapability`, no `RequireFlag` — the
                only route in the agency surface with none of the three, and each
                absence answers a different question the same way: there is
                nobody here yet.

                `RequireAuth` would redirect the visitor to `/agency/login` and
                throw the token away, which is the whole invitation. The person
                opening this link is by definition somebody who has NO account —
                that is what the link is for — so authenticating first is asking
                them to already be what they came here to become.

                `RequireCapability` and `RequireFlag` both resolve per tenant and
                per account, off a session that does not exist. They are also
                answering the wrong question: those two gates decide whether a
                tenant HAS the dialer, and the tenant that sent this invite
                demonstrably does. Gating here would mean an entitlement read
                failing open or closed on an absent tenant id, on the one screen
                where failing closed costs the agency a member of staff.

                The authority on this page is the single-use token in the URL, and
                master enforces it: `POST /invites/:token/claim` reads the token,
                not the caller's session or the address they sign in with. That is
                what lets this page exist without a guard in front of it, and it
                is also the fix for the defect `/agency/login` can only diagnose —
                see `pages/agency/AgencyJoinPage`.

                Declared beside `/agency/login` rather than under `/agency` for
                the same routing reason that one is: `/agency` is wrapped in
                `RequireAuth`, and react-router ranks these more specific static
                prefixes above its children, so both win without the shell needing
                to know they exist.
              */}
              <Route
                path="/agency/join/:token"
                element={
                  /*
                    Outside both shells, like `/station` and `/dialer`, so the
                    product dimension has no layout to come from — see
                    `analytics/ProductSurface`. Unlike those four it sits inside
                    no gate, because there is none to sit inside; that is safe
                    here for the reason the gates are absent at all. Nobody can be
                    refused this page, so nobody can register a surface they were
                    not shown. Without it the whole invite funnel — the one
                    measuring whether agency onboarding works — would report no
                    product and fall out of the agency's own numbers.
                  */
                  <ProductSurface product="agency">
                    <AgencyJoinPage />
                  </ProductSurface>
                }
              />
              <Route path="/verify-email" element={<VerifyEmailPage />} />

              {/*
                The app root, routed on ENTITLEMENT rather than fixed at `/app`
                (handoff E4). A pure-agency tenant used to sign in to an AI
                dashboard of numbers it does not generate; now the default shell
                follows what the tenant has. See `HomeRedirect` for the predicate,
                for why `calls` cannot be part of it, and for why the decision is
                made HERE rather than on `/app`'s index route — a redirect there
                would bounce `AgencyLayout`'s deliberate "Team & settings"
                exit straight back into `/agency` and put the platform zone out of
                reach.

                Declared explicitly rather than left to the catch-all below, and
                wrapped in `RequireAuth` so a signed-out visitor typing the bare
                domain gets `?next=/` and comes back through this decision after
                signing in — which is the path that matters, because it is how
                somebody arrives at the product in the morning. `LoginPage`
                falls back to `/` too when it is opened with no `next` at all, so
                that path reaches this decision rather than bypassing it — which
                was the point of changing it.

                The catch-all stays pointed at `/app`: an unrecognised URL is a
                404 being swallowed, not somebody asking to be taken home, and
                sending it through an entitlement decision would dress one up as
                the other.
              */}
              <Route path="/" element={<RequireAuth><HomeRedirect /></RequireAuth>} />

              {/* Full-viewport, OUTSIDE AppLayout. An `agent` is level 5 and
                  inherits no nav, and an escape route here is a hazard: clicking
                  away drops the station socket and hangs up on a customer. */}
              <Route
                path="/station"
                element={
                  <RequireAuth>
                    <RequireCapability capability="agency">
                      <RequireFlag flag="agency_dialer_enabled">
                        {/* Full-viewport and outside both shells, so the product
                            dimension has no layout to come from — see
                            `analytics/ProductSurface`. Inside the gates, so a
                            refused reader never registers a surface. */}
                        <ProductSurface product="agency">
                          <AgentConsolePage />
                        </ProductSurface>
                      </RequireFlag>
                    </RequireCapability>
                  </RequireAuth>
                }
              />
              {/*
                `/dialer` — the agent's front door, and the URL they are given to
                bookmark. Short and memorable on purpose: it is the one address an
                agency hands to staff who never see the rest of the platform.

                Full-viewport and OUTSIDE both shells, for the reason `/station`
                is. `AppLayout`'s nav floors at `viewer` and `AgencyLayout`'s three
                entries do too, so an `agent` (level 5) renders either shell's
                chrome around nothing.

                It resolves by PERSONA rather than serving one page: a supervisor
                who opens it is asking for the dialer, and is sent to the campaigns
                workspace instead of their own (usually empty) staffing list. See
                `AgentHomePage`.

                Gated identically to `/station` — the same capability and flag, both
                default off — so this is invisible until master grants the
                capability and core enables the flag. `RequireAuth` carries the
                deep link through sign-in, which is what makes a bookmarked
                `/dialer` survive the first sign-in of the day.
              */}
              <Route
                path="/dialer"
                element={
                  <RequireAuth>
                    <RequireCapability capability="agency">
                      <RequireFlag flag="agency_dialer_enabled">
                        {/* Full-viewport and outside both shells, so the product
                            dimension has no layout to come from — see
                            `analytics/ProductSurface`. Inside the gates, so a
                            refused reader never registers a surface. */}
                        <ProductSurface product="agency">
                          <AgentHomePage />
                        </ProductSurface>
                      </RequireFlag>
                    </RequireCapability>
                  </RequireAuth>
                }
              />
              {/*
                `/dialer/performance` — the agent's own numbers.

                Beside `/dialer` rather than under `/agency`, and gated
                identically: same `RequireAuth`, same `agency` capability, same
                `agency_dialer_enabled` flag, both entitlements default off. It is
                full-viewport and OUTSIDE both shells for the reason `/dialer` is —
                an `agent` is level 5 and inherits no navigation, so `AppLayout`'s
                nav (floored at `viewer`) and `AgencyLayout`'s three entries would
                each render chrome around nothing.

                Nothing was added to `RequireCapability`'s hand-maintained union:
                `agency` is already in it, and this route needs no new capability.

                A supervisor who opens this is SERVED rather than bounced — they
                cover shifts and have their own numbers — but nothing routes them
                here. Their surface is the per-agent section on
                `AgencyAnalyticsPage`, which reads the supervisor twins of these
                same routes. See `AgentPerformancePage`.
              */}
              <Route
                path="/dialer/performance"
                element={
                  <RequireAuth>
                    <RequireCapability capability="agency">
                      <RequireFlag flag="agency_dialer_enabled">
                        {/* Full-viewport and outside both shells, so the product
                            dimension has no layout to come from — see
                            `analytics/ProductSurface`. Inside the gates, so a
                            refused reader never registers a surface. */}
                        <ProductSurface product="agency">
                          <AgentPerformancePage />
                        </ProductSurface>
                      </RequireFlag>
                    </RequireCapability>
                  </RequireAuth>
                }
              />
              {/*
                `/dialer/attempts` — "My calls": one row per dial the agent placed,
                across every campaign they have worked.

                Beside `/dialer` and `/dialer/performance` rather than under
                `/agency`, and gated identically: same `RequireAuth`, same `agency`
                capability, same `agency_dialer_enabled` flag, both entitlements
                default off. Full-viewport and OUTSIDE both shells for the reason
                the other three are — an `agent` is level 5 and inherits no
                navigation, so `AppLayout`'s nav (floored at `viewer`) and
                `AgencyLayout`'s entries would each render chrome around nothing.

                Nothing was added to `RequireCapability`'s hand-maintained union:
                `agency` is already in it, and this route needs no new capability.
                A second capability would be a second switch an operator has to
                find for a page that is part of the same product.

                This is the CROSS-campaign list, which is what makes it a separate
                surface rather than a link into `/agency/campaigns/:id/attempts`:
                that one is scoped by its URL and floored at `agency.supervise`, so
                an agent cannot read even their own rows through it. Master serves
                the pair — `my-attempts` for the caller, `agents/:userId/attempts`
                for their supervisor — and the supervisor half is read by the
                per-agent section on `AgencyAnalyticsPage`, through the same panel.

                A supervisor who opens this is SERVED rather than bounced, and
                nothing routes them here. See `AgentAttemptsPage`.
              */}
              <Route
                path="/dialer/attempts"
                element={
                  <RequireAuth>
                    <RequireCapability capability="agency">
                      <RequireFlag flag="agency_dialer_enabled">
                        {/* Full-viewport and outside both shells, so the product
                            dimension has no layout to come from — see
                            `analytics/ProductSurface`. Inside the gates, so a
                            refused reader never registers a surface. */}
                        <ProductSurface product="agency">
                          <AgentAttemptsPage />
                        </ProductSurface>
                      </RequireFlag>
                    </RequireCapability>
                  </RequireAuth>
                }
              />
              {/* The Agency workspace — its own shell, same auth tree.
                  Gated once here rather than per-route: `AgencyLayout` renders
                  nothing but agency surfaces, so a per-child gate would repeat
                  the same two checks four times and give four chances to forget
                  one. Both default off, so this is invisible until master grants
                  the capability and core enables the flag. */}
              <Route
                path="/agency"
                element={
                  <RequireAuth>
                    <RequireCapability capability="agency">
                      <RequireFlag flag="agency_dialer_enabled">
                        <AgencyLayout />
                      </RequireFlag>
                    </RequireCapability>
                  </RequireAuth>
                }
              >
                {/*
                  Persona-routed rather than a fixed redirect to the campaign
                  list: that list floors at `agency.campaigns.read` (`viewer`),
                  so an `agent` opening the dialer's own workspace used to land on
                  a 403. See `AgencyHomeRedirect`.
                */}
                <Route index element={<AgencyHomeRedirect />} />
                <Route path="campaigns" element={<AgencyCampaignsPage />} />
                <Route path="campaigns/new" element={<AgencyCampaignBuilderPage />} />
                {/*
                  MAG-166. The detail page is now three sections rather than one
                  long scroll, and each is its own URL so a section survives a
                  refresh, can be sent to a colleague and answers the back
                  button. All three mount the same component — which reads the
                  panel off the path via `campaignPanelFromPath` — because they
                  share one campaign fetch, one stats poll and one header
                  carrying the lifecycle controls.

                  `campaigns/new` is declared above and wins on rank (a static
                  segment outranks `:id`), so nothing here shadows it.
                */}
                <Route path="campaigns/:id" element={<AgencyCampaignDetailPage />} />
                <Route path="campaigns/:id/performance" element={<AgencyCampaignDetailPage />} />
                <Route path="campaigns/:id/agents" element={<AgencyCampaignDetailPage />} />
                <Route path="campaigns/:id/settings" element={<AgencyCampaignSettingsPage />} />
                {/*
                  MAG-159. `campaigns/:id/contacts` now shows the ROSTER — the
                  contacts and where each one got to. It used to render an
                  upload form whose own heading read "Add contacts", so the one
                  URL in the product that named the contacts was the one place
                  you could not see them.

                  The upload has not gone away; it moved to `…/contacts/add`,
                  reached from a button on the roster. Its component is
                  unchanged, so the ingest flow, its column mapping and its
                  rejected-rows export cannot have drifted in the move.

                  `campaigns/:id/attempts` is the other half: one row per dial,
                  including the dials that never reached an agent — which is
                  what `/app/calls/softphone/history`, being a CALL list, cannot
                  show at all.

                  No extra guard. The layout above already requires the `agency`
                  capability and the `agency_dialer_enabled` flag, and master
                  gates all three routes on `agency.supervise`.
                */}
                <Route path="campaigns/:id/contacts" element={<AgencyCampaignRosterPage />} />
                <Route path="campaigns/:id/contacts/add" element={<AgencyCampaignContactsPage />} />
                <Route path="campaigns/:id/contacts/:contactId" element={<AgencyContactDetailPage />} />
                <Route path="campaigns/:id/attempts" element={<AgencyCampaignAttemptsPage />} />
                {/*
                  The agency's own call detail — the page whose absence sent
                  attempt rows into `/app/calls/dialer/history/:id`, out of this
                  shell and onto a `calls.dialer`-gated route (design §7b).

                  No extra guard: the parent already gates the whole subtree on
                  the `agency` capability and the `agency_dialer_enabled` flag,
                  and master floors the endpoint at `agency.supervise`. React
                  Router ranks the static `attempts` segment above this dynamic
                  one, so the list route above is unaffected.

                  The page renders `CampaignTabs` itself, the same way the four
                  standalone campaign screens do — the bar is per-page, not part
                  of the layout, so a page that does not mount it has none.
                  `campaignPanelFromPath` cannot help here: it answers which
                  PANEL of the detail page a path wants, so its range is
                  `overview` | `performance` | `agents` and never `attempts`.
                */}
                <Route
                  path="campaigns/:id/attempts/:attemptId"
                  element={<AgencyAttemptCallPage />}
                />
                {/*
                  The audit trail lives HERE, in the agency workspace, and not at
                  `/app/audit-log`: a supervisor should not have to leave the
                  campaign to ask what happened to it, and that page is a
                  different shell, tenant-wide, with no campaign scoping.

                  No extra guard. The layout above already requires the `agency`
                  capability and the `agency_dialer_enabled` flag, and master
                  gates the route itself on `audit.read` — whose floor MAG-157
                  dropped to `account_admin`, the same floor as `agency.supervise`,
                  so the supervisor who controls a campaign can read its trail.
                */}
                <Route path="campaigns/:id/activity" element={<AgencyCampaignActivityPage />} />
                {/*
                  Every campaign's numbers on one screen. No extra guard: the
                  layout above already requires the `agency` capability and the
                  `agency_dialer_enabled` flag, and master gates both reads this
                  page makes — the campaign list and each `/stats` — on
                  `agency.campaigns.read`, which is also what the sidebar
                  entry checks.
                */}
                <Route path="analytics" element={<AgencyAnalyticsPage />} />
                <Route path="dnc" element={<DncPage />} />
              </Route>

              {/*
                `AgentLanding` wraps the element rather than sitting on a child
                route, so it applies to every `/app/*` path an `agent` could
                reach — including the catch-all redirect at the bottom of this
                file, which is where a bare `/` lands them.

                It is a no-op for every role that has navigation of its own, which
                is every role above level 5. That scoping is load-bearing rather
                than incidental: a revision of the component gated on the agency
                PERSONA instead, which is also true of `viewer` and `operator`, and
                redirected both out of the product entirely — into a `/dialer` whose
                capability is off by default. See the component for the predicate
                and for why an agent must never render `AppLayout` at all.
              */}
              <Route path="/app" element={<RequireAuth><AgentLanding><AppLayout /></AgentLanding></RequireAuth>}>
                <Route index element={<AppHomeRedirect />} />
                <Route path="team" element={<TeamPage />} />
                {/* Per-user notification subscriptions. No RequireCapability and no
                    permission guard: the page is about the signed-in person and master
                    takes no subject on any of its routes, so there is nobody else it
                    could expose. Gating it would lock people out of their own
                    unsubscribe. */}
                <Route path="notifications" element={<NotificationSettingsPage />} />
                <Route path="call-summaries" element={<RequireCapability capability="agency.analytics"><RequireFlag flag="agency_call_analysis"><AnalysisProfilesPage /></RequireFlag></RequireCapability>} />
              </Route>

              <Route path="*" element={<Navigate to="/app" replace />} />
            </Routes>
            </Suspense>
          </BrowserRouter>
        </GovernanceProvider>
        </FeatureFlagsProvider>
      </TenantProvider>
    </AuthProvider>
    </ToastProvider>
    </ThemeProvider>
  );
}
