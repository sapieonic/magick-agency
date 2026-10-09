/**
 * The post-sign-in destination, carried through either sign-in page as `?next=`,
 * and the rule deciding which of the two a given destination belongs to.
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 * `RequireAuth` used to redirect an unauthenticated visitor to `/login` and throw
 * the URL they asked for away; `LoginPage` then navigated unconditionally to
 * `/app`. So every deep link into the product survived only for someone already
 * signed in. That is what makes a shareable entry point like `/dialer` — the whole
 * point of which is "give an agent one URL to bookmark" — land them somewhere else
 * on the one morning it matters, their first sign-in of the day.
 *
 * ── Why a query param and not router state ──────────────────────────────────
 * `<Navigate state>` would be tidier and does not survive the thing that actually
 * happens here: sign-in can bounce through `/verify-email` or `/onboarding`, and an
 * agent handed a link opens it in a fresh tab, pastes it, or reloads. A param is in
 * the URL, so it survives all of that. It is also attacker-reachable, which is what
 * the canonicalisation below is for.
 */
export const RETURN_PATH_PARAM = 'next';

/** The generic sign-in path (see `App.tsx` for what it renders). */
export const LOGIN_PATH = '/login';

/**
 * The Agency Dialer's own sign-in page.
 *
 * ── Why a second door rather than a second auth tree ───────────────────────
 * Agency staff are ordinary the API users: an `agent` or a supervisor is a
 * membership row with an RBAC role, and every agency route authorizes on that
 * membership through the API's `tenantContextMiddleware`. So this is one identity
 * system with two entrances, NOT the parallel tree super-admin has (its own JWT
 * in `sessionStorage`, its own `saFetch`, its own middleware). A second credential
 * store would have to duplicate the memberships and would break the inheritance
 * that lets a supervisor cover a shift on a station — see `agencyPersona`.
 *
 * What the second door is actually for is the two things `/login` gets wrong for
 * somebody whose whole job is the dialer:
 *
 *  1. **The Sign Up tab, which is a live hazard rather than a wrong tone.**
 *     `POST /auth/session` provisions a brand-new tenant for an email it does not
 *     recognise (session path 4). An invited
 *     agent's membership is activated by matching the address they sign in with
 *     against the stub row the API wrote for them, so an agent who reaches for
 *     "Sign Up" instead of "Sign In" — or who signs up with a slightly different
 *     address — silently lands in a private empty tenant of their own while the
 *     membership their supervisor created sits unclaimed. The agency door has no
 *     signup on it at all.
 *  2. **The pitch.** A generic sign-in page is written for prospects. An agent
 *     being onboarded onto a dialer is staff, not a prospect.
 */
export const AGENCY_LOGIN_PATH = '/agency/login';

/**
 * Where an emailed agency invite lands: `/agency/join/:token`.
 *
 * ── A third public credential surface, and NOT a third door ────────────────
 * {@link AGENCY_LOGIN_PATH} closes the signup hazard by removing signup, which
 * leaves an invited agent who has no Google account with no way in at all. This
 * path is that missing way in, and it is deliberately not a sign-in page: the
 * visitor has no credential yet, and what authorizes them is the single-use token
 * in the URL rather than anything they type. The API's claim endpoint reads the
 * TOKEN, so the address they end up signing in with no longer has to match the
 * address the invite was sent to — which is exactly the match that was failing
 * silently and stranding people in tenants of their own.
 *
 * Exported as the PREFIX, without the `:token` segment, because that is what the
 * loop guard below needs and because nothing in this app ever constructs one of
 * these URLs: only the API's invite mailer mints a token, and a link built here
 * would be a link with no invite behind it.
 *
 * `/agency/join/...` is already an agency surface through the `/agency` entry in
 * {@link AGENCY_SURFACE_PREFIXES}, so `loginPathFor` sends anyone bounced off it
 * to the agency door rather than the marketing one. That is correct and needs no
 * new entry there.
 */
export const AGENCY_JOIN_PATH = '/agency/join';

/**
 * The path prefixes that belong to the Agency Dialer, and therefore the ones whose
 * sign-in belongs at {@link AGENCY_LOGIN_PATH}.
 *
 * `/dialer` and `/station` are listed beside `/agency` because they sit OUTSIDE
 * the `/agency` shell on purpose — both are full-viewport, for the reason
 * `App.tsx` gives at each: an `agent` is level 5 and renders either shell's chrome
 * around nothing, and on `/station` an escape hatch is a hazard because clicking
 * away drops the socket and hangs up on a customer. Their URLs do not advertise
 * that they are agency surfaces, so the list has to.
 */
const AGENCY_SURFACE_PREFIXES = ['/agency', '/dialer', '/station'] as const;

/**
 * Whether `path` is an Agency Dialer surface.
 *
 * ── The boundary includes `?` and `#`, and that is load-bearing ────────────
 * The value reaching here is a whole path, not a bare pathname: `RequireAuth`
 * hands over `currentPath(location)`, which is deliberately
 * `pathname + search + hash` so that `/station?campaign=camp-1` — where the query
 * IS the destination, since a bare `/station` lands on "No campaign selected." —
 * survives the round trip. A boundary of `(?:/|$)` alone therefore failed to match
 * the one URL the agency door most needs to catch, and sent an agent bounced off a
 * live station to the generic `/login` door.
 *
 * Matched on a boundary rather than with `startsWith` so `/agencyfoo` — an
 * ordinary path that merely shares a prefix — is not swept in. Case-insensitive
 * because react-router matches routes case-insensitively, so `/Dialer` reaches the
 * same component and must reach the same door.
 */
export function isAgencySurfacePath(path: string): boolean {
  return AGENCY_SURFACE_PREFIXES.some((prefix) =>
    new RegExp(`^${prefix}(?:[/?#]|$)`, 'i').test(path),
  );
}

/**
 * Which sign-in page somebody asking for `path` should be sent to.
 *
 * The destination decides the door, rather than the door being a property of the
 * session or of a role. It has to be: at the moment either caller runs there is no
 * session to read a role from — `RequireAuth` has just established that there is
 * no user, and `sessionExpiredLoginUrl` runs because the one we had was rejected.
 * The URL being asked for is the only evidence available, and for these three
 * prefixes it is good evidence: nobody reaches `/station` by accident.
 */
export function loginPathFor(path: string): string {
  return isAgencySurfacePath(path) ? AGENCY_LOGIN_PATH : LOGIN_PATH;
}

/**
 * An origin that cannot exist, used only as the base for resolving a candidate
 * path. `.invalid` is reserved by RFC 2606 and can never be registered, so a
 * candidate that resolves to this origin is provably relative.
 *
 * Deliberately NOT `window.location.origin`: this module is imported by unit tests
 * and by SSR-shaped tooling where `window` may be absent, and the check we want
 * ("does this stay put?") does not depend on which origin it stays put on.
 */
const RESOLUTION_BASE = 'https://return-path.invalid';

/**
 * Validate a `?next=` value and return it CANONICALISED, or `null` if it cannot be
 * trusted.
 *
 * ── This is an open-redirect guard, and pattern-matching was not enough ─────
 * The first version of this function rejected values by inspecting the string:
 * must start with `/`, must not start with `//`, must not contain a backslash. Two
 * families of input defeated that, and both were found in review rather than by
 * the tests written alongside it:
 *
 *  1. **Dot segments.** `/..//evil.example` starts with exactly one slash and holds
 *     no backslash, so every check passed — but the URL parser normalises it to the
 *     path `//evil.example`, which resolves cross-origin. `/x/..//evil.example`,
 *     `/./..//evil.example` and the percent-encoded `/%2e%2e//evil.example` are the
 *     same attack spelled four ways.
 *  2. **Control characters.** The WHATWG parser STRIPS tab, LF and CR before
 *     parsing, so `/\t/evil.example` — which arrives decoded from `%09` via
 *     `URLSearchParams.get` — becomes `//evil.example` after stripping.
 *
 * Either one ends the same way, and it is worth being explicit because it is not
 * obvious that a rejected `pushState` is dangerous: react-router's history `push`
 * catches the cross-origin `SecurityError` and falls back to
 * `window.location.assign(url)`. So the browser performs a real navigation to the
 * attacker's site, from a link on our domain, immediately after a successful
 * sign-in on our own login form. That is the whole phishing primitive.
 *
 * So this no longer reasons about the string. It hands the value to the URL parser
 * — the same component that will interpret it downstream — and requires that it
 * resolve to a path on our own origin. Whatever normalisation, stripping or
 * decoding the parser does, it does BEFORE the check rather than after it, which
 * is the only ordering that closes both families at once.
 *
 * The value returned is the parser's canonical form, not the caller's input, so the
 * string that reaches `navigate()` is the one that was actually validated.
 *
 * Rejected values return `null` and the caller falls back to its default. Silently:
 * a bad `next` is either an attack or a stale link, and neither is worth explaining
 * to a user mid-sign-in.
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw) return null;

  // A relative path is the only shape we accept, and it must be rooted. Checked
  // before parsing so a bare `evil.example` — which would resolve against the base
  // and look same-origin — cannot get in.
  if (!raw.startsWith('/')) return null;

  let url: URL;
  try {
    url = new URL(raw, RESOLUTION_BASE);
  } catch {
    // An input the parser refuses outright is not one we can reason about.
    return null;
  }

  // Left our origin ⇒ protocol-relative (`//host`), absolute, or normalised into
  // one of those by dot segments or stripped control characters.
  if (url.origin !== RESOLUTION_BASE) return null;

  /**
   * Belt and braces: a path that still begins `//` is read as protocol-relative by
   * anything that later resolves it against a real origin, even though it stayed
   * put against ours. The parser does not produce this from the inputs we know
   * about, so this guards the ones we do not.
   */
  if (url.pathname.startsWith('//')) return null;

  /**
   * Either sign-in page itself, and `?…` / `#…` / `/…` under it — but NOT
   * `/loginish`, which is an ordinary path that merely shares a prefix. Without
   * this a signed-out visitor bounces between the login page and itself forever.
   *
   * BOTH doors are refused, and the agency one has to be listed explicitly: it
   * lives under `/agency`, so a rule written only about `/login` would accept
   * `/agency/login` as an ordinary in-app path and loop an agent between the
   * agency door and itself. The `/agency` prefix cannot be refused wholesale
   * either — `/agency/campaigns` is exactly where a supervisor is trying to get
   * back to.
   *
   * {@link AGENCY_JOIN_PATH} is refused for the same reason one step further on.
   * An invite token is SINGLE-USE, so by the time somebody has signed in the URL
   * that carried them there is spent: honouring it as a `?next=` lands them on
   * "This invitation has already been used", whose only affordance is a link back
   * to the agency door they just came through. That is the same dead-end loop
   * `/agency/login` is refused for, and it arrives the same way — the param is in
   * the URL, so a stale bookmark or a forwarded link is enough to produce it.
   *
   * Case-insensitive because react-router matches routes case-insensitively, so
   * `/Login` reaches the same component and would loop just as happily. Tested
   * against the CANONICAL pathname, which is what makes `/login\t` — accepted by the
   * old string check, normalised back to `/login` by the parser — refuse here.
   */
  if (LOGIN_LOOP.test(url.pathname)) return null;

  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The regex behind the loop guard: either door or the invite landing page, on a
 * segment boundary.
 *
 * Built from the three exported constants rather than written out, so a path that
 * moves cannot leave a stale literal behind here — the loop guard failing open is
 * an infinite redirect, which is the one failure a reader will not diagnose from
 * the symptom.
 *
 * It is still the LOGIN loop despite the third member: all three are places a
 * visitor establishes a credential, and all three answer a post-sign-in arrival
 * with a page that sends them back where they came from. What is worth stating is
 * that {@link isLoginPath} reads this same set, so adding the join page also took
 * the two 401 guards off it — see that function for why that is the answer this
 * page needs rather than a side effect to be undone.
 */
const LOGIN_LOOP = new RegExp(
  `^(?:${LOGIN_PATH}|${AGENCY_LOGIN_PATH}|${AGENCY_JOIN_PATH})(?:/|$)`,
  'i',
);
// `(?:/|$)` and not `isAgencySurfacePath`'s `(?:[/?#]|$)`: every caller passes a
// bare pathname — `url.pathname` from the parser, or `window.location.pathname` —
// so a `?` can never appear in it.

/**
 * Whether `pathname` is one of the pages where somebody is establishing a
 * credential — the two sign-in doors, or the invite landing page.
 *
 * ── Why this is exported rather than left inline ──────────────────────────
 * Two callers outside this module ask the same question for the same reason, and
 * both asked it with `pathname.startsWith('/login')` — which was correct while
 * there was one door and silently wrong the moment there were two, because
 * `'/agency/login'.startsWith('/login')` is `false`.
 *
 * The consequence is not a redirect loop, which is what the guards were written
 * to prevent; it is worse than the loop in one specific way. Both guards fire on a
 * 401 and set `window.location.href = sessionExpiredLoginUrl()`, and from
 * `/agency/login` that URL resolves — correctly — back to `/agency/login`. So a
 * 401 from `POST /auth/session` at the agency door triggers a FULL-PAGE RELOAD of
 * the page the agent is already standing on: the form is wiped, and whatever the
 * page was about to tell them (a real credential error, or the "we don't recognise
 * that account" diagnosis) is replaced by a generic session-expired notice for a
 * session that never existed. On `/login` the guard suppresses exactly this.
 *
 * So the predicate lives here, next to the paths it is about, and both guards
 * call it. Stricter than `startsWith` as a side effect: `/loginish` is an ordinary
 * path and was previously being treated as the login page.
 *
 * ── {@link AGENCY_JOIN_PATH} belongs in it, and the reason is NOT the one
 *    originally given ──────────────────────────────────────────────────────
 * The first version of this paragraph said the membership is "what stops a
 * routine 401 there discarding the token URL". That is a counterfactual, and it
 * is worth correcting rather than deleting, because somebody will otherwise
 * re-derive it: a 401 on that page reaches neither guard. `api/invites.ts` uses
 * raw `fetch` precisely so that it does not — see its module docstring — so the
 * join page never calls `apiFetch` at all. And had it done so, this predicate
 * would not have saved it: `api/client.ts` clears the session clock and signs the
 * user out UNCONDITIONALLY on a 401, and `isLoginPath` guards only the
 * `location.href` assignment that follows.
 *
 * What the membership actually buys is two smaller things, both real:
 *
 *  1. **One set, read twice.** {@link LOGIN_LOOP} is the `?next=` guard as well
 *     as this predicate, and the join page genuinely must not be a `?next=`
 *     target — the token is single-use, so honouring one lands somebody on "This
 *     invitation has already been used". Building both from one regex is what
 *     stops the two answers drifting; being in it here is the price of that, and
 *     the price is right.
 *  2. **The guard is in place before the page needs it.** Nothing on this page
 *     reaches a 401 guard today, and the moment anything does — an authenticated
 *     call added later, or `expireSession` firing while somebody sits on the
 *     confirmation screen — a full-page navigation to the agency door would
 *     discard the token URL, which is the one thing on that screen a visitor
 *     cannot get back without asking their supervisor for another invitation.
 *     Being in the set costs nothing in return: nobody arrives at
 *     `/agency/join/:token` holding a session whose expiry is worth reporting.
 */
export function isLoginPath(pathname: string): boolean {
  return LOGIN_LOOP.test(pathname);
}

/**
 * The sign-in URL that will come back to `path` afterwards — at whichever door
 * suits the destination. See {@link loginPathFor}.
 *
 * `path` is encoded whole — it carries its own query string and hash, and those must
 * not be read as part of the login URL's own query.
 */
export function loginPathReturningTo(path: string): string {
  return `${loginPathFor(path)}?${RETURN_PATH_PARAM}=${encodeURIComponent(path)}`;
}

/** The current location as a single string, for handing to {@link loginPathReturningTo}. */
export function currentPath(location: {
  pathname: string;
  search?: string;
  hash?: string;
}): string {
  return `${location.pathname}${location.search ?? ''}${location.hash ?? ''}`;
}

/**
 * The `?session=expired` sign-in URL, carrying where the user was — at whichever
 * door suits where they were.
 *
 * ── The door is chosen from where the session lapsed ───────────────────────
 * This is the commoner entrance for agency staff, and the one where landing on
 * the wrong page is worst: an agent whose six-hour session expires mid-shift is
 * re-authenticating under time pressure with a customer waiting, and the primary
 * app's page would meet them with a free-credits banner and a Sign Up tab. So the
 * door is picked from `window.location` — the surface they were actually on —
 * through the same {@link loginPathFor} rule `RequireAuth` uses.
 *
 * ── Why the return path belongs on this path too ───────────────────────────
 * `RequireAuth` carries `?next=` for a visitor who was never signed in. This is
 * the other, commoner door: a mid-shift 401 from the backend's six-hour expiry.
 * Without the param, an agent whose session lapses while working a station is
 * re-authenticated and dropped on `/app`, and a supervisor loses their place in
 * the campaign they were watching — the exact loss the deep-link work was for,
 * reached through the door people actually use.
 *
 * `session=expired` is kept so `LoginPage` still renders the expiry notice; the
 * two params are independent.
 *
 * Uses `window.location` rather than a router hook because both call sites are
 * outside React's render tree (an `apiFetch` response handler and an auth
 * callback), which is also why they navigate with `location.href` at all.
 */
export function sessionExpiredLoginUrl(): string {
  /**
   * Built through {@link currentPath} rather than by concatenating the three
   * `window.location` fields inline. In a real browser they are always strings, but
   * the inline form produced `"/app/dashboardundefinedundefined"` against any
   * partially-stubbed location — and a `next` that never resolves is worse than no
   * `next`, because it silently swallows the destination this function exists to
   * preserve.
   */
  const next = safeReturnPath(currentPath(window.location));
  const params = new URLSearchParams({ session: 'expired' });
  /**
   * Omitted rather than sent empty when there is nothing useful to return to:
   * the current URL is `/login` itself, the guard rejected it, or it is the bare
   * root — which the router's catch-all sends to `/app` anyway, so `next=/` would
   * be a parameter that changes nothing.
   */
  if (next && next !== '/') params.set(RETURN_PATH_PARAM, next);
  /**
   * The door is chosen from the CURRENT pathname rather than from `next`, because
   * `next` is absent in exactly the cases above — already on a login page, guard
   * refused, or the bare root — and an agent whose station URL failed the guard
   * would then be handed the generic `/login` door. The pathname is available either
   * way.
   */
  return `${loginPathFor(window.location.pathname)}?${params.toString()}`;
}
