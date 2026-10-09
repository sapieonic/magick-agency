/**
 * Central plain-language vocabulary for the customer UI.
 *
 * This is the single source of truth for turning internal/engineering terms into
 * words a non-technical user understands. Everything here is DISPLAY-ONLY — it
 * never changes the values sent to or received from the backend. Surfaces import
 * these maps and the `humanizeStatus` / `humanizeToken` helpers instead of
 * hand-rolling `status.replace(/_/g, ' ')` or scattering string literals.
 */
// Covers the status, token, sentiment and analysis vocabulary the agency call
// detail uses. There are no broadcast channel or AI pipeline labels.

/** Which kind of thing a status describes — changes some labels (e.g. completed). */
export type StatusScope = 'job' | 'call' | 'message';

/** Coarse tone used to pick a color/treatment for a status. */
export type StatusTone = 'positive' | 'active' | 'neutral' | 'warning' | 'negative';

export interface HumanStatus {
  /** Plain-language label shown to the user. */
  label: string;
  /** One-sentence plain-language explanation for a tooltip. */
  tooltip: string;
  /** Coarse tone for color selection. */
  tone: StatusTone;
}

/**
 * Normalize a raw status into the lookup key used by the status maps: lowercased,
 * trimmed, with underscores collapsed to single spaces. Matches the normalization
 * StatusBadge already applies, so the same keys work in both places.
 */
export function normalizeStatusKey(raw: string): string {
  return raw.toLowerCase().trim().replace(/_+/g, ' ').replace(/\s+/g, ' ');
}

/** Statuses shared across every scope (per-call wording is the default). */
const BASE_STATUS: Record<string, HumanStatus> = {
  'waiting': { label: 'Waiting', tooltip: 'Waiting in line to start.', tone: 'neutral' },
  'queued': { label: 'Waiting', tooltip: 'Waiting in line to start.', tone: 'neutral' },
  'pending': { label: 'Waiting', tooltip: 'Waiting to be picked up.', tone: 'neutral' },
  'initiating': { label: 'Starting…', tooltip: 'Getting the call ready.', tone: 'active' },
  'initiated': { label: 'Starting…', tooltip: 'The call is being set up.', tone: 'active' },
  'ringing': { label: 'Ringing', tooltip: 'The phone is ringing.', tone: 'active' },
  'in progress': { label: 'On the call', tooltip: 'The call is happening now.', tone: 'active' },
  'executing': { label: 'On the call', tooltip: 'The call is happening now.', tone: 'active' },
  'completed': { label: 'Connected', tooltip: 'The call went through.', tone: 'positive' },
  'failed': { label: "Didn't connect", tooltip: "This call couldn't be completed.", tone: 'negative' },
  'no answer': { label: 'No answer', tooltip: 'Nobody picked up.', tone: 'warning' },
  'busy': { label: 'Line busy', tooltip: 'The line was busy.', tone: 'warning' },
  'switched off': { label: 'Phone was off', tooltip: 'The phone was switched off or out of range.', tone: 'negative' },
  'timeout': { label: 'Took too long', tooltip: 'The call took too long to connect and was dropped.', tone: 'warning' },
  'cancelled': { label: 'Stopped', tooltip: 'This call was stopped before it started.', tone: 'neutral' },
  'canceled': { label: 'Stopped', tooltip: 'This call was stopped before it started.', tone: 'neutral' },
  'scheduled': { label: 'Scheduled', tooltip: 'Set to start at a later time.', tone: 'neutral' },
};

/** Job-level overrides (a group of calls reads differently from one call). */
const JOB_STATUS: Record<string, HumanStatus> = {
  'queued': { label: 'Waiting', tooltip: 'Waiting in line to start.', tone: 'neutral' },
  // ── The three live phases of a broadcast ─────────────────────────────────
  // Sending → Calling → Done. `processing` is measured in BATCHES going out to
  // the platform; `dispatched` means every batch is with the platform and the
  // calls themselves are in flight. Before the lifecycle fix these read
  // "In progress" and "Sending…", which put the sending word on the phase that
  // had finished sending and left the calling phase with no name at all.
  'processing': { label: 'Sending', tooltip: 'Batches of calls are still going out.', tone: 'active' },
  'dispatched': { label: 'Calling', tooltip: 'Calls are going out and coming back now.', tone: 'active' },
  'in progress': { label: 'In progress', tooltip: 'Calls are happening right now.', tone: 'active' },
  'completed': { label: 'Done', tooltip: 'All calls finished.', tone: 'positive' },
  'partially failed': { label: "Done — some didn't connect", tooltip: "Finished, but some calls didn't go through.", tone: 'warning' },
  'failed': { label: "Couldn't send", tooltip: "These calls couldn't be placed. You can try again.", tone: 'negative' },
  'cancelled': { label: 'Stopped', tooltip: 'You stopped this before it finished.', tone: 'neutral' },
  'canceled': { label: 'Stopped', tooltip: 'You stopped this before it finished.', tone: 'neutral' },
  'scheduled': { label: 'Scheduled', tooltip: 'Set to start at a later time.', tone: 'neutral' },
};

/** Messaging delivery overrides. */
const MESSAGE_STATUS: Record<string, HumanStatus> = {
  'sending': { label: 'Sending…', tooltip: 'Your message is on its way.', tone: 'active' },
  'sent': { label: 'Sent', tooltip: 'Sent to the network.', tone: 'positive' },
  'delivered': { label: 'Delivered', tooltip: "Reached the person's phone.", tone: 'positive' },
  'read': { label: 'Read', tooltip: 'The person opened it.', tone: 'positive' },
  'undelivered': { label: "Didn't arrive", tooltip: "The message couldn't be delivered.", tone: 'negative' },
  'failed': { label: "Didn't arrive", tooltip: "The message couldn't be delivered.", tone: 'negative' },
};

/** Title-case an unknown status so we never show a raw `snake_case` token. */
function titleCaseStatus(key: string): string {
  return key
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Turn a raw backend status into plain-language label + tooltip + tone.
 * `scope` selects the right wording (a job's "Done" vs a call's "Connected").
 * Unknown statuses fall back to a title-cased version of the raw value, so the
 * UI degrades gracefully and never leaks `snake_case`.
 */
export function humanizeStatus(raw: string | null | undefined, scope: StatusScope = 'call'): HumanStatus {
  const key = normalizeStatusKey(raw ?? '');
  if (!key) return { label: 'Unknown', tooltip: '', tone: 'neutral' };
  const scoped = scope === 'job' ? JOB_STATUS : scope === 'message' ? MESSAGE_STATUS : undefined;
  const hit = (scoped && scoped[key]) || BASE_STATUS[key];
  if (hit) return hit;
  return { label: titleCaseStatus(key), tooltip: '', tone: 'neutral' };
}

/** Convenience: just the plain-language label for a status. */
export function statusLabel(raw: string | null | undefined, scope: StatusScope = 'call'): string {
  return humanizeStatus(raw, scope).label;
}

/**
 * Tokens whose mechanical de-underscoring isn't English. Keyed on the
 * normalized (lowercase, space-separated) form, so `escalate_human` and
 * `Escalate Human` both resolve.
 */
const TOKEN_LABEL_OVERRIDES: Record<string, string> = {
  'escalate human': 'Escalated to human',
};

/**
 * Turn an internal field/variable token (e.g. `first_name`) into a friendly
 * label (e.g. `First name`). Used so personalization chips never show raw braces
 * or `snake_case`.
 */
export function humanizeToken(token: string): string {
  const cleaned = token.trim().replace(/[{}]/g, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return token;
  const override = TOKEN_LABEL_OVERRIDES[cleaned.toLowerCase()];
  if (override) return override;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** Friendly label for a recipient sentiment value. Display-only. */
export const SENTIMENT_LABELS: Record<string, string> = {
  positive: 'Happy',
  negative: 'Unhappy',
  mixed: 'Mixed',
  neutral: 'Neutral',
};

/**
 * Sentiment label → badge/bar colour. Display-only, and the single source of
 * truth: this used to be redeclared privately in four places (the call-detail
 * sections, the prior-call briefing card, the campaign detail page and the
 * thread timeline), which meant a palette change had to be made four times.
 * Unknown labels get the neutral grey rather than a missing colour.
 */
export function getSentimentColor(label: string | null | undefined): string {
  // Tolerate a missing label: callers read it off optional analysis payloads
  // (`sentiment?.label`, `analysis_sentiment_label`), so a null/undefined here
  // means "no sentiment yet", which is the neutral case — not a crash.
  const lower = label?.toLowerCase();
  if (lower === 'positive') return '#3fcf9e';
  if (lower === 'negative') return '#ef6b6b';
  if (lower === 'mixed') return '#e8a63f';
  return '#6b6b84';
}

/**
 * ── Call-summary (post-call analysis) status vocabulary ──────────────────────
 *
 * The lifecycle of the AI-written summary of a call, which is a DIFFERENT thing
 * from the call's own status — hence explicit tooltips: without them a status
 * badge would fall back to the call-status copy ("completed" → "Successfully
 * finished") for what is really the summary stage.
 *
 * Covers both call types. AI calls produce `pending`/`completed`/`failed`/
 * `skipped`; dialer (human↔human) calls add two states only a carrier-delivered
 * recording can reach — `awaiting_recording` (the file hasn't arrived yet) and
 * `expired` (it never did) — plus `deleted` for a DSAR erasure. Reusing
 * `pending`/`failed` for those would have been a lie: "failed" implies we tried,
 * "expired" means the carrier never delivered anything to try with.
 */
export const ANALYSIS_STATUS_COLORS: Record<string, string> = {
  awaiting_recording: '#e8a63f',
  pending: '#e8a63f',
  completed: '#3fcf9e',
  failed: '#ef6b6b',
  skipped: '#6b6b84',
  expired: '#6b6b84',
  deleted: '#6b6b84',
};

/** Plain-language labels for the call-summary stage. */
export const ANALYSIS_STATUS_LABELS: Record<string, string> = {
  awaiting_recording: 'Waiting for recording',
  pending: 'Working…',
  completed: 'Ready',
  failed: 'Unavailable',
  skipped: 'Not run',
  expired: 'Recording never arrived',
  deleted: 'Deleted',
};

/** One-sentence tooltips for the call-summary stage. */
export const ANALYSIS_STATUS_TOOLTIPS: Record<string, string> = {
  awaiting_recording: 'Waiting for the phone provider to deliver the recording',
  pending: 'The AI summary is still being written',
  completed: 'The AI summary of this call is ready',
  failed: 'The AI summary could not be created',
  skipped: 'No AI summary was made for this call',
  expired: 'The phone provider never delivered a recording',
  deleted: 'The transcript and summary were deleted',
};

/**
 * The longer, in-page explanation shown on a status card — the "what now?"
 * sentence, in plainer language than the AI-call page uses because a dialer user
 * is often a non-technical agent rather than a campaign operator.
 *
 * `completed` has no message (the summary itself is the answer) and `skipped`
 * has none because that state renders nothing at all, matching AI-call behaviour.
 */
export const ANALYSIS_STATUS_MESSAGES: Record<string, string> = {
  awaiting_recording:
    "We're waiting for the phone provider to deliver the recording. This usually takes a few minutes.",
  pending: "We're listening to the call and writing the summary.",
  failed: "We couldn't create a summary for this call.",
  expired:
    "The phone provider never delivered a recording, so we couldn't create a summary.",
  deleted: 'The transcript and summary for this call were deleted.',
};

/**
 * What to say when the summary is on screen and the transcript is not.
 *
 * A purged transcript is a STATE, and rendering nothing for it is how a
 * compliance reader concludes the call was never transcribed. The server's retention
 * step nulls `conversation_log` on its own, shorter window and leaves
 * `analysis_status` at `completed` (`retention-purge.ts`) — so the
 * section simply vanishes from under a summary that is still there.
 *
 * `ANALYSIS_STATUS_MESSAGES.deleted` is the wrong sentence for it: that one is
 * the DSAR erasure terminal state, where the summary went too. Here the summary
 * was kept, and saying otherwise would misreport what the platform still holds.
 */
export const TRANSCRIPT_PURGED_MESSAGE =
  'This call was transcribed, but the transcript has passed its retention window and been '
  + 'deleted. The summary above was kept.';

/**
 * Summary states that render NOTHING at all. `skipped` matches the existing
 * AI-call behaviour (a call nobody asked to summarize shouldn't grow a card
 * explaining that), and a null/absent status means the feature never applied.
 */
export const SILENT_ANALYSIS_STATUSES: ReadonlySet<string> = new Set(['skipped']);

/**
 * Whether a summary status warrants its own status card. `completed` doesn't —
 * the summary renders instead — and the silent states don't either.
 */
export function needsAnalysisStatusCard(status: string | null | undefined): boolean {
  if (!status) return false;
  if (status === 'completed') return false;
  return !SILENT_ANALYSIS_STATUSES.has(status);
}
