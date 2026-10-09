/**
 * ─── AGENCY CAMPAIGN CONFIG VALIDATION (public API layer) ───────────────────
 *
 * Validation of the three config surfaces the campaign builder writes: the
 * disposition catalog, the outcome retry policy, and the calling
 * window.
 *
 * ── The public route validates; the internal handler stores. No copy kept ──
 * Nothing here persists or mirrors a campaign — it inspects a request body on
 * its way to the internal handler and refuses shapes that would be stored
 * happily and then behave wrongly. Two writable copies of one business object is
 * how they drift.
 *
 * `calling-hours.ts` asks for exactly this: it says of the ISO-8601 day
 * numbering that the campaign-config validator and the console's day picker
 * follow its one definition. This is that validator.
 *
 * ── What it does NOT do, and why that took checking ─────────────────────────
 * The three codes below are not required, and none is force-merged into a
 * catalog that omits it. None of the three mechanisms keys on a code *string*;
 * each keys on a *flag*: disposition-driven retry reads `entry.retry`, the
 * callback scheduler reads `entry.requires_datetime`, suppression reads
 * `entry.suppress` — and the real DNC path is the dedicated `attempts/:id/dnc`
 * route, which never consults the catalog. Grepping the dialer runtime for those
 * three strings as comparisons returns nothing outside the contract's own
 * prose, which is the method that works: a claim about dependencies is a claim
 * about callers. Do not reintroduce the opposite claim — that these three
 * "cannot be removed from a catalog because the retry engine, the scheduler and
 * the DNC path each depend on one of them existing" — it is false.
 *
 * Worse, enforcing it would break a case the dialer supports on purpose.
 * `outcome-classifier.ts`'s `requiresDisposition` treats an **empty** catalog as
 * "no codes to pick, so requiring one is a dead end" — a campaign whose agents do
 * not disposition at all. A required-codes rule here would make that campaign
 * unsaveable.
 *
 * So this file validates what is genuinely consumed and genuinely unchecked, and
 * declines to invent an invariant nothing reads.
 *
 * ── This is a good error message, not the only enforcement ──────────────────
 * The internal handler (`agency-campaigns.routes.ts`) runs its own
 * `validateAgencyCampaignConfig` (`src/agency/campaign-config.ts`), which owns
 * the retry/window/ceiling rules and carries its own `RETRY_POLICY_OUTCOMES`.
 * The two lists are a PAIR and must move together — a key accepted here and
 * refused there is a campaign that saves from the wizard and 400s at the
 * handler, and the reverse is a lever the wizard cannot offer.
 *
 * This file is the feedback surface: it answers in the field-keyed shape the
 * wizard renders. The invariants are ultimately consumed in the retry engine and
 * calling-hours gate, which is where they have to hold.
 */

/**
 * The catalog a NEW campaign gets when the request does not carry one.
 *
 * ── Why a default here, and why not a merge at read time ────────────────────
 * `agency_campaigns.disposition_catalog` is `JSONB NOT NULL DEFAULT '[]'`, so a
 * create that sends no catalog gets an empty one: `requiresDisposition` returns
 * false, and any submission is answered `unknown_disposition_code` with
 * `allowed_codes: []`. Without this default, disposition would be inert for every
 * campaign — the same `heartbeat()`-with-zero-callers shape the
 * `DEFAULT_RETRY_POLICY` header describes.
 *
 * The tempting fix is force-merging built-ins on read so the effective catalog is
 * never empty. That would **delete a coherent configuration**: an empty catalog
 * means "outcome-driven retry, no human write-up", which the dialer supports
 * deliberately (`outcome-classifier.ts`).
 *
 * A default at the creation boundary fixes inert-by-default without removing the
 * configuration, because a default is only consulted when the caller expressed no
 * opinion. **An explicit `[]` is an opinion and is left alone** — that distinction
 * is the whole mechanism, and it is why this is applied on POST only. A PATCH
 * carrying no catalog must not acquire one.
 *
 * The three codes are the built-in dispositions, with their own flags. They are
 * conventions rather than dependencies — nothing in the dialer runtime compares
 * against these strings, which is why their *presence* is not validated — but
 * they are the right conventions to start an operator from, and the
 * retry/datetime/suppress flags are what make them work.
 *
 * ── `do_not_call` carries no `terminal` — matches `BUILT_IN_DISPOSITIONS` ───
 * `BUILT_IN_DISPOSITIONS` (`src/agency/disposition-policy.ts`) declares
 * `do_not_call` as `{ suppress: true }` only. A `terminal: true` on top would be
 * a flag `resolveDispositionDecision` can never observe: `suppress` is checked
 * FIRST and returns before `terminal` is ever read (the precedence is suppress
 * beats terminal beats callback beats disposition-retry). A flag that is
 * structurally unreachable behind an earlier-checked flag is the "inert config"
 * shape this project keeps being bitten by (see `DEFAULT_RETRY_POLICY` and the
 * empty-catalog case above), so the honest default is the one that says only
 * what is true. This is a separate constant rather than an import of
 * `BUILT_IN_DISPOSITIONS`; `test/unit/agency/agency-campaign-config.test.ts` pins
 * its shape so the two cannot drift silently.
 */
export const DEFAULT_DISPOSITION_CATALOG = [
  { code: 'voicemail', label: 'Voicemail', retry: { delay_minutes: 240, max_attempts: 2 } },
  { code: 'callback', label: 'Callback', requires_datetime: true },
  { code: 'do_not_call', label: 'Do not call', suppress: true },
] as const;

/**
 * Fill in a create body's config defaults. Returns a NEW object; the input is not
 * mutated, because the caller forwards the body to the internal handler and a
 * surprise mutation of a request object is how a route starts lying about what it
 * sent.
 *
 * Only `disposition_catalog`, and only when absent. Everything else already has a
 * usable column default on `agency_campaigns` — and `retry_policy` deliberately
 * keeps its `{}`, because `DEFAULT_RETRY_POLICY` falls back per key, so sending an
 * explicit copy from here would freeze today's defaults into every campaign row
 * and make a later change to them invisible to existing campaigns.
 */
export function withCampaignConfigDefaults(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (record['disposition_catalog'] !== undefined) return body;
  return {
    ...record,
    disposition_catalog: DEFAULT_DISPOSITION_CATALOG.map((entry) => ({ ...entry })),
  };
}

/**
 * Outcomes the retry policy may be keyed by (`AgencyRetryPolicy`).
 *
 * ── `agent_disconnected` / `orphaned` ─────────────────────────────
 *
 * Both are genuinely produced by the dialer — `agency-dialer.ts` settles an
 * agent's dropped station socket `agent_disconnected`, and `reaper.ts` writes
 * `orphaned` for an attempt whose owning replica died holding it — and
 * `DEFAULT_RETRY_POLICY` gives both a real entry, so `resolveRetryDecision`
 * genuinely honours a rule keyed by either. Leaving them off THIS list would
 * 400 a key the handler both accepts and acts on: the wizard could not offer the
 * one lever that tunes the behaviour.
 *
 * ⚠️ The cap an operator sets here is the CUSTOMER's allowance, and it binds only
 * an `agent_disconnected` that happened AFTER bridging. A drop BEFORE the bridge
 * is our fault, is charged to `agency_contacts.our_fault_attempts` instead, and is
 * bounded by `OUR_FAULT_REDIAL_BOUND` (`retry-policy.ts`) — which this policy can only LOWER,
 * never raise (`min(configured, BOUND)`). That asymmetry is deliberate and is not
 * reachable from this validator: a regulated repeat-dial limit an operator can
 * raise is not a limit. Adding these keys therefore tunes the customer-allowance
 * ledger only, and cannot loosen the our-fault bound.
 *
 * ── `canceled` (pilot 2026-09-08) ───────────────────────────────────────────
 *
 * A dial we stopped before anyone picked up. Distinct from `no_answer` (they
 * never picked up) and from `abandoned` (they picked up and reached nobody), and
 * the dialer classifies it as its own outcome rather than collapsing it into
 * either — an agent, a supervisor or a lifecycle event ending an attempt while
 * the phone is still ringing.
 *
 * Accepted for the same reason as `agent_disconnected` / `orphaned`:
 * `AgencyAttemptOutcome` and `DEFAULT_RETRY_POLICY` both carry it,
 * `resolveRetryDecision` has NO short-circuit for it (only `invalid` does), and
 * refusing the key would leave the wizard unable to offer a lever the dialer acts
 * on. There is a second, sharper reason here: the console's config form re-sends
 * `retry_policy` as a LOSSLESS round trip (`buildConfigPayload` strips only
 * `invalid`), so a campaign that has STORED a `canceled` rule would 400 on its
 * next save from the wizard, keyed to a row the form never rendered — a save that
 * fails with nothing on screen to explain it.
 *
 * ⚠️ "Stored" is the precise condition. Nothing writes that key onto the row by
 * default: a missing `retry_policy` is COALESCEd to `'{}'` and
 * `DEFAULT_RETRY_POLICY` is a READ-TIME fallback. So the round-trip 400 needs
 * someone to have stored the key — an earlier save that sent it — and is not
 * reached by every campaign that merely *experiences* a cancelled dial.
 *
 * ⚠️ **The lever this key tunes is the OUR-FAULT ledger, not the customer's, and
 * that is the whole of it — unlike `agent_disconnected`, which is both.** A
 * cancel is never bridged by construction, and the dialer's `ended` handler
 * routes an unbridged our-fault outcome to `resolveOurFaultRedial` and
 * `agency_contacts.our_fault_attempts`. So the `DEFAULT_RETRY_POLICY.canceled`
 * entry is a FALLBACK that no live path reads (`retry-policy.ts` says so), while
 * the key an operator sets HERE is read: that function takes
 * `min(configured, OUR_FAULT_REDIAL_BOUND)` for the cap and the configured
 * `delay_minutes` for the delay. Lowering only, never raising — the same
 * asymmetry documented for `agent_disconnected` above, for the same regulatory
 * reason. Setting it to `0` therefore retires a contact on the first cancelled
 * dial without anyone having spoken to them, which is why the console labels the
 * row as our fault and warns on zero rather than leaving `0` to read as "one
 * fewer redial".
 *
 * NOT in {@link SILENTLY_INERT_OUTCOMES} and NOT in
 * {@link SUPPRESSED_BEFORE_POLICY_OUTCOMES}: unlike `machine` it genuinely
 * happens (26 of them in the 2026-09-08 pilot window), and unlike `invalid`
 * nothing short-circuits ahead of the policy read. A rule keyed here fires.
 */
export const RETRY_POLICY_OUTCOMES = [
  'no_answer',
  'busy',
  'failed',
  'abandoned',
  'connected',
  'agent_disconnected',
  'orphaned',
  'canceled',
] as const;

/**
 * `machine` is called out separately from "any unknown key" because it is the one
 * an operator will reach for, and the failure is silent.
 *
 * With AMD off the system can never classify an outcome as `machine` — a
 * call answered by voicemail is `connected`, because the carrier cannot tell us
 * otherwise. So a `machine` policy is not a typo that gets ignored; it is a
 * configured retry rule that will never once fire, and voicemail retry is
 * disposition-driven instead. Naming it in the error is the whole value.
 */
const SILENTLY_INERT_OUTCOMES = new Set(['machine', 'voicemail', 'answering_machine']);

/**
 * Refused because an EARLIER-CHECKED branch in the retry engine makes them
 * unreachable, not because they are not real outcomes.
 *
 * `resolveRetryDecision` returns `{contactState: 'suppressed'}` for `invalid`
 * BEFORE the line that reads `policy?.[outcome]`, so neither a campaign's rule
 * nor `DEFAULT_RETRY_POLICY.invalid` can ever be read for that outcome. Accepting
 * the key would let an operator configure a retry, see it stored, and never have
 * it fire — the same silent no-op the `machine` rule above exists to prevent.
 *
 * Kept separate from {@link SILENTLY_INERT_OUTCOMES} because the operator needs a
 * different explanation: `machine` NEVER HAPPENS, whereas `invalid` happens
 * constantly and is simply never retried. Reusing the answering-machine wording
 * would be actively wrong.
 *
 * ⚠️ `connected` looks similar and is NOT here, deliberately. It has no
 * short-circuit: it falls through to the ordinary policy lookup, so a rule
 * genuinely overrides the built-in `{max_attempts: 0}`. Refusing it would delete
 * a live lever. The two are pinned apart in `retry-policy.test.ts`.
 */
const SUPPRESSED_BEFORE_POLICY_OUTCOMES = new Set(['invalid']);

/**
 * Real words this product itself taught the operator, which are not the spelling
 * the outcome vocabulary uses. Mapped to the correct key so the message can say
 * which.
 *
 * `cancelled` is the whole reason this set exists. Almost every other vocabulary
 * in this service is British — the ingest job's `cancelled` status among them —
 * while the attempt outcome is `canceled`, matching `webrtc_calls.status`. So an operator who has read any other part of this
 * product reaches for two Ls, and gets the generic "not a call outcome" 400 with
 * a valid-keys list they then have to diff by eye to spot that the answer is one
 * letter away.
 *
 * Kept OUT of {@link SILENTLY_INERT_OUTCOMES}: that copy explains that a rule can
 * never fire because AMD is off, which is not true of `cancelled` and would send
 * the operator to the disposition screen for no reason. This is a typo with a
 * known fix, and the only useful message names the fix. Same class of miss as
 * `answering_machine`, different remedy.
 */
const SPELLING_ALIAS_OUTCOMES = new Map([['cancelled', 'canceled']]);

/** `HH:MM` or `HH:MM:SS` — Postgres renders a `TIME` column as the latter. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/**
 * `Area/Location`, or exactly `UTC`.
 *
 * ── Why a bare abbreviation must be refused, and why `Intl` will not do it ───
 * `new Intl.DateTimeFormat(undefined, { timeZone: 'EST' })` **does not throw**.
 * ICU resolves `EST` to `America/Panama`, which observes no DST — so a campaign
 * configured `EST` would place every call **an hour early for half the year**,
 * and would test clean whenever anyone checked, because whoever checks is
 * unlikely to do it across a DST boundary. An `Intl`-only validator passes it.
 *
 * Ratified rule, and the internal handler's validator holds it too.
 */
const IANA_ZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+$/;

export interface ConfigIssue {
  /** Dot/bracket path into the request body, so the wizard can mark the field. */
  field: string;
  message: string;
}

/**
 * Is this a usable IANA zone?
 *
 * Two gates, both required. The shape gate refuses abbreviations (see
 * {@link IANA_ZONE_RE}); the `Intl` gate refuses `Made/Up`, which passes the
 * shape gate happily.
 */
export function isUsableTimezone(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  if (value === 'UTC') return true;
  if (!IANA_ZONE_RE.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Normalise `HH:MM` and `HH:MM:SS` to a comparable `HH:MM:SS`. */
function toComparableTime(value: string): string {
  return value.length === 5 ? `${value}:00` : value;
}

/**
 * ─── BUILT-IN SEMANTIC MISMATCH ───────────────────────────────────────────────
 *
 * The three built-in codes are available, not force-merged (see the header
 * above) — which is correct, and creates this hazard rather than removing it.
 * Nothing keys on a disposition's code *string*; every mechanism keys on a
 * *flag*. So `{ code: 'do_not_call', label: 'Do not call' }` with no
 * `suppress: true` is a button labelled "Do not call" that suppresses nothing:
 * the customer asks never to be called again, the agent clicks the obvious
 * control, and the contact is retried on schedule. The same shape applies to
 * `voicemail` without `retry` (the label promises retry it cannot deliver) and
 * `callback` without `requires_datetime` (the console never collects a time).
 *
 * The dialer runtime has this detector — `builtInSemanticMismatches()` in
 * `src/agency/disposition-policy.ts` — pure, correct, and honestly documented as
 * changing no behaviour on its own; nothing in `src/` calls it. This file keeps
 * its own map rather than importing that one — read that file for reference,
 * never edit it from here.
 *
 * ── Blocking, not a warning ─────────────────────────────────────────────────
 * The detector is deliberately advisory: "a compliance floor that overrides
 * operator config is a decision, not an implementation detail." This file makes
 * that decision, consciously, and blocks: the failure mode
 * is a customer's do-not-call request being silently ignored, which is a
 * regulated harm, not a UX rough edge — and this file is already the wizard's
 * feedback surface (see the header), not merely advisory prose. A mis-flagged
 * built-in is therefore pushed into `issues` exactly like every other rule in
 * this function, which `proxy-agency-campaigns.routes.ts` turns into a 400 on
 * both POST and PATCH.
 *
 * ── What this must NOT become ───────────────────────────────────────────────
 * This is not the withdrawn "built-ins are mandatory" rule reintroduced by the
 * back door. Three things keep it from sliding there: an entry using a
 * built-in code with the RIGHT flag present is untouched regardless of the
 * flag's *value* (`voicemail` with `max_attempts: 1` instead of 2 is an
 * operator's business — only a MISSING flag is reported); an empty catalog
 * produces no issue at all, since there is no built-in entry to mismatch; and
 * a non-built-in code carrying no flags is a legal plain-label disposition,
 * never flagged.
 */
const BUILT_IN_SEMANTIC_FLAGS: Readonly<Record<string, 'retry' | 'requires_datetime' | 'suppress'>> = {
  voicemail: 'retry',
  callback: 'requires_datetime',
  do_not_call: 'suppress',
};

/** The operator-facing consequence of each built-in's missing flag, named plainly. */
const BUILT_IN_SEMANTIC_MISMATCH_REASON: Readonly<Record<string, string>> = {
  voicemail:
    'the label promises voicemail retry this entry cannot deliver, and (with AMD off) a voicemail pickup classifies as connected, so nothing else retries it either.',
  callback:
    "the console will never collect a callback time for this code, so an agent clicking it cannot actually promise the customer a callback.",
  do_not_call:
    "the customer's do-not-call request will not be honored — the contact is retried on schedule as if nothing was said.",
};

/**
 * Does `entry` carry the flag that gives `code`'s label its meaning? `retry` is
 * presence-only (any object counts, `validateRetryRule` above already checks
 * its shape); `requires_datetime`/`suppress` must be literally `true` — `false`
 * or a truthy non-boolean is not the flag, and the boolean-shape loop above
 * already reports a non-boolean value as its own issue.
 */
function hasBuiltInSemanticFlag(entry: Record<string, unknown>, flag: 'retry' | 'requires_datetime' | 'suppress'): boolean {
  return flag === 'retry' ? entry['retry'] !== undefined && entry['retry'] !== null : entry[flag] === true;
}

function validateDispositionCatalog(catalog: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  if (!Array.isArray(catalog)) {
    return [{ field: 'disposition_catalog', message: 'disposition_catalog must be an array.' }];
  }

  // An empty catalog is VALID and means "agents do not disposition on this
  // campaign" — `requiresDisposition` reads it that way deliberately.
  const seen = new Set<string>();

  catalog.forEach((raw, i) => {
    const at = `disposition_catalog[${i}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push({ field: at, message: 'Each disposition must be an object.' });
      return;
    }
    const entry = raw as Record<string, unknown>;

    const code = entry['code'];
    if (typeof code !== 'string' || !/^[a-z0-9_]{1,50}$/.test(code)) {
      issues.push({
        field: `${at}.code`,
        // Lowercase and underscores only, because the code is compared
        // byte-for-byte at three boundaries: the catalog lookup on submit, the
        // console's pad, and the retry engine's precedence check. A code differing
        // only in case is a submission answered `unknown_disposition_code`.
        message:
          'code must be 1–50 characters of lowercase letters, digits or underscores.',
      });
    } else if (seen.has(code)) {
      // First-wins is what `find(c => c.code === x)` does, silently, and the
      // operator's second entry — with its own retry and terminal flags — simply
      // never applies.
      issues.push({ field: `${at}.code`, message: `Duplicate disposition code '${code}'.` });
    } else {
      seen.add(code);
    }

    const label = entry['label'];
    if (typeof label !== 'string' || label.trim().length === 0 || label.length > 100) {
      // The agent reads the label off a button. An entry with no label renders an
      // unlabelled button that files a disposition against a customer.
      issues.push({ field: `${at}.label`, message: 'label must be 1–100 characters.' });
    }

    for (const flag of ['is_success', 'requires_note', 'requires_datetime', 'terminal', 'suppress']) {
      if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') {
        issues.push({ field: `${at}.${flag}`, message: `${flag} must be a boolean.` });
      }
    }

    if (entry['retry'] !== undefined) {
      const retry = entry['retry'];
      if (retry === null || typeof retry !== 'object' || Array.isArray(retry)) {
        issues.push({ field: `${at}.retry`, message: 'retry must be an object.' });
      } else {
        issues.push(...validateRetryRule(retry as Record<string, unknown>, `${at}.retry`));
      }
    }

    // Built-in semantic mismatch — only for a code that IS one
    // of the three built-ins, matched byte-for-byte like every other code
    // comparison in this file (see the `.code` validation above).
    if (typeof code === 'string') {
      const requiredFlag = BUILT_IN_SEMANTIC_FLAGS[code];
      if (requiredFlag && !hasBuiltInSemanticFlag(entry, requiredFlag)) {
        issues.push({
          field: `${at}.${requiredFlag}`,
          message: `Built-in code '${code}' has no effect without '${requiredFlag}'${requiredFlag === 'retry' ? '' : ': true'} — ${BUILT_IN_SEMANTIC_MISMATCH_REASON[code]}`,
        });
      }
    }
  });

  return issues;
}

/**
 * One `{ delay_minutes?, max_attempts }` rule.
 *
 * `max_attempts` is **required** — the contract types it non-optional while the
 * value arrives as untyped JSON, so `retry: {}` reaches the retry engine as
 * `max_attempts: undefined` and every comparison against it is `false`. The
 * operator's configured retry then silently never fires, which is the exact shape
 * this project keeps finding.
 */
function validateRetryRule(rule: Record<string, unknown>, at: string): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  const max = rule['max_attempts'];
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 0 || max > 20) {
    issues.push({
      field: `${at}.max_attempts`,
      message: 'max_attempts is required and must be an integer between 0 and 20.',
    });
  }

  const delay = rule['delay_minutes'];
  if (delay !== undefined) {
    if (typeof delay !== 'number' || !Number.isInteger(delay) || delay < 0 || delay > 43_200) {
      issues.push({
        field: `${at}.delay_minutes`,
        // 30 days. A delay beyond that is indistinguishable from never, and a
        // contact parked for a year is worse than one marked exhausted.
        message: 'delay_minutes must be an integer between 0 and 43200 (30 days).',
      });
    }
  }

  for (const key of Object.keys(rule)) {
    if (key !== 'max_attempts' && key !== 'delay_minutes') {
      issues.push({ field: `${at}.${key}`, message: `Unknown retry field '${key}'.` });
    }
  }

  return issues;
}

function validateRetryPolicy(policy: unknown): ConfigIssue[] {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    return [{ field: 'retry_policy', message: 'retry_policy must be an object keyed by outcome.' }];
  }

  const issues: ConfigIssue[] = [];
  const known = new Set<string>(RETRY_POLICY_OUTCOMES);

  for (const [key, rule] of Object.entries(policy as Record<string, unknown>)) {
    if (!known.has(key)) {
      issues.push({
        field: `retry_policy.${key}`,
        message: SPELLING_ALIAS_OUTCOMES.has(key)
          ? `'${key}' is not a call outcome — did you mean '${SPELLING_ALIAS_OUTCOMES.get(key)}'? Core spells this one without the double L, matching the call status. Rename the key and the rule is kept as written.`
          : SILENTLY_INERT_OUTCOMES.has(key)
            ? `'${key}' is never a call outcome — with answering-machine detection off, a call answered by voicemail is classified 'connected'. A rule here would never fire. Configure voicemail retry on the 'voicemail' disposition instead, where it is applied.`
            : SUPPRESSED_BEFORE_POLICY_OUTCOMES.has(key)
              ? `'${key}' is a real outcome, but a retry rule on it can never fire: an unreachable number is suppressed the moment it is classified, before any retry policy is consulted, because a bad number does not become good on a redial. Remove the key — suppression already handles it. To stop calling a contact for any other reason, use the 'do_not_call' disposition.`
              : `'${key}' is not a call outcome. Valid keys: ${RETRY_POLICY_OUTCOMES.join(', ')}.`,
      });
      continue;
    }
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      issues.push({ field: `retry_policy.${key}`, message: 'Each outcome rule must be an object.' });
      continue;
    }
    issues.push(...validateRetryRule(rule as Record<string, unknown>, `retry_policy.${key}`));
  }

  // An empty policy is valid and is the ORDINARY case:
  // `DEFAULT_RETRY_POLICY` falls back per key, so `{}` means "the documented
  // defaults" rather than "retry nothing".
  return issues;
}

/**
 * The calling window.
 *
 * Fields are validated independently, because this is a PATCH surface too — an
 * operator may send `calling_days` alone, and a rule spanning two fields can only
 * be checked when both are present in the same body. The cross-field rule below is
 * therefore conditional, and `validateAgencyCampaignConfig` takes the *merged*
 * view where a caller has one.
 */
function validateCallingWindow(body: Record<string, unknown>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  for (const field of ['calling_window_start', 'calling_window_end'] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !TIME_RE.test(value)) {
      // A malformed TIME reaches Postgres as `22007` inside the insert, which
      // surfaces to the operator as a masked 500 with no field to correct.
      issues.push({ field, message: `${field} must be a 24-hour time, HH:MM or HH:MM:SS.` });
    }
  }

  const start = body['calling_window_start'];
  const end = body['calling_window_end'];
  if (typeof start === 'string' && typeof end === 'string' && TIME_RE.test(start) && TIME_RE.test(end)) {
    // Compared in the NORMALISED form, not as strings: `'09:00'` and `'09:00:00'`
    // are the same instant, Postgres renders a `TIME` column as the latter, and an
    // edit-then-save round trip mixes the two in one body. A raw `start === end`
    // lets exactly that pair through.
    if (toComparableTime(start) === toComparableTime(end)) {
      /**
       * The calling-hours gate reads `start === end` as **permanently closed** — `nextOpenAt`
       * returns null, meaning "no opening exists" — not as a 24-hour window. A
       * saveable campaign that can never place a call is a support ticket whose
       * cause is invisible on every screen, so it is refused at the boundary
       * where the operator can still see what they typed.
       *
       * A window that wraps midnight (22:00 → 06:00) IS supported and must not be
       * rejected here: `calling-hours.ts` handles `start > end` explicitly.
       */
      issues.push({
        field: 'calling_window_end',
        message:
          'The calling window cannot start and end at the same time — the campaign would never dial. For an all-day window use 00:00 to 23:59.',
      });
    }
  }

  const days = body['calling_days'];
  if (days !== undefined) {
    if (!Array.isArray(days)) {
      issues.push({ field: 'calling_days', message: 'calling_days must be an array of day numbers.' });
    } else if (days.length === 0) {
      // Same class as `start === end`: the gate returns "no opening exists".
      issues.push({
        field: 'calling_days',
        message: 'Select at least one calling day — the campaign would never dial.',
      });
    } else {
      days.forEach((day, i) => {
        if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 7) {
          issues.push({
            field: `calling_days[${i}]`,
            /**
             * ISO-8601: 1=Mon … 7=Sun, and **`0` is refused rather than read as
             * Sunday.** The column's default `{1,2,3,4,5}` is Mon–Fri under both
             * Postgres `dow` (0=Sun) and `isodow` (1=Mon), so the ambiguity is
             * undetectable by testing the default and would surface as an
             * off-by-one on Sundays months later. A caller sending `0` believes
             * `dow`, so accepting it means we and they disagree about which days
             * the campaign runs. `calling-hours.ts` pins the same
             * definition.
             */
            message: 'Days are ISO-8601: 1 = Monday … 7 = Sunday. 0 is not a valid day.',
          });
        }
      });
    }
  }

  const timezone = body['default_timezone'];
  if (timezone !== undefined && !isUsableTimezone(timezone)) {
    issues.push({
      field: 'default_timezone',
      /**
       * Refused here because at dial time an unreadable zone means the
       * *campaign's own config* is broken, and the per-contact gate can only
       * park the contact and log — it cannot pause a campaign, and should not
       * learn how to. So the rejection belongs at this boundary.
       *
       * The abbreviation clause is the load-bearing half: ICU resolves `'EST'`
       * without error, to a zone that observes no DST.
       */
      message:
        "default_timezone must be a full IANA zone name like 'America/New_York' or 'Asia/Kolkata', or exactly 'UTC'. Abbreviations such as 'EST' are refused: they resolve to a zone that does not observe daylight saving, which would place every call an hour early for half the year.",
    });
  }

  return issues;
}

/**
 * Validate whichever of the config fields a create or patch body carries.
 *
 * Absent fields are not defaulted and not complained about — this serves PATCH as
 * well as POST, and a partial update must be able to touch one field.
 *
 * Returns every issue rather than the first, because the builder renders them
 * against the fields at once and a one-at-a-time surface makes an operator fix a
 * five-field form in five round trips.
 */
export function validateAgencyCampaignConfig(body: unknown): ConfigIssue[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return [];
  const record = body as Record<string, unknown>;

  const issues: ConfigIssue[] = [];
  if (record['disposition_catalog'] !== undefined) {
    issues.push(...validateDispositionCatalog(record['disposition_catalog']));
  }
  if (record['retry_policy'] !== undefined) {
    issues.push(...validateRetryPolicy(record['retry_policy']));
  }
  issues.push(...validateCallingWindow(record));
  return issues;
}

/** `{ field: message }`, the shape the public routes send as `details`. */
export function issuesToDetails(issues: readonly ConfigIssue[]): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of issues) {
    // First message per field wins: two messages for one field cannot both be
    // rendered next to it, and the first is the one that ran earliest and is
    // therefore the most structural.
    if (!(issue.field in details)) details[issue.field] = issue.message;
  }
  return details;
}
