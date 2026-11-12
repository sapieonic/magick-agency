import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { TenantProvider } from './contexts/TenantContext';
import { FeatureFlagsProvider } from './contexts/FeatureFlagsContext';
import { GovernanceProvider } from './contexts/GovernanceContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { UrlScopeProvider } from './contexts/UrlScopeContext';
import { ToastProvider } from '@magick-agency/web-ui/contexts/ToastContext';
import RequireAuth from './components/auth/RequireAuth';
import RequireCapability from './components/auth/RequireCapability';
import RequireFlag from './components/auth/RequireFlag';
import RequireGate from './components/auth/RequireGate';
import HomeRedirect from './components/auth/HomeRedirect';
import { ProductSurface } from './analytics/ProductSurface';
import { ConsoleShell } from './components/layout/ConsoleShell';
import { AgencyArea } from './components/layout/AgencyArea';
import { SectionLanding } from './components/layout/SectionLanding';
import { ScopedRouter } from './components/routing/ScopedRouter';
import { ScopeGate } from './components/routing/ScopeGate';
import { settingsEntry } from './utils/consoleNav';

/*
 * Route table. Contents: the agency doors (`/agency/login`,
 * `/agency/join/:token`), the workspace invite page (`/join/:token`), the root
 * `HomeRedirect`, the full-viewport agent routes (`/station`, `/dialer/*`), and the
 * console shell (`ConsoleShell`, decision B28) around the `/agency` work pages, the
 * `/settings` hub and the legacy `/app` URLs, which redirect into it. Notes:
 *  - `/login` renders `AgencyLoginPage`. There is no marketing page, sign-up
 *    tab or `/onboarding`: agency has no self-serve sign-up (session path 4 is
 *    refused, plan).
 *  - `/app`'s index is `AppHomeRedirect`; every other `/app/<page>` is
 *    `LegacyAppRedirect`, to `/settings/<page>` (or "page not found" for a path
 *    that never was one).
 *  - `/settings/call-summaries` is gated on agency's `agency.analytics` capability and
 *    `agency_call_analysis` flag.
 *  - Providers: `GovernanceProvider` derives from the session's settings map.
 *    There is no metadata provider, and the super-admin console is its own app.
 * Any other path (calls, prompts, IVR, automations, broadcasts, messaging, SIP,
 * escalation, knowledge, schedules, contact lists, accounts, credits, API keys,
 * audit log, tenant settings, phone numbers) is out of scope: it, and any path
 * under `/agency` or `/settings` that is no page, renders `NotFoundPage` inside
 * the console shell, which says so and offers the way home.
 *
 * ── Every signed-in page is scoped: `/t/:tenantId/a/:accountId/…` ───────────
 * So a link copied from the address bar opens the same tenant and account for
 * whoever it is sent to. The paths below are written WITHOUT that prefix: it is
 * the router's basename (`ScopedRouter`), so `/agency/campaigns` here is served
 * at `/t/<tenant>/a/<account>/agency/campaigns`, and every `<Link>` and
 * `navigate()` in the app stays inside the scope it was clicked in. `ScopeGate`,
 * the layout route around everything below the public pages, moves an unscoped
 * URL (an old `/dialer` bookmark) under the active account's prefix and refuses a
 * link to a tenant or account the viewer cannot open. The sign-in, invite and
 * verification pages stay unscoped (`utils/urlScope`). See `TenantContext` for how
 * the URL and the active tenant/account stay in step.
 */

const AppHomeRedirect = lazy(() => import('./pages/AppHomeRedirect'));
const AgencyLoginPage = lazy(() => import('./pages/agency/AgencyLoginPage'));
const AgencyJoinPage = lazy(() => import('./pages/agency/AgencyJoinPage'));
const JoinPage = lazy(() => import('./pages/auth/JoinPage'));
const VerifyEmailPage = lazy(() => import('./pages/auth/VerifyEmailPage'));
const AgentConsolePage = lazy(() => import('./pages/agency/AgentConsolePage'));
const TeamPage = lazy(() => import('./pages/team/TeamPage'));
const AccountsPage = lazy(() => import('./pages/accounts/AccountsPage'));
const NotificationSettingsPage = lazy(() => import('./pages/settings/NotificationSettingsPage'));
const AnalysisProfilesPage = lazy(() => import('./pages/settings/AnalysisProfilesPage'));
const AgencyCampaignBuilderPage = lazy(() => import('./pages/campaigns/agency/CampaignBuilderPage'));
const AgencyCampaignsPage = lazy(() => import('./pages/agency/AgencyCampaignsPage'));
const AgencyAnalyticsPage = lazy(() => import('./pages/agency/AgencyAnalyticsPage'));
const AgentHomePage = lazy(() => import('./pages/agency/AgentHomePage'));
const AgentPerformancePage = lazy(() => import('./pages/agency/AgentPerformancePage'));
const AgentAttemptsPage = lazy(() => import('./pages/agency/AgentAttemptsPage'));
const SoftphonePage = lazy(() => import('./pages/agency/SoftphonePage'));
const AgencyHomeRedirect = lazy(() => import('./pages/agency/AgencyHomeRedirect'));
const HomePage = lazy(() => import('./pages/agency/HomePage'));
const AgencyCampaignDetailPage = lazy(() => import('./pages/agency/AgencyCampaignDetailPage'));
const CampaignLandingRedirect = lazy(() => import('./pages/agency/campaign-detail/CampaignLandingRedirect'));
const DncPage = lazy(() => import('./pages/agency/DncPage'));
const AgencyCampaignSettingsPage = lazy(() => import('./pages/agency/AgencyCampaignSettingsPage'));
const AgencyCampaignContactsPage = lazy(() => import('./pages/agency/AgencyCampaignContactsPage'));
const AgencyCampaignRosterPage = lazy(() => import('./pages/agency/AgencyCampaignRosterPage'));
const AgencyCampaignAttemptsPage = lazy(() => import('./pages/agency/AgencyCampaignAttemptsPage'));
const AgencyAttemptCallPage = lazy(() => import('./pages/agency/AgencyAttemptCallPage'));
const AgencyContactDetailPage = lazy(() => import('./pages/agency/AgencyContactDetailPage'));
const AgencyCampaignActivityPage = lazy(() => import('./pages/agency/AgencyCampaignActivityPage'));
const AgencyCampaignManualCallsPage = lazy(() => import('./pages/agency/AgencyCampaignManualCallsPage'));
const SoftphoneCallsPage = lazy(() => import('./pages/agency/softphone/SoftphoneCallsPage'));
const SoftphoneCallDetailPage = lazy(() => import('./pages/agency/softphone/SoftphoneCallDetailPage'));
const SoftphoneSettingsPage = lazy(() => import('./pages/settings/SoftphoneSettingsPage'));
const CustomerHistoryPage = lazy(() => import('./pages/agency/CustomerHistoryPage'));
const AgentCustomerHistoryPage = lazy(() =>
  import('./pages/agency/CustomerHistoryPage').then((m) => ({ default: m.AgentCustomerHistoryPage })),
);
const ReportsPage = lazy(() => import('./pages/agency/ReportsPage'));
const ReportRunPage = lazy(() => import('./pages/agency/ReportRunPage'));
const AgentReportsPage = lazy(() =>
  import('./pages/agency/ReportsPage').then((m) => ({ default: m.AgentReportsPage })),
);
const AgentReportRunPage = lazy(() =>
  import('./pages/agency/ReportRunPage').then((m) => ({ default: m.AgentReportRunPage })),
);
const MissedCallsPage = lazy(() => import('./pages/agency/MissedCallsPage'));
const AgentMissedCallsPage = lazy(() =>
  import('./pages/agency/MissedCallsPage').then((m) => ({ default: m.AgentMissedCallsPage })),
);
const InboundSummaryPage = lazy(() => import('./pages/agency/InboundSummaryPage'));
const InboundRoutesPage = lazy(() => import('./pages/settings/InboundRoutesPage'));
const InboundRouteEditorPage = lazy(() => import('./pages/settings/InboundRouteEditorPage'));
const SettingsLayout = lazy(() => import('./pages/settings/SettingsLayout'));
const SettingsIndexRedirect = lazy(() => import('./pages/settings/SettingsIndexRedirect'));
const ProfileSettingsPage = lazy(() => import('./pages/settings/ProfileSettingsPage'));
const LegacyAppRedirect = lazy(() => import('./pages/LegacyAppRedirect'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

export default function App() {
  return (
    <ThemeProvider>
    <ToastProvider>
    <AuthProvider>
      <UrlScopeProvider>
      <TenantProvider>
        <FeatureFlagsProvider>
        <GovernanceProvider>
          <ScopedRouter>
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
                Not a second auth tree. Agency staff are ordinary users
                with tenant memberships, and this page calls the same
                `signInEmail`/`signInGoogle` as `LoginPage` and produces the same
                session; super-admin's separate JWT is the pattern this
                deliberately does NOT follow. What differs is the signup (there
                is none, because `POST /auth/session` provisions a tenant for an
                address the server does not recognise), the pitch, and the landing —
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
                the server enforces it: `POST /invites/:token/claim` reads the token,
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
                    Outside the console shell, like `/station` and `/dialer`, so the
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
              {/*
                Where every OTHER emailed invite lands — an operator, a viewer, an
                account admin: any role but `agent`, whose link is the route above.

                ── Fully public, for exactly the reasons the route above gives ──
                No `RequireAuth`, no `RequireCapability`, no `RequireFlag`. The
                visitor has no account yet, so `RequireAuth` would bounce them to
                `/login` and throw the token away; and there is no session or tenant
                for a capability or a flag to be resolved against. The single-use
                token is the authority and the server enforces it on
                `POST /invites/:token/claim` — the same endpoint, the same claim,
                shared code (`components/agency/join/useInviteClaim`). An invite
                whose role belongs on the other route is forwarded there by either
                page, so neither URL can strand anybody.

                ── Beside the agency join page, and NOT under `/agency` ─────────
                It is not an agency surface: a workspace invitee may be joining a
                tenant with no dialer at all, so `/agency/...` would be a URL that
                misdescribes itself and would send anyone bounced off it to the
                agency door (`loginPathFor`). At the top level it is outside every
                shell for the same reason the route above is.

                ── No `ProductSurface`, unlike the route above ──────────────────
                That wrapper exists so the agency funnel's events carry
                `product: 'agency'` with no shell to set it. This page's events are
                the `workspace_invite_*` family, whose names already say which door
                they came through, and it belongs to no product the way `/login`
                belongs to none: a stale `product` on it would be a claim about a
                shell the visitor has not reached yet. `productSurface.test.tsx`
                counts the wrapped routes, so adding one here is a deliberate edit
                there rather than a quiet one.
              */}
              <Route path="/join/:token" element={<JoinPage />} />
              <Route path="/verify-email" element={<VerifyEmailPage />} />

              {/*
                Everything below needs a sign-in and is served under the
                tenant/account prefix. `ScopeGate` is pathless, so it adds no
                segment of its own; see it for when it waits, re-points the URL or
                refuses a link.
              */}
              <Route element={<ScopeGate />}>
                {/*
                  The app root, routed on ENTITLEMENT: `/agency` with the dialer on,
                  `/app` otherwise (see `HomeRedirect`). Wrapped in `RequireAuth` so a
                  signed-out visitor typing the bare domain gets `?next=/` and comes
                  back through this decision after signing in. An unrecognised URL is
                  not somebody asking to be taken home: the shell's catch-all says the
                  page is not found.
                */}
                <Route path="/" element={<RequireAuth><HomeRedirect /></RequireAuth>} />

                {/* Full-viewport, OUTSIDE the console shell. An `agent` is level 5 and
                    inherits no nav, and an escape route here is a hazard: clicking
                    away drops the station socket and hangs up on a customer. */}
                <Route
                  path="/station"
                  element={
                    <RequireAuth>
                      <RequireCapability capability="agency">
                        <RequireFlag flag="agency_dialer_enabled">
                          {/* Full-viewport and outside the console shell, so the product
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

                  Full-viewport and OUTSIDE the console shell, for the reason `/station`
                  is. The console shell's nav floors at `viewer`, so an `agent`
                  (level 5) would render its chrome around nothing.

                  It resolves by PERSONA rather than serving one page: a supervisor
                  who opens it is asking for the dialer, and is sent to the campaigns
                  workspace instead of their own (usually empty) staffing list. See
                  `AgentHomePage`.

                  Gated identically to `/station` — the same capability and flag, both
                  default off — so this is invisible until the server grants the
                  capability and the server enables the flag. `RequireAuth` carries the
                  deep link through sign-in, which is what makes a bookmarked
                  `/dialer` survive the first sign-in of the day.
                */}
                <Route
                  path="/dialer"
                  element={
                    <RequireAuth>
                      <RequireCapability capability="agency">
                        <RequireFlag flag="agency_dialer_enabled">
                          {/* Full-viewport and outside the console shell, so the product
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
                  full-viewport and OUTSIDE the console shell for the reason `/dialer` is —
                  an `agent` is level 5 and inherits no navigation, so the console
                  shell's nav (floored at `viewer`) would render chrome around nothing.

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
                          {/* Full-viewport and outside the console shell, so the product
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
                  default off. Full-viewport and OUTSIDE the console shell for the reason
                  the other three are — an `agent` is level 5 and inherits no
                  navigation, so the console shell's nav (floored at `viewer`) would
                  render chrome around nothing.

                  Nothing was added to `RequireCapability`'s hand-maintained union:
                  `agency` is already in it, and this route needs no new capability.
                  A second capability would be a second switch an operator has to
                  find for a page that is part of the same product.

                  This is the CROSS-campaign list, which is what makes it a separate
                  surface rather than a link into `/agency/campaigns/:id/attempts`:
                  that one is scoped by its URL and floored at `agency.supervise`, so
                  an agent cannot read even their own rows through it. The server serves
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
                          {/* Full-viewport and outside the console shell, so the product
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
                {/*
                  `/dialer/phone` — the soft phone (`docs/softphone.md` §7): an agent
                  dials a typed number from the browser, outside campaign pacing.

                  Full-viewport and OUTSIDE the console shell for the reason `/station` is —
                  navigating away mid-call drops the socket and cuts the customer off —
                  and gated identically. `agency_softphone_enabled` (default off, SP4)
                  is the PAGE's to read, not a `RequireFlag` here: turned off while an
                  agent is on a call, a route gate would take the call (and the outcome
                  it owes) off their screen, so the page rehydrates an existing
                  soft-phone session into finish mode and is `CapabilityUnavailable`
                  otherwise, exactly as the gate was. The permission,
                  `agency.softphone.dial`, floors at `agent`, so the page checks it
                  itself rather than through a capability.
                */}
                <Route
                  path="/dialer/phone"
                  element={
                    <RequireAuth>
                      <RequireCapability capability="agency">
                        <RequireFlag flag="agency_dialer_enabled">
                          {/* Full-viewport and outside the console shell, so the product
                              dimension has no layout to come from — see
                              `analytics/ProductSurface`. Inside the gates, so a
                              refused reader never registers a surface. */}
                          <ProductSurface product="agency">
                            <SoftphonePage />
                          </ProductSurface>
                        </RequireFlag>
                      </RequireCapability>
                    </RequireAuth>
                  }
                />
                {/*
                  `/dialer/reports` and `/dialer/reports/:runId` — a dedicated agent's
                  own exported reviews (`docs/reports.md`, RP5). The same pages as
                  `/agency/reports*`, in the agent's own frame, because the console
                  shell renders nothing for an agent; the agency paths send a
                  dedicated agent here (the "report ready" email links to those).
                  Gated as their siblings are, plus the `agency_reports_enabled` flag.
                */}
                <Route
                  path="/dialer/reports"
                  element={
                    <RequireAuth>
                      <RequireCapability capability="agency">
                        <RequireFlag flag="agency_dialer_enabled">
                          <RequireFlag flag="agency_reports_enabled">
                            <ProductSurface product="agency">
                              <AgentReportsPage />
                            </ProductSurface>
                          </RequireFlag>
                        </RequireFlag>
                      </RequireCapability>
                    </RequireAuth>
                  }
                />
                <Route
                  path="/dialer/reports/:runId"
                  element={
                    <RequireAuth>
                      <RequireCapability capability="agency">
                        <RequireFlag flag="agency_dialer_enabled">
                          <RequireFlag flag="agency_reports_enabled">
                            <ProductSurface product="agency">
                              <AgentReportRunPage />
                            </ProductSurface>
                          </RequireFlag>
                        </RequireFlag>
                      </RequireCapability>
                    </RequireAuth>
                  }
                />
                {/*
                  `/dialer/customers` — customer history for an agent
                  (`docs/customer-history.md` §5): every agent may search a number
                  (CH1), and the console shell, whose top bar carries the box, renders
                  nothing for an agent. The same page as `/agency/customers`, in the
                  agent's own frame (`AgentSurfaceShell`). Gated as its siblings are;
                  the page checks `agency.customer_history.read` itself. The URL never
                  carries the number (CH6): the search id travels in history state.
                */}
                <Route
                  path="/dialer/customers"
                  element={
                    <RequireAuth>
                      <RequireCapability capability="agency">
                        <RequireFlag flag="agency_dialer_enabled">
                          {/* Full-viewport and outside the console shell, so the product
                              dimension has no layout to come from — see
                              `analytics/ProductSurface`. */}
                          <ProductSurface product="agency">
                            <AgentCustomerHistoryPage />
                          </ProductSurface>
                        </RequireFlag>
                      </RequireCapability>
                    </RequireAuth>
                  }
                />
                {/*
                  `/dialer/missed` — a dedicated agent's Missed calls (`docs/inbound.md` §7):
                  the inbound calls left to them, with Call back and Mark handled. The same
                  page as `/agency/inbound/missed`, in the agent's own frame. Gated as its
                  siblings; the page reads `agency_inbound_enabled` and
                  `agency.inbound.read` itself and is unavailable without either.
                */}
                <Route
                  path="/dialer/missed"
                  element={
                    <RequireAuth>
                      <RequireCapability capability="agency">
                        <RequireFlag flag="agency_dialer_enabled">
                          <ProductSurface product="agency">
                            <AgentMissedCallsPage />
                          </ProductSurface>
                        </RequireFlag>
                      </RequireCapability>
                    </RequireAuth>
                  }
                />
                {/*
                  The console shell (decision B28): one layout, one sidebar and one top
                  bar around every signed-in page that is not an agent's full-viewport
                  surface. `ConsoleShell` keeps a DEDICATED agent out of it on Settings
                  and `/app` (`AgentLanding`, as the old `/app` shell did); the `/agency`
                  pages send an agent to their own `/dialer/*` twins themselves.
                */}
                <Route element={<RequireAuth><ConsoleShell /></RequireAuth>}>
                {/* The work pages. Gated once here rather than per route: every page
                    below is an agency surface, so a per-child gate would repeat the same
                    two checks and give each a chance to be forgotten. Both default off.
                    `AgencyArea` adds a section's tab bar above a grouped page. */}
                <Route
                  path="/agency"
                  element={
                    <RequireCapability capability="agency">
                      <RequireFlag flag="agency_dialer_enabled">
                        <AgencyArea />
                      </RequireFlag>
                    </RequireCapability>
                  }
                >
                  {/*
                    Persona-routed rather than a fixed redirect to the campaign
                    list: that list floors at `agency.campaigns.read` (`viewer`),
                    so an `agent` opening the dialer's own workspace used to land on
                    a 403. See `AgencyHomeRedirect`.
                  */}
                  <Route index element={<AgencyHomeRedirect />} />
                  {/*
                    Home (B28): what needs a supervisor now, the floor and today so far.
                    `agency.supervise`, which the page checks (`HOME_GATE`); anyone else is
                    sent back to the index, which picks their landing.
                  */}
                  <Route path="home" element={<HomePage />} />
                  <Route path="campaigns" element={<AgencyCampaignsPage />} />
                  <Route path="campaigns/new" element={<AgencyCampaignBuilderPage />} />
                  {/*
                    The detail page's five panels (Overview, Calls, Agents,
                    Callbacks, Health), each its own URL so a section survives a
                    refresh, can be sent to a colleague and answers the back
                    button. All mount the same component —
                    which reads the panel off the path via `campaignPanelFromPath` —
                    because they share one campaign fetch, one stats poll and one
                    header carrying the lifecycle controls.

                    Insights replaced Overview and Performance (decision IN1), and was
                    then split into Overview, Calls, Callbacks and Health beside
                    Agents (IN13). The retired URLs, the bare campaign path,
                    `…/performance` and `…/insights`, redirect: to Overview for a
                    supervisor, to Agents for a role that cannot read it
                    (`CampaignLandingRedirect`), so no old link lands on a tab that
                    403s.

                    `campaigns/new` is declared above and wins on rank (a static
                    segment outranks `:id`), so nothing here shadows it.
                  */}
                  <Route path="campaigns/:id" element={<CampaignLandingRedirect />} />
                  <Route path="campaigns/:id/performance" element={<CampaignLandingRedirect />} />
                  <Route path="campaigns/:id/insights" element={<CampaignLandingRedirect />} />
                  <Route path="campaigns/:id/overview" element={<AgencyCampaignDetailPage />} />
                  <Route path="campaigns/:id/calls" element={<AgencyCampaignDetailPage />} />
                  <Route path="campaigns/:id/agents" element={<AgencyCampaignDetailPage />} />
                  <Route path="campaigns/:id/callbacks" element={<AgencyCampaignDetailPage />} />
                  <Route path="campaigns/:id/health" element={<AgencyCampaignDetailPage />} />
                  <Route path="campaigns/:id/settings" element={<AgencyCampaignSettingsPage />} />
                  {/*
                    `campaigns/:id/contacts` now shows the ROSTER — the
                    contacts and where each one got to. It used to render an
                    upload form whose own heading read "Add contacts", so the one
                    URL in the product that named the contacts was the one place
                    you could not see them.

                    The upload has not gone away; it moved to `…/contacts/add`,
                    reached from a button on the roster. Its component is
                    unchanged, so the ingest flow, its column mapping and its
                    rejected-rows export cannot have drifted in the move.

                    `campaigns/:id/attempts` is the other half: one row per dial,
                    including the dials that never reached an agent — which a CALL
                    list cannot show at all.

                    No extra guard. The layout above already requires the `agency`
                    capability and the `agency_dialer_enabled` flag, and the server
                    gates all three routes on `agency.supervise`.
                  */}
                  <Route path="campaigns/:id/contacts" element={<AgencyCampaignRosterPage />} />
                  <Route path="campaigns/:id/contacts/add" element={<AgencyCampaignContactsPage />} />
                  <Route path="campaigns/:id/contacts/:contactId" element={<AgencyContactDetailPage />} />
                  <Route path="campaigns/:id/attempts" element={<AgencyCampaignAttemptsPage />} />
                  {/*
                    The agency's own call detail — the page whose absence sent
                    attempt rows into `/app/calls/dialer/history/:id`, out of this
                    shell and onto a `calls.dialer`-gated route (design).

                    No extra guard: the parent already gates the whole subtree on
                    the `agency` capability and the `agency_dialer_enabled` flag,
                    and the server floors the endpoint at `agency.supervise`. React
                    Router ranks the static `attempts` segment above this dynamic
                    one, so the list route above is unaffected.

                    The page renders `CampaignTabs` itself, the same way the four
                    standalone campaign screens do — the bar is per-page, not part
                    of the layout, so a page that does not mount it has none.
                    `campaignPanelFromPath` cannot help here: it answers which
                    PANEL of the detail page a path wants, so its range is the
                    detail page's own tabs and never `attempts`.
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
                    capability and the `agency_dialer_enabled` flag, and the server
                    gates the route itself on `audit.read` — whose floor
                    is `account_admin`, the same floor as `agency.supervise`,
                    so the supervisor who controls a campaign can read its trail.
                  */}
                  <Route path="campaigns/:id/activity" element={<AgencyCampaignActivityPage />} />
                  {/*
                    Every campaign's numbers on one screen. No extra guard: the
                    layout above already requires the `agency` capability and the
                    `agency_dialer_enabled` flag, and the server gates both reads this
                    page makes — the campaign list and each `/stats` — on
                    `agency.campaigns.read`, which is also what the sidebar
                    entry checks.
                  */}
                  <Route path="analytics" element={<AgencyAnalyticsPage />} />
                  <Route path="dnc" element={<DncPage />} />
                  {/*
                    Customer history (`docs/customer-history.md`): one number, every
                    interaction with it. No number in the URL (CH6): the search box
                    navigates here with only the search id in history state. The page
                    checks `agency.customer_history.read`; the server enforces it.
                  */}
                  <Route path="customers" element={<CustomerHistoryPage />} />
                  {/*
                    Reports (`docs/reports.md`): the history and subscriptions, and one
                    run (the "report ready" email's link). Behind the
                    `agency_reports_enabled` flag on top of the shell's dialer gate.
                  */}
                  <Route
                    path="reports"
                    element={<RequireFlag flag="agency_reports_enabled"><ReportsPage /></RequireFlag>}
                  />
                  <Route
                    path="reports/:runId"
                    element={<RequireFlag flag="agency_reports_enabled"><ReportRunPage /></RequireFlag>}
                  />
                  {/*
                    The soft phone's supervisor surfaces (`docs/softphone.md` §7):
                    the account's soft-phone calls, one call's detail, and a
                    campaign's Manual calls — each behind `agency_softphone_enabled`
                    on top of the subtree's gates. The server floors the
                    account-wide reads at `agency.supervise`, as the sidebar entry
                    and the campaign tab do.
                  */}
                  <Route
                    path="softphone"
                    element={<RequireFlag flag="agency_softphone_enabled"><SoftphoneCallsPage /></RequireFlag>}
                  />
                  <Route
                    path="softphone/calls/:callId"
                    element={<RequireFlag flag="agency_softphone_enabled"><SoftphoneCallDetailPage /></RequireFlag>}
                  />
                  <Route
                    path="campaigns/:id/manual-calls"
                    element={<RequireFlag flag="agency_softphone_enabled"><AgencyCampaignManualCallsPage /></RequireFlag>}
                  />
                  {/* Missed inbound calls (`docs/inbound.md` §7): the account's for a supervisor,
                      the caller's own otherwise (the server's rule). Not behind `agency_inbound_enabled`
                      here: with it off the page stays readable while there are rows (the kill switch
                      stops calls, not their follow-up) and decides that itself. */}
                  <Route path="inbound/missed" element={<MissedCallsPage />} />
                  {/* The inbound summary (`docs/inbound.md` §11): supervisors; the page gates itself
                      as the Missed list does. */}
                  <Route path="inbound/summary" element={<InboundSummaryPage />} />
                  {/* A section's root that is no page of its own opens its first tab the
                      reader may open, as the sidebar's entry does. */}
                  <Route path="inbound" element={<SectionLanding />} />
                  {/* No page here: said inside the shell, under the subtree's gates. */}
                  <Route path="*" element={<NotFoundPage />} />
                </Route>

                {/*
                  The Settings hub (decision B28), grouped by who a setting affects.
                  Every entry keeps the guards its `/app` route had, read from its
                  `SETTINGS_ENTRIES` gate (`RequireGate`: the capabilities and flags).
                */}
                <Route path="/settings" element={<SettingsLayout />}>
                  <Route index element={<SettingsIndexRedirect />} />
                  {/* About the signed-in person only: nothing to gate. */}
                  <Route path="profile" element={<ProfileSettingsPage />} />
                  {/* Per-user email subscriptions. No RequireCapability and no permission
                      guard: the page is about the signed-in person and the server takes no
                      subject on any of its routes, so there is nobody else it could expose.
                      Gating it would lock people out of their own unsubscribe. */}
                  <Route path="notifications" element={<NotificationSettingsPage />} />
                  {/* Soft phone: read at the dial floor, edited with `agency.softphone.manage`. */}
                  <Route path="softphone" element={<RequireGate gate={settingsEntry('softphone').gate}><SoftphoneSettingsPage /></RequireGate>} />
                  {/* Inbound routing (`docs/inbound.md` §8.1): the account's routes. Account
                      admins (`agency.inbound.write`, which the pages check) behind `agency_inbound_enabled`. */}
                  <Route path="inbound" element={<RequireGate gate={settingsEntry('inbound').gate}><InboundRoutesPage /></RequireGate>} />
                  <Route path="inbound/new" element={<RequireGate gate={settingsEntry('inbound').gate}><InboundRouteEditorPage /></RequireGate>} />
                  <Route path="inbound/:routeId" element={<RequireGate gate={settingsEntry('inbound').gate}><InboundRouteEditorPage /></RequireGate>} />
                  <Route path="call-summaries" element={<RequireGate gate={settingsEntry('call-summaries').gate}><AnalysisProfilesPage /></RequireGate>} />
                  <Route path="team" element={<TeamPage />} />
                  {/* The tenant's accounts. Linked for `account.create` only; the route itself
                      is ungated (the list is `account.read`, which the server enforces), and
                      the page offers "New account" only to a tenant-wide `account.create` seat,
                      as the server requires. */}
                  <Route path="accounts" element={<AccountsPage />} />
                  {/* A mistyped Settings URL: not found, inside the hub, its sub-nav beside it. */}
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
                {/*
                  `/app`: the console's home decision (`AppHomeRedirect`), kept at the URL
                  the workspace invite and the session expiry land on. Its old pages moved to
                  `/settings` and redirect there (`LegacyAppRedirect`, with `replace`, keeping
                  the rest of the path, e.g. `/app/inbound/:routeId`).
                */}
                <Route path="/app">
                  <Route index element={<AppHomeRedirect />} />
                  <Route path="*" element={<LegacyAppRedirect />} />
                </Route>
                {/*
                  Any other signed-in URL is no page here: said inside the shell, with the
                  way home, rather than a silent redirect. A signed-out visitor meets
                  `RequireAuth` first; a dedicated agent, `AgentLanding` (to the dialer).
                */}
                <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Route>
            </Routes>
            </Suspense>
          </ScopedRouter>
        </GovernanceProvider>
        </FeatureFlagsProvider>
      </TenantProvider>
      </UrlScopeProvider>
    </AuthProvider>
    </ToastProvider>
    </ThemeProvider>
  );
}
