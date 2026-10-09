import { brand } from './brand';

export const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

/**
 * Identifies the application initiating API calls. Sent on every request via
 * the `x-mgkvc-originator` header so the backend can attribute traffic to its
 * source (this console vs. other clients).
 *
 * Derived from the active whitelabel brand id so each brand attributes to
 * itself — `magick-agency-console` for the default brand, `acme-console` for a
 * brand pack named `acme`.
 *
 * PORT NOTE (magick-agency, decision B17): the suffix is `-console` (cusui:
 * `-customer-ui`). The value is user-visible: the campaign activity trail shows
 * it as the actor of a dialer row (`agencyActivityCopy.ts`). The header NAME is
 * wire, not branding, and is unchanged.
 */
export const ORIGINATOR_HEADER = 'x-mgkvc-originator';
export const ORIGINATOR = `${brand.id}-console`;

export const FIREBASE_CONFIG = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || '',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '',
};

export const ENDPOINTS = {
  auth: {
    session: `${API_BASE}/auth/session`,
    me: `${API_BASE}/auth/me`,
  },
  // PORT NOTE (magick-agency): `tenants.base` / `tenants.get` and `accounts.get`
  // are deleted — nothing in the console calls them (`listTenants`,
  // `updateTenant` and the account CRUD went with their pages).
  tenants: {
    members: (id: string) => `${API_BASE}/tenants/${id}/members`,
  },
  accounts: {
    base: `${API_BASE}/accounts`,
    /**
     * The accounts the CALLER is a member of. Authentication only — no
     * `account.read`, which floors at `viewer` (10) and therefore 403s the Agency
     * Dialer's `agent` role (5). It is the only way an agent can learn which
     * account to activate, and returns `{id, name, tenant_id}` and nothing else.
     */
    mine: `${API_BASE}/accounts/mine`,
  },
  /**
   * The single-use agency invite, looked up and claimed from `/agency/join/:token`.
   *
   * Both are PUBLIC and unauthenticated, which is the whole point: on the claim
   * the TOKEN is the authority rather than the address the caller signs in with,
   * so an invited agent no longer has to go through `POST /auth/session`'s
   * provision-a-tenant-for-an-unrecognised-address path to be let in. A sibling
   * of `users.invite` (which SENDS one) rather than a child of it, because
   * everything under `users` needs a session and neither of these does.
   *
   * The token is URL-encoded: it arrives from the path of a link somebody may
   * have pasted or an email client may have mangled, and a stray `?` or `#` in it
   * would otherwise silently truncate the request into a lookup of a shorter,
   * non-existent invite — which reads to the recipient as "your invitation does
   * not exist" rather than "that link is damaged".
   */
  invites: {
    get: (token: string) => `${API_BASE}/invites/${encodeURIComponent(token)}`,
    claim: (token: string) => `${API_BASE}/invites/${encodeURIComponent(token)}/claim`,
    /**
     * Re-issue an invitation — the one route in this group that is
     * AUTHENTICATED, and the only recovery from an invitation that expired.
     *
     * A literal segment rather than a token one, and it sits under the same
     * `/invites` prefix on master. Body is `{ membership_id }`: the membership is
     * what the invitation binds to, and naming it (rather than the address)
     * is what makes a resend land on the row that already exists instead of
     * colliding with it — `POST /users/invite` answers 409 for an address that is
     * already a member, which is the dead end this closes.
     */
    resend: `${API_BASE}/invites/resend`,
  },
  users: {
    invite: `${API_BASE}/users/invite`,
    role: (id: string) => `${API_BASE}/users/${id}/role`,
    membership: (id: string) => `${API_BASE}/users/${id}/membership`,
  },
  proxy: {
    // PORT NOTE (magick-agency): of cusui's `proxy.calls` block only the two
    // getters `api/calls.ts` still needs are kept (the shared call-detail
    // component's defaults; the agency attempt page overrides both). The AI
    // call, bulk, concurrency and export routes are not ported.
    calls: {
      get: (id: string) => `${API_BASE}/proxy/calls/${id}`,
      recording: (id: string) => `${API_BASE}/proxy/calls/${id}/recording`,
    },
    // Call-analysis profiles — the dialer's reusable "what we measure"
    // definition (its answer to a prompt template's analytics_config). Core
    // exposes these as `/api/v1/call-analysis-profiles/*`; reached here through
    // master's `/proxy/call-analysis-profiles` passthrough, section-gated on the
    // `calls.dialer.analytics` capability.
    callAnalysisProfiles: {
      base: `${API_BASE}/proxy/call-analysis-profiles`,
      get: (id: string) => `${API_BASE}/proxy/call-analysis-profiles/${id}`,
    },
    /**
     * Per-AGENT numbers, under master's `/proxy/agency` prefix.
     *
     * ── Why these are in the catalog and the rest of `/proxy/agency` is not ──
     * The house rule is that `ENDPOINTS` is the single source of truth for URL
     * construction. Every agency module has nevertheless been building its own
     * `${API_BASE}/proxy/agency` constant, and `agencyStats.ts` did too — five
     * routes hardcoded a few lines from a catalog that exists to stop exactly
     * that. These are the ones brought in; the rest of the agency surface is a
     * separate move and not one to make halfway through a bug fix.
     *
     * ── The pairing is the point of listing them together ───────────────────
     * Each read exists twice on master: a `my-` form floored at
     * `agency.station.connect` so a bare `agent` (level 5) can call it and scoped
     * to the caller SERVER-SIDE, and an `agents/:userId` twin floored at
     * `agency.supervise`. The `my-` form takes no subject on purpose — an optional
     * `agent_user_id` would make "whose data is this" a parameter the client
     * controls. Seeing the four side by side is what makes a fifth builder that
     * blurred them look wrong.
     *
     * `userId` is encoded: it is master's user id, opaque to this client, and a
     * path segment built by concatenation is the one that breaks quietly.
     */
    agency: {
      myStats: `${API_BASE}/proxy/agency/my-stats`,
      agentStats: (userId: string) =>
        `${API_BASE}/proxy/agency/agents/${encodeURIComponent(userId)}/stats`,
      /**
       * The ROSTER read — every agent in the account over one window, ranked,
       * with the cohort they were drawn from on the same payload.
       *
       * ── One fewer path segment than `agentStats`, deliberately ────────────
       * `agents/stats` sits beside `agents/:userId/stats` and is not a collision:
       * both services route on segment COUNT first, so a two-segment path can
       * never be read as a `:userId` of `"stats"`. The two are listed adjacently
       * so the difference is visible rather than something a reader has to
       * reconstruct — the phase-01 contract asks both backends to assert it
       * explicitly for the same reason.
       *
       * **This route takes no `agent_user_id`.** Its subject is the whole roster;
       * naming one person is what `agentStats` is for. An id-shaped filter here
       * would be a second way to ask a question that already has a route, and the
       * two answers would drift.
       */
      agentsStats: `${API_BASE}/proxy/agency/agents/stats`,
      /**
       * The GROUPED read — one general aggregate over dial attempts, cut by up to
       * two dimensions (`group_by=agent,campaign`, `day_of_week,hour_of_day`, …).
       *
       * A third sibling of `agents/stats` rather than a `group_by` parameter on
       * it: the roster payload is frozen and its rows are keyed on
       * `agent_user_id`, so a campaign- or hour-grouped row is not that shape and
       * bolting the parameter on would make one frozen payload polymorphic. Same
       * segment-count reasoning as `agentsStats` above — `agents/grouped-stats`
       * cannot be read as a `:userId` of `"grouped-stats"`.
       *
       * **Takes no `agent_user_id` either**, and for the same reason: core has no
       * user table, so only master's `memberships` can police that boundary.
       * Filtering to one person is the per-agent record's job.
       */
      agentsGroupedStats: `${API_BASE}/proxy/agency/agents/grouped-stats`,
      myAttempts: `${API_BASE}/proxy/agency/my-attempts`,
      agentAttempts: (userId: string) =>
        `${API_BASE}/proxy/agency/agents/${encodeURIComponent(userId)}/attempts`,
      /** The agent's full staffing history, ENDED assignments included. */
      myCampaigns: `${API_BASE}/proxy/agency/my-campaigns`,
      /**
       * ONE CAMPAIGN, cut by day — the supervisor twin of `myStats`' buckets.
       *
       * The only campaign-scoped route in this block, and it is here rather than
       * built from `agencyCampaigns.ts`' local `AGENCY_BASE` because it is new:
       * the rule is that `ENDPOINTS` owns URL construction, and the migration
       * note above describes the routes that predate it, not a licence for the
       * next one.
       *
       * Floored at `agency.supervise`, matching every other campaign-scoped
       * supervisor read and matching the two sections the charts live on. There
       * is deliberately NO `my-` twin: an agent has no campaign-wide view, and
       * the pair only exists where the same question has two subjects.
       *
       * `campaignId` is encoded for the same reason `userId` is above.
       */
      campaignStatsSeries: (campaignId: string) =>
        `${API_BASE}/proxy/agency/campaigns/${encodeURIComponent(campaignId)}/stats/series`,
    },
  },
  /**
   * PORT NOTE (magick-agency): cusui read the client flag map at
   * `/proxy/feature-flags` (master proxying core). Agency serves the map itself,
   * at `GET /feature-flags` (lane A, permission `agency.flags.read`, floor
   * `agent`), so this is the one console path that changed.
   */
  featureFlags: `${API_BASE}/feature-flags`,
  // PORT NOTE (magick-agency): `governance.effective` is not ported — per-account
  // settings ride the session payload (extraction plan §3.2).
  // Do Not Call — master-native (NOT proxied), a master-native route in MagickVoice. Master
  // owns `dnc_entries`; core receives only a derived, tenant-flat Redis set for
  // its dial-time check, so there is no core route behind these.
  dnc: {
    base: `${API_BASE}/dnc`,
    get: (id: string) => `${API_BASE}/dnc/${id}`,
  },
  /**
   * Per-user notification subscriptions — master-native, like `governance` and
   * `dnc` above rather than a `/proxy/*` route.
   *
   * Every route is about the CALLER and takes no subject: master reads the user
   * from the session and there is no `user_id` parameter to pass, which is what
   * stops "my settings" becoming a surface that could read or rewrite a
   * colleague's. Authenticated but with NO permission floor — a `viewer`
   * manages their own subscriptions exactly as a `tenant_owner` does, and
   * gating on any existing permission would lock somebody out of their own
   * unsubscribe.
   */
  notifications: {
    preferences: `${API_BASE}/notifications/preferences`,
  },
  /**
   * PORT NOTE (magick-agency): only `base` (the caller's own numbers, read by
   * the campaign builder's caller-ID picker) is kept; tagging and inbound
   * configuration are AI-platform surfaces.
   */
  phoneNumbers: {
    base: `${API_BASE}/phone-numbers`,
  },
} as const;

// PORT NOTE (magick-agency): cusui's `LANGUAGES`, `TtsVoice`,
// `TtsLanguageOption`, `TTS_LANGUAGES`, `TTS_DEFAULT_LANGUAGE` and
// `TTS_DEFAULT_VOICE` (AI call languages and text-to-speech) are not ported.

export const ROLES = [
  { value: 'tenant_owner', label: 'Owner', color: 'var(--accent)' },
  { value: 'tenant_admin', label: 'Admin', color: 'var(--info)' },
  { value: 'account_admin', label: 'Account Admin', color: 'var(--teal)' },
  { value: 'operator', label: 'Operator', color: 'var(--warning)' },
  { value: 'viewer', label: 'Viewer', color: 'var(--text-muted)' },
  // Agency Dialer role. This entry is what makes an existing `agent` membership
  // render as "Agent" rather than leaking the raw role string — and the role is
  // now **assignable** too: both of `TeamPage`'s pickers offer it (`MAG-160`).
  // It was display metadata only while an `agent` had no way into the product
  // but a pasted `/station?campaign=` URL; that reason is spent now they land on
  // their assigned station at sign-in.
  { value: 'agent', label: 'Agent', color: 'var(--text-muted)' },
] as const;

/*
 * PORT NOTE (magick-agency, decision B17): cusui's `DOCS_BASE_URL`,
 * `DOCS_SLUGS`, `DocsSlug` and `docsUrl` are deleted. They built the page
 * guide's "Read the full guide" link to the parent product's documentation
 * site; Magick Agency has no docs site, so the link is removed rather than left
 * pointing somewhere else.
 */
