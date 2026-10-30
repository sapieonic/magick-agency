import { AGENCY_JOIN_PATH, JOIN_PATH } from '../utils/returnPath';

/**
 * Take the single-use invite token out of anything on its way to PostHog.
 *
 * ── The defect this closes ─────────────────────────────────────────────────
 * `/agency/join/:token` — and, since every role started getting a token,
 * `/join/:token` beside it — are the only routes in this app whose URL PARAMETER
 * is a secret: possession of it claims a membership, and the server's claim endpoint reads
 * the token rather than the address, so whoever holds it *is* the invitee for the
 * seven days it lives. posthog-js attaches `$current_url`, `$pathname` and `$host`
 * to **every** capture, so the token travelled in the envelope of the `$pageview`,
 * of every autocapture click, rage click and dead click, and of all five invite
 * events — including `agency_invite_viewed`, which fires while the invitation is
 * still pending and unclaimed. Anyone with PostHog read access could filter for
 * pending invites, lift the URL and claim a customer's agent membership.
 *
 * The explicit event properties were never the problem and were never the fix:
 * `analytics/events.ts` states, correctly, that no invited address, inviter name
 * or workspace name appears in any property it sends. The token was in the
 * envelope, which no call site controls. So the redaction belongs at the PostHog
 * boundary — `before_send` in {@link initAnalytics} — where it holds for captures
 * this repo never writes, autocapture included.
 *
 * ── Why this is structural rather than entropy detection ───────────────────
 * `api/error-analytics.ts` already carries `isHighEntropyTokenLikeSegment`, and
 * this deliberately does not reuse it. That predicate exists to GUESS at paths
 * whose shape is unknown, and it answers "this segment looks like an id" — it
 * requires a digit, which a base64url token legitimately need not contain (the server
 * mints 32 random bytes; roughly one token in 1,500 has no digit at all). Here the
 * shape is known: whatever follows `/agency/join/` IS the token, always, and a
 * rule keyed on the path cannot miss the token that happens to look like a word.
 * A guess is the right tool for an arbitrary URL and the wrong one for the single
 * URL in the product that must never be wrong.
 *
 * ── Every spelling of it ───────────────────────────────────────────────────
 * The token appears in three path shapes: the page the visitor is standing on —
 * {@link AGENCY_JOIN_PATH}`/<token>` for an agent, {@link JOIN_PATH}`/<token>`
 * for every other role, which became a second secret-bearing route the day every
 * role started getting a token — and the endpoints both pages call
 * (`/invites/<token>` and `/invites/<token>/claim`, which reach analytics through
 * `captureApiError`). `/invites/resend` is a sibling route with a literal segment
 * rather than a token, so it is excluded by name — redacting it would turn a
 * distinguishable endpoint into an indistinguishable one for no gain.
 *
 * Matched anywhere in the string, not just at the start, because the value being
 * cleaned is as often a whole URL (`https://app…/agency/join/<token>`) or an
 * element's text (a supervisor's copyable invitation link, which autocapture reads
 * off the DOM) as it is a bare pathname.
 */

/** What replaces the token. Not a redaction bar: it reads as a route parameter,
 *  which is what makes `/agency/join/:token` still groupable in a funnel. */
export const REDACTED_TOKEN = ':token';

/**
 * The delimiters a token ends at.
 *
 * `/`, `?` and `#` end a path segment; whitespace, quotes and angle brackets end
 * a URL embedded in prose or markup. Everything else is kept, so a token is
 * consumed whole rather than half-redacted.
 */
const TOKEN_SEGMENT = `[^/?#\\s"'<>]+`;

/**
 * Both join pages. Matched anywhere, like everything here, which means `/join/`
 * inside some unrelated URL in a property is redacted too — accepted rather than
 * engineered around, because over-redacting a stranger's path costs a funnel
 * nothing and under-redacting this one publishes a live membership.
 */
const JOIN_LINK_RE = new RegExp(`((?:${AGENCY_JOIN_PATH}|${JOIN_PATH})/)${TOKEN_SEGMENT}`, 'gi');

/** `/invites/<token>` and `/invites/<token>/claim`, but never `/invites/resend`. */
const INVITE_ENDPOINT_RE = new RegExp(
  `(/invites/)(?!resend(?:[/?#]|$))${TOKEN_SEGMENT}`,
  'gi',
);

/** Redact every invite token in one string. Returns the input when there is none. */
export function redactInviteToken(value: string): string {
  return value
    .replace(JOIN_LINK_RE, `$1${REDACTED_TOKEN}`)
    .replace(INVITE_ENDPOINT_RE, `$1${REDACTED_TOKEN}`);
}

/**
 * How far into a property payload to look.
 *
 * Autocapture's `$elements` is an array of objects one level down, so a top-level
 * pass alone would leave the token in `$el_text` — which is exactly where it lands
 * when somebody clicks near the invitation link on the team page. Bounded rather
 * than unbounded because this runs on every capture and a cyclic or pathological
 * payload must not be able to hang the page.
 */
const MAX_DEPTH = 6;

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactInviteToken(value);
  if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH) return value;

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = redactValue(item, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }

  /*
    Plain objects only. A `Date`, a `URL` or any other instance is passed through
    untouched: rebuilding one as a bare object would silently change what PostHog
    receives, and none of them can carry a token that the string branch above
    would not already have seen.
  */
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return value;

  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const next = redactValue(item, depth + 1);
    if (next !== item) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}

/**
 * Redact a whole property bag — event properties, `$set`, `$set_once`.
 *
 * The input is never mutated, and the same object comes back when nothing
 * matched, so the overwhelmingly common capture (no invite token anywhere) costs
 * one walk and no allocation.
 */
export function redactAnalyticsProperties<T extends Record<string, unknown>>(props: T): T {
  return redactValue(props, 0) as T;
}

/**
 * The properties autocapture reads OFF THE DOM, which on one route are somebody
 * else's personal details.
 *
 * `$elements` is the clicked element and its ancestors, each with its own
 * `$el_text` and attributes; `$elements_chain` is the same thing flattened into a
 * string. Both are produced by posthog-js, not by any call site here.
 */
const ELEMENT_PROPERTIES = ['$elements', '$elements_chain'] as const;

/**
 * Whether a capture happened on either invite landing page.
 *
 * Reads the URL properties posthog-js attaches to every event. Tolerant of the
 * token already being redacted by {@link redactAnalyticsProperties} — the two run
 * in that order, and `/agency/join/:token` is still the join page — and of the
 * path arriving as a full URL rather than a pathname.
 *
 * `/join/` is a substring of `/agency/join/`, so the second prefix alone would
 * answer for both; they are listed separately anyway so the rule reads as the two
 * routes it is about rather than as a coincidence of their spelling.
 */
const JOIN_PAGE_PREFIXES = [`${AGENCY_JOIN_PATH}/`, `${JOIN_PATH}/`];

function isJoinPageCapture(props: Record<string, unknown>): boolean {
  for (const key of ['$pathname', '$current_url'] as const) {
    const value = props[key];
    if (typeof value !== 'string') continue;
    const lower = value.toLowerCase();
    if (JOIN_PAGE_PREFIXES.some((prefix) => lower.includes(prefix))) return true;
  }
  return false;
}

/**
 * Take the DOM-derived element payload off any capture made on
 * `/agency/join/:token` or `/join/:token`.
 *
 * ── Why this exists when the page already opts out of autocapture ──────────
 * The page marks its invitation card `ph-no-capture`, which is the primary fix:
 * posthog-js walks the clicked element's ancestors and, finding that class, sends
 * no autocapture event at all. This is the second line, and it is here because
 * the first one is a behaviour of a PINNED DEPENDENCY that this suite can only
 * pin weakly — one upgrade that renames the class, and the leak is silent, on a
 * page whose whole content is the invitee's address, the inviter's name and the
 * workspace's name.
 *
 * It is also broader than the class in one way that matters: it covers a click
 * anywhere on that route — the panel beside the card, the page background, a
 * screen added later — rather than only inside the marked subtree.
 *
 * The element payload is REMOVED rather than blanked field by field. The text is
 * in `$el_text`, in `$elements_chain`'s serialised form, and in attributes like
 * `attr__value` and `attr__aria-label`, so an allow-list here would be a list to
 * keep in step with posthog-js's serialiser. What survives is the event itself —
 * name, URL, timing, super properties — which is what the funnel is built on;
 * the interaction detail is not something this page's analytics ever asked for.
 */
export function stripJoinPageElements<T extends Record<string, unknown>>(props: T): T {
  if (!isJoinPageCapture(props)) return props;
  if (!ELEMENT_PROPERTIES.some((key) => key in props)) return props;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if ((ELEMENT_PROPERTIES as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  return out as T;
}
