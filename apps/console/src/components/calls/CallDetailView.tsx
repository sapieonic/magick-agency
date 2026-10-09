import { useState, useEffect, useCallback, useMemo } from 'react';
import { Info, Clock, AlertTriangle, Mic, Download, MessageSquare } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import {
  Breadcrumbs,
  PageHeader,
  StatusBadge,
  LoadingSpinner,
} from '../common';
import { ErrorText } from '../common/ErrorText';
import { AudioWaveform } from '../audio/AudioWaveform';
import {
  AnalysisSection,
  TranscriptSection,
  AnalysisStatusCard,
  type TranscriptSectionEntry,
} from './CallDetailSections';
import { formatPhone, formatDuration, formatDate } from '../../utils/format';
import { needsAnalysisStatusCard, TRANSCRIPT_PURGED_MESSAGE } from '../../utils/vocabulary';
import type {
  WebRtcCallRecord,
  WebRtcCallRecordStatus,
  DialerTranscriptEntry,
  RecordingOutcome,
} from '../../types/webrtc-call';
import styles from '../../pages/calls/CallDetailPage.module.css';

/**
 * Re-exported so the two pages can name a fetcher's answer without reaching past
 * this component for it — the shape belongs to `types/webrtc-call.ts`, where the
 * api layer can import it without depending on a component.
 */
export type { RecordingOutcome };

/**
 * ─── ONE CALL DETAIL VIEW, CALLER-SUPPLIED IDENTITY ───────────────────────
 *
 * An `agency_calls` row's detail page: timing, recording and summary sections.
 * Its caller today is the agency attempt page (`AgencyAttemptCallPage`), which
 * keeps the campaign context and the list the reader came from.
 *
 * ── What is shared is the CALL; what differs is its IDENTITY ───────────────
 *
 * The first draft of this component hardcoded a generic facts card —
 * Destination, Caller ID, Status, Outcome, **Provider**, **Initiated By** — and
 * the agency page inherited it. For an agency leg `initiated_by` is the dialing
 * SESSION id (the API's `agency-dialer.ts` sets `initiatedBy: cmd.sessionId`), so
 * a paying agency customer read a raw UUID; and `outcome` there is the media
 * leg's (`browser_hangup`), not the attempt's (`Connected`), which is the word
 * the list they clicked out of uses. Meanwhile everything the supervisor came
 * for — which agent worked it, what they dispositioned it as, what they wrote
 * down — lives on the attempt row, which this component has never seen.
 *
 * So the answer to *"what IS this call?"* is a caller-supplied part of the
 * contract: `subtitle`, `identityFacts` and `identityCards`. Only the three
 * facts that are literally the same column read the same way — destination,
 * caller id and status — stay in this file.
 *
 * ── Every caller-specific prop is REQUIRED, and that is the design ─────────
 *
 * Not one of `breadcrumbs`, `leafLabel`, `subtitle`, `roleLabels`,
 * `identityFacts`, `identityCards`, `analysisEnabled`, `analysisTitle`,
 * `analysisMessages`, `retryLabel`, `recordingEnabled`, `fetchRecording` or
 * `onRetryAnalysis` has a default. A default here would be somebody's wording,
 * and a new consumer would then inherit a breadcrumb, a recording URL and a
 * session UUID by saying nothing at all. The compile error is the point, the
 * same way it is for the `scope` parameter on the API's repository reads.
 *
 * `roleLabels` and `onRetryAnalysis` are `| undefined` rather than optional on
 * purpose: passing `undefined` is a real choice in both cases (legs with no names
 * to give; no retry route ⇒ offer no retry) and it has to stay expressible
 * without becoming the accidental default. `identityCards: []` is a real answer
 * too.
 *
 * What `roleLabels` is NOT is the diarization decision. This view drops the
 * labels itself whenever `transcript_meta.diarization_failed` — a column of
 * "Unknown" is worse than none — and it does so for every consumer, so a caller
 * cannot opt out of it. The agency caller used to apply the same ternary on the
 * way in, which decided nothing (the view re-made it either way): one rule, two
 * homes. It reads on a transcript, so it lives where the transcript is rendered.
 *
 * ── `onRetryAnalysis: undefined` means NO BUTTON, not "use the default" ────
 *
 * This is the one that shipped broken. `AnalysisStatusCard` defaults its retry to
 * `retryAnalysis` → `POST /proxy/calls/:id/retry-analysis`, which reads the
 * `calls` table, not `agency_calls`. Omitting the handler did not disable the
 * button, it silently rewired it — so an agency supervisor whose summary failed
 * got a primary "Try again" that returned "Retry failed" forever. So `canRetry`
 * below is ANDed with the presence of a handler: no handler, no affordance, and
 * the view never reaches that endpoint.
 *
 * This component does NO fetching and owns no capability. It renders the call it
 * is handed. The caller resolves its own entitlement (`agency.analytics` for the
 * agency page) and passes the answer.
 */

/**
 * Fetches this call's recording bytes as a blob URL. Injected because the
 * route belongs to the caller: the agency's is keyed on its campaign and attempt.
 *
 * `null` means **the caller cannot say why** — no id to ask with, or a client
 * that collapses every failure. It renders the old
 * unqualified "Recording not available.", which is the honest answer when the
 * reason genuinely is not known; guessing one of the four below would put a
 * specific claim on a caller that made none.
 *
 * The CALLER of a `ready` url owns it; this component revokes what it created.
 */
export type RecordingFetcher = (
  tenantId: string,
  accountId: string | undefined,
) => Promise<RecordingOutcome | null>;

/**
 * One labelled fact about the call, as its caller understands it.
 *
 * `value: null` renders the muted placeholder rather than an empty cell, because
 * a blank on this page reads as data we failed to load — and on an agency attempt
 * an absent agent or disposition is ordinary rather than missing (see
 * `agencySpineCopy.agentCellCopy`, which is where that distinction is worded).
 */
export interface CallFact {
  label: string;
  /** Rendered as TEXT, never as markup. */
  value: string | null;
  /** Monospace — for phone numbers, durations and ids. */
  mono?: boolean;
  /** Muted, for a value that is a stated absence rather than a reading. */
  muted?: boolean;
  /** A longer explanation, on hover. */
  hint?: string;
  /** Prose: its own full-width row, wrapping. For an agent's free-text notes. */
  prose?: boolean;
}

/** A card of caller-owned facts, rendered after Call information. */
export interface CallFactCard {
  title: string;
  facts: CallFact[];
}

export interface CallDetailViewProps {
  call: WebRtcCallRecord;
  /** The trail ABOVE this page. The leaf is `leafLabel`. */
  breadcrumbs: Array<{ label: string; href?: string }>;
  leafLabel: string;
  /** Under the destination number — the caller's one-line "what happened". */
  subtitle: string;
  /**
   * Names for the call's legs, or `undefined` for a caller that has none to
   * give. Not the diarization decision — see the note above.
   */
  roleLabels: Record<string, string> | undefined;
  /** The caller's own facts, after the shared destination / caller id / status. */
  identityFacts: CallFact[];
  /** Further caller-owned fact cards. `[]` when the caller has none. */
  identityCards: CallFactCard[];
  /** Resolved by the caller from ITS OWN capability. */
  analysisEnabled: boolean;
  analysisTitle: string;
  analysisMessages: Record<string, string>;
  retryLabel: string;
  /**
   * Whether the caller may play recordings at all, resolved by the caller from
   * its own capability — the sibling of `analysisEnabled`.
   *
   * It exists because a refusal and a delay look identical from here. The API
   * nulls `recording_url` for a tenant without `agency.recording` while leaving
   * `recording_requested` true, and the page then said *"A recording was
   * requested … check back soon"* — a false promise on an entitlement refusal,
   * for a recording that is never coming.
   */
  recordingEnabled: boolean;
  fetchRecording: RecordingFetcher;
  /** `undefined` when the caller cannot re-run a summary ⇒ no retry button. */
  onRetryAnalysis: (() => Promise<void>) | undefined;
  onReload: () => void;
}

/** Adapt a transcript turn to the shared TranscriptSection's shape. */
function toTranscriptEntries(entries: DialerTranscriptEntry[]): TranscriptSectionEntry[] {
  return entries.map(e => ({
    role: e.role,
    content: e.content,
    language: e.language,
    confidence: e.confidence,
  }));
}

const STATUS_COLOR_MAP: Record<string, string> = {
  completed: '#3fcf9e',
  failed: '#ef6b6b',
  in_progress: '#7c5cfc',
  ringing: '#56b8f0',
  initiating: '#14b8a6',
  no_answer: '#e8a63f',
  busy: '#f97316',
  canceled: '#6b6b84',
};

/** Statuses that mean the call did not complete normally — surface the error block. */
const FAILURE_STATUSES: ReadonlySet<string> = new Set(['failed', 'no_answer', 'busy']);

function statusColor(status: WebRtcCallRecordStatus): string {
  return STATUS_COLOR_MAP[status] ?? 'var(--accent)';
}

function InfoItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.infoItem}>
      <span className={styles.infoLabel}>{label}</span>
      {children}
    </div>
  );
}

/** One {@link CallFact}. */
function FactItem({ fact }: { fact: CallFact }) {
  const valueClass = fact.muted
    ? styles.infoValueMuted
    : fact.mono
      ? styles.infoValueMono
      : styles.infoValue;
  return (
    <div
      className={styles.infoItem}
      // Prose gets the whole two-column row; a write-up sentence inside one grid
      // column wraps to five words a line.
      style={fact.prose ? { gridColumn: '1 / -1' } : undefined}
      title={fact.hint}
      data-testid={`call-fact-${fact.label}`}
    >
      <span className={styles.infoLabel}>{fact.label}</span>
      {fact.value === null ? (
        <span className={styles.infoValueMuted}>--</span>
      ) : (
        <span
          className={valueClass}
          style={fact.prose ? { whiteSpace: 'pre-wrap' } : undefined}
        >
          {fact.value}
        </span>
      )}
    </div>
  );
}

/**
 * One {@link CallFactCard} — a titled grid of a surface's own facts.
 *
 * Exported alongside the view itself, because these facts belong to the surface
 * rather than to the call. An agency attempt outlives its call by
 * design (the link is un-FK'd and the two
 * sides purge on independent windows), so the attempt's record has to render on a
 * page where there is no call for this view to draw at all. Rendering it there
 * through this component rather than a second card of its own is what keeps one
 * look for one row: a supervisor comparing the purged state to the ordinary one
 * is comparing the same grid, not two that drifted.
 *
 * `icon` is required for the same reason every prop on the view is: a default
 * would be whichever icon the first caller happened to want. Its TINT is not the
 * caller's business, though — the accent colour is this card's chrome, and asking
 * for it would make a consumer outside this file reach for the stylesheet of the
 * page that happens to share it to draw an agency card.
 */
export function FactCard({ card, icon }: { card: CallFactCard; icon: React.ReactNode }) {
  return (
    <div className={styles.card}>
      <h3 className={styles.cardTitle}>
        <span className={styles.cardTitleIcon}>{icon}</span>
        {card.title}
      </h3>
      <div className={styles.infoGrid}>
        {card.facts.map((fact) => (
          <FactItem key={fact.label} fact={fact} />
        ))}
      </div>
    </div>
  );
}

export function CallDetailView({
  call,
  breadcrumbs,
  leafLabel,
  subtitle,
  roleLabels,
  identityFacts,
  identityCards,
  analysisEnabled,
  analysisTitle,
  analysisMessages,
  retryLabel,
  recordingEnabled,
  fetchRecording,
  onRetryAnalysis,
  onReload,
}: CallDetailViewProps) {
  const conversationLog = call.conversation_log ?? null;
  const transcriptEntries = useMemo(
    () => (conversationLog ? toTranscriptEntries(conversationLog) : []),
    [conversationLog],
  );

  const answered = call.answered_at != null;
  const isFailure = FAILURE_STATUSES.has(call.status);
  const hasError = Boolean(call.error_code || call.error_message);

  return (
    <div className={styles.page}>
      <Breadcrumbs
        items={[...breadcrumbs, { label: leafLabel }]}
      />
      <PageHeader
        title={formatPhone(call.destination_phone)}
        subtitle={subtitle}
        actions={
          <StatusBadge
            label={call.status.replace(/_/g, ' ')}
            color={statusColor(call.status)}
          />
        }
      />

      {/* Key facts: the three shared columns, then whatever THIS caller means by
          the identity of a call — see the header. */}
      <div className={styles.card}>
        <h3 className={styles.cardTitle}>
          <Info size={16} className={styles.cardTitleIcon} />
          Call Information
        </h3>
        <div className={styles.infoGrid}>
          <InfoItem label="Destination">
            <span className={styles.infoValueMono}>{formatPhone(call.destination_phone)}</span>
          </InfoItem>
          <InfoItem label="Caller ID">
            <span className={styles.infoValueMono}>{formatPhone(call.caller_id)}</span>
          </InfoItem>
          <InfoItem label="Status">
            <StatusBadge
              label={call.status.replace(/_/g, ' ')}
              color={statusColor(call.status)}
            />
          </InfoItem>
          {identityFacts.map((fact) => (
            <FactItem key={fact.label} fact={fact} />
          ))}
        </div>
      </div>

      {identityCards.map((card) => (
        <FactCard
          key={card.title}
          card={card}
          icon={<MessageSquare size={16} />}
        />
      ))}

      {/* Timeline / timing */}
      <div className={styles.card}>
        <h3 className={styles.cardTitle}>
          <Clock size={16} className={styles.cardTitleIcon} />
          Timeline
        </h3>
        <div className={styles.infoGrid}>
          <InfoItem label="Created">
            <span className={styles.infoValue}>{formatDate(call.created_at)}</span>
          </InfoItem>
          <InfoItem label="Answered">
            <span className={styles.infoValue}>
              {answered ? (
                formatDate(call.answered_at!)
              ) : (
                <span className={styles.infoValueMuted}>Not answered</span>
              )}
            </span>
          </InfoItem>
          <InfoItem label="Ended">
            <span className={styles.infoValue}>
              {call.ended_at ? (
                formatDate(call.ended_at)
              ) : (
                <span className={styles.infoValueMuted}>--</span>
              )}
            </span>
          </InfoItem>
          <InfoItem label="Duration (total)">
            <span className={styles.infoValueMono}>{formatDuration(call.duration_seconds)}</span>
          </InfoItem>
          <InfoItem label="Talk Time (billed)">
            <span className={styles.infoValueMono}>
              {answered ? (
                formatDuration(call.talk_time_seconds)
              ) : (
                <span className={styles.infoValueMuted}>Not answered</span>
              )}
            </span>
          </InfoItem>
          {call.recording_duration_seconds != null && (
            <InfoItem label="Recording Length">
              <span className={styles.infoValueMono}>
                {formatDuration(call.recording_duration_seconds)}
              </span>
            </InfoItem>
          )}
        </div>
      </div>

      {/* Error details — only on a failed/unconnected call */}
      {isFailure && hasError && (
        <div className={styles.card}>
          <h3 className={styles.cardTitle}>
            <AlertTriangle size={16} style={{ color: 'var(--danger)' }} />
            Error Details
          </h3>
          {call.error_code && (
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--danger)',
                marginBottom: 6,
                fontFamily: 'var(--font-mono, monospace)',
              }}
            >
              {call.error_code}
            </div>
          )}
          {call.error_message && <div className={styles.errorBox}>{call.error_message}</div>}
        </div>
      )}

      {/* Recording */}
      <RecordingSection
        call={call}
        recordingEnabled={recordingEnabled}
        fetchRecording={fetchRecording}
      />

      {/* ── Call summary (dialer call analysis) ───────────────────────────
          All three blocks are capability-gated together. `skipped` and a
          null/absent status render nothing at all — a call nobody asked to
          summarize shouldn't grow a card explaining that. */}
      {analysisEnabled && call.analysis_status === 'completed' && call.call_analysis && (
        <AnalysisSection analysis={call.call_analysis} />
      )}

      {analysisEnabled && needsAnalysisStatusCard(call.analysis_status) && (
        <AnalysisStatusCard
          status={call.analysis_status!}
          callId={call.id}
          title={analysisTitle}
          messages={analysisMessages}
          retryLabel={retryLabel}
          // No handler ⇒ no button. Omitting one does NOT fall through to
          // `/proxy/calls/:id/retry-analysis` from here — see the header. Beyond that:
          // retryable from failed always, and from expired only when a recording
          // actually landed later, because the API 400s ANALYSIS_NO_RECORDING
          // otherwise and offering the button without one is a guaranteed dead end.
          canRetry={
            onRetryAnalysis !== undefined
            && (
              call.analysis_status === 'failed'
              || (call.analysis_status === 'expired' && Boolean(call.recording_url))
            )
          }
          onRetry={onRetryAnalysis}
          onRetryComplete={onReload}
        />
      )}

      {analysisEnabled && conversationLog && (
        <TranscriptSection
          entries={transcriptEntries}
          turnSentiments={call.call_analysis?.common?.turn_sentiments}
          // Diarization failed ⇒ pass NO labels and render turns unattributed.
          // A column of "Unknown" is worse than none. Applied HERE for every
          // consumer rather than asked of each one — see the note on the props.
          roleLabels={call.transcript_meta?.diarization_failed ? undefined : roleLabels}
        />
      )}

      {/* ── The transcript that aged out, said out loud ───────────────────
          The API's retention step nulls `conversation_log` on its own shorter
          window and leaves `analysis_status` at `completed`
          — so the section above simply vanished
          from under a summary still on screen, and a compliance reader concluded
          the call had never been transcribed. Agency deliberately gave itself a
          separate, longer transcript window, which makes this the state that
          surface exists to explain.

          `completed` is the unambiguous signal rather than a guess: it is only
          ever written after `persistTranscript` has stored the turns (the API's
          `dialer-analysis-job.repository.ts`), so a completed summary with no
          turns means there WERE turns and they have been deleted. */}
      {analysisEnabled && !conversationLog && call.analysis_status === 'completed' && (
        <div className={styles.card} data-testid="transcript-purged">
          <h3 className={styles.cardTitle}>
            <MessageSquare size={16} className={styles.cardTitleIcon} />
            Transcript
          </h3>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {TRANSCRIPT_PURGED_MESSAGE}
          </div>
        </div>
      )}
    </div>
  );
}


/** Map a recording's MIME type to a download file extension. */
function extensionForMime(mimeType: string | null): string {
  if (mimeType?.includes('wav')) return 'wav';
  if (mimeType?.includes('ogg')) return 'ogg';
  return 'mp3';
}

/**
 * Why there is nothing to play, one sentence each.
 *
 * These four were one sentence — "Recording not available." — which is the one
 * answer that helps with none of them: it reads as a fault on a call that aged
 * out exactly as the retention policy says it should, and as an outage on an
 * entitlement the account simply does not hold.
 */
const RECORDING_ABSENCE_COPY = {
  purged: 'The recording for this call has passed its retention window and been deleted.',
  not_recorded: 'This call was not recorded.',
  /** Also said BEFORE any fetch — the API withholds the url, so there is nothing to ask for. */
  forbidden:
    'This call was recorded, but playing recordings is not enabled for this account. '
    + 'An admin can turn it on.',
  unreachable:
    'We could not reach the service that stores this recording. The call itself is fine — '
    + 'try again in a few minutes.',
} as const satisfies Record<Exclude<RecordingOutcome['status'], 'ready'>, string>;

function RecordingSection({
  call,
  recordingEnabled,
  fetchRecording,
}: {
  call: WebRtcCallRecord;
  recordingEnabled: boolean;
  fetchRecording: RecordingFetcher;
}) {
  const { tenantId, accountId } = useTenant();
  const [outcome, setOutcome] = useState<RecordingOutcome | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasRecording = Boolean(call.recording_url);
  /**
   * An absolute `recording_url` means the API handed us a public provider file
   * (VoiceLink/Elision) rather than one of its own proxy paths, because its
   * egress is firewalled off from that host — so the browser plays it as-is and
   * no fetch of ours is involved. A relative value is a proxy path and goes
   * through the injected fetcher, which supplies auth headers. The API decides
   * which we get (`resolveClientRecordingUrl`); this side only has to notice.
   */
  const isDirectUrl = /^https?:\/\//i.test(call.recording_url ?? '');

  const load = useCallback(async () => {
    if (!tenantId || !accountId || !hasRecording || isDirectUrl) return;
    setLoading(true);
    setError(null);
    try {
      // `null` is kept as null: it means the caller could not say why, and the
      // render below has an unqualified sentence for exactly that.
      setOutcome(await fetchRecording(tenantId, accountId));
    } catch {
      setError('Failed to load recording');
    } finally {
      setLoading(false);
    }
  }, [tenantId, accountId, hasRecording, isDirectUrl, fetchRecording]);

  useEffect(() => {
    if (hasRecording && !isDirectUrl) load();
  }, [load, hasRecording, isDirectUrl]);

  const blobUrl = outcome?.status === 'ready' ? outcome.url : null;
  const playUrl = isDirectUrl ? call.recording_url : blobUrl;

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  const header = (extra?: React.ReactNode) => (
    <h3 className={styles.cardTitle}>
      <Mic size={16} className={styles.cardTitleIcon} />
      Recording
      {extra}
    </h3>
  );

  const note = (text: string) => (
    <div className={styles.card}>
      {header()}
      <div style={{ fontSize: 13, color: 'var(--text-muted)' }} data-testid="recording-note">
        {text}
      </div>
    </div>
  );

  // (d) Recording was never enabled for this call — subtle note, keep the section.
  if (!hasRecording && !call.recording_requested) {
    return note('Recording was not enabled for this call.');
  }

  /*
   * (c) Requested, and this product may not play it.
   *
   * Checked BEFORE the "still processing" branch, because from here the two are
   * indistinguishable: the API nulls `recording_url` on the capability and leaves
   * `recording_requested` true, so "check back soon" was being promised for a
   * recording that is never coming.
   */
  if (!hasRecording && !recordingEnabled) {
    return note(RECORDING_ABSENCE_COPY.forbidden);
  }

  // (b) Recording requested but not yet available — processing / unavailable note.
  if (!hasRecording) {
    return note(
      "A recording was requested for this call but isn't available yet. It can take a short "
      + 'while to finalize after the call ends — check back soon.',
    );
  }

  // (a) There is a recording to fetch — the player, or why the fetch found nothing.
  return (
    <div className={styles.card}>
      {header(
        playUrl && (
          <a
            href={playUrl}
            download={`recording_${call.id}.${extensionForMime(
              outcome?.status === 'ready' ? outcome.mimeType : null,
            )}`}
            // Browsers ignore `download` on a cross-origin href and navigate
            // instead, which would tear the SPA down to show the audio file. A
            // blob URL is same-origin and downloads in place, keeping its name.
            {...(isDirectUrl ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            className={styles.downloadBtn}
          >
            <Download size={13} />
            Download
          </a>
        ),
      )}
      {/*
        * The direct case is checked FIRST, before `loading`/`error`. This section
        * is not remounted when the route's `:id` changes — same element type, so
        * React keeps its state — which means a spinner or a "failed to load" from
        * the previously-viewed call can still be sitting in state. Those belong to
        * a fetch that has nothing to do with a URL the browser can just play, and
        * gating on them would hide a working recording behind a stale failure.
        */}
      {isDirectUrl && playUrl ? (
        <AudioWaveform src={playUrl} />
      ) : loading ? (
        <div style={{ padding: '16px 0' }}>
          <LoadingSpinner size="sm" />
        </div>
      ) : error ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}><ErrorText message={error} /></div>
      ) : outcome === null ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Recording not available.</div>
      ) : outcome.status === 'ready' ? (
        <AudioWaveform src={outcome.url} />
      ) : (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }} data-testid="recording-note">
          {RECORDING_ABSENCE_COPY[outcome.status]}
        </div>
      )}
    </div>
  );
}
