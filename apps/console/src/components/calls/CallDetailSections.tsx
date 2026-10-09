import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BarChart3,
  MessageSquare,
  AlertTriangle,
  RefreshCw,
  Mic,
  Download,
} from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { retryAnalysis, fetchRecordingBlobUrl } from '../../api/calls';
import { LoadingSpinner } from '../common';
import { ErrorText } from '../common/ErrorText';
import { AudioWaveform } from '../audio/AudioWaveform';
import type { CallAnalysisResult, ConversationEntry } from '../../types/call';
import { loadTranscriptVisible, saveTranscriptVisible } from '../../utils/transcript-prefs';
// Shared with the call detail page — reused as-is so the extracted sections
// render identically whether mounted on the Calls page or the IVR session page.
import styles from '../../pages/calls/CallDetailPage.module.css';
import {
  ANALYSIS_STATUS_MESSAGES,
  getSentimentColor,
} from '../../utils/vocabulary';

// Re-exported for the existing importers of this module; the implementation now
// lives in the shared vocabulary so list pages can use it without importing a
// colour helper out of a detail-page module.
export { getSentimentColor };

export function InfoItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.infoItem}>
      <span className={styles.infoLabel}>{label}</span>
      {children}
    </div>
  );
}

export function AnalysisSection({ analysis }: { analysis: CallAnalysisResult }) {
  // Support both nested (common/custom) and legacy flat shape
  const common = analysis.common;
  const summary = common?.summary ?? analysis.summary;
  const sentiment = common?.overall_sentiment ?? analysis.overall_sentiment;
  const topics = common?.key_topics ?? analysis.key_topics;
  const quality = common?.conversation_quality ?? analysis.conversation_quality;
  const custom = analysis.custom ?? analysis.custom_dimensions;
  const meta = analysis._meta;

  return (
    <div className={styles.card}>
      <h3 className={styles.cardTitle}>
        <BarChart3 size={16} className={styles.cardTitleIcon} />
        Call Analysis
        {meta?.model && (
          <span className={styles.analysisMeta}>
            {meta.provider}/{meta.model} &middot; {meta.latency_ms ? `${(meta.latency_ms / 1000).toFixed(1)}s` : ''}
          </span>
        )}
      </h3>

      {summary && (
        <div className={styles.summaryText}>{summary}</div>
      )}

      <div className={styles.analysisGrid}>
        {sentiment && (
          <div className={styles.analysisBlock}>
            <span className={styles.analysisBlockLabel}>Overall Sentiment</span>
            <div className={styles.sentimentRow}>
              <span
                className={styles.sentimentLabel}
                style={{ color: getSentimentColor(sentiment.label) }}
              >
                {sentiment.label}
              </span>
              <div className={styles.sentimentBarOuter}>
                <div
                  className={styles.sentimentBarInner}
                  style={{
                    width: `${Math.max(5, Math.abs(sentiment.score) * 100)}%`,
                    background: getSentimentColor(sentiment.label),
                  }}
                />
              </div>
              <span className={styles.sentimentScore}>
                {sentiment.score}
              </span>
            </div>
          </div>
        )}

        {topics && topics.length > 0 && (
          <div className={styles.analysisBlock}>
            <span className={styles.analysisBlockLabel}>Key Topics</span>
            <div className={styles.topicsContainer}>
              {topics.map((topic) => (
                <span key={topic} className={styles.topicChip}>
                  {topic}
                </span>
              ))}
            </div>
          </div>
        )}

        {quality && Object.keys(quality).length > 0 && (
          <div className={styles.analysisBlock}>
            <span className={styles.analysisBlockLabel}>Conversation Quality</span>
            {Object.entries(quality).map(([key, value]) => {
              const isBoolean = typeof value === 'boolean';
              const numValue = typeof value === 'number' ? value : 0;
              return (
                <div key={key} className={styles.qualityItem}>
                  <div className={styles.qualityHeader}>
                    <span className={styles.qualityLabel}>{key.replace(/_/g, ' ')}</span>
                    <span className={styles.qualityPercent}>
                      {isBoolean ? (value ? 'Yes' : 'No') : numValue <= 1 ? `${Math.round(numValue * 100)}%` : `${numValue}/10`}
                    </span>
                  </div>
                  {!isBoolean && (
                    <div className={styles.qualityBarOuter}>
                      <div
                        className={styles.qualityBarInner}
                        style={{ width: `${numValue <= 1 ? numValue * 100 : numValue * 10}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {custom && Object.keys(custom).length > 0 && (
          <div className={styles.analysisBlock}>
            <span className={styles.analysisBlockLabel}>Custom Dimensions</span>
            <div className={styles.dimensionsList}>
              {Object.entries(custom).map(([key, value]) => (
                <div key={key} className={styles.dimensionRow}>
                  <span className={styles.dimensionKey}>
                    {key.replace(/_/g, ' ')}
                  </span>
                  <span className={styles.dimensionValue}>
                    {String(value)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Roles that are "our side" of the conversation, styled as the assistant lane:
 * the generic `assistant` role, or the human `agent` on a dialer call. Everything else
 * (the person we called) uses the user lane.
 */
const OUR_SIDE_ROLES: ReadonlySet<string> = new Set(['assistant', 'agent']);

/**
 * Display label for a turn's role. With no `roleLabels` map the raw role is used
 * (`assistant`/`user` read fine unchanged). With a map, an unmapped role renders
 * NO label rather than a raw token — which is how "diarization failed" degrades
 * to unattributed turns instead of a column of "unknown".
 */
function resolveRoleLabel(
  role: string,
  roleLabels: { [role: string]: string } | undefined,
): string | null {
  if (!roleLabels) return role;
  return roleLabels[role] ?? null;
}

/**
 * One transcript turn, generalized over both role vocabularies: the generic
 * `assistant`/`user`, and a dialer (human↔human) call's `agent`/`customer`/`unknown`.
 */
export interface TranscriptSectionEntry extends Omit<ConversationEntry, 'role'> {
  role: string;
}

interface TranscriptSectionProps {
  entries: TranscriptSectionEntry[];
  turnSentiments?: Array<{ turn_index: number; role: string; sentiment: { label: string; score: number } }>;
  /** Currently active turn index (synced from audio playback) */
  activeIndex?: number;
  /**
   * Display labels per raw role, e.g. `{ agent: 'Agent', customer: 'Customer' }`.
   * Omit to fall back to the raw role (the generic `assistant`/`user` read fine
   * as-is). Pass NOTHING when diarization failed: every turn would be labelled
   * "Unknown", and a column of "Unknown" is worse than no labels at all.
   */
  roleLabels?: { [role: string]: string };
}

export function TranscriptSection({ entries, turnSentiments, activeIndex, roleLabels }: TranscriptSectionProps) {
  const activeRef = useRef<HTMLDivElement>(null);
  // Per-user display preference (localStorage). Read lazily on mount so the
  // stored choice applies without a flash of the transcript, and persisted on
  // every change so the user is never asked again.
  const [visible, setVisible] = useState<boolean>(loadTranscriptVisible);

  const handleVisibleChange = useCallback((next: boolean) => {
    setVisible(next);
    saveTranscriptVisible(next);
  }, []);

  // Auto-scroll to active turn during playback. Skipped while the transcript is
  // hidden — there is no rendered turn to scroll to (activeRef is unmounted).
  useEffect(() => {
    if (visible && activeIndex != null && activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeIndex, visible]);

  // Shared across the empty / hidden / populated states so the toggle is always
  // reachable — including when there are no entries yet.
  const header = (
    <h3 className={styles.cardTitle}>
      <MessageSquare size={16} className={styles.cardTitleIcon} />
      Transcript
      {entries.length > 0 && (
        <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12, marginLeft: 4 }}>
          ({entries.length} turns)
        </span>
      )}
      <label className={styles.transcriptToggle}>
        <input
          type="checkbox"
          className={styles.transcriptToggleInput}
          checked={visible}
          onChange={(e) => handleVisibleChange(e.target.checked)}
        />
        <span className={styles.transcriptToggleTrack} aria-hidden="true">
          <span className={styles.transcriptToggleThumb} />
        </span>
        <span>Show transcript</span>
      </label>
    </h3>
  );

  if (!visible) {
    return (
      <div className={styles.card}>
        {header}
        <p className={styles.transcriptHidden}>
          Transcript hidden. Turn on “Show transcript” to view it.
        </p>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className={styles.card}>
        {header}
        <p className={styles.transcriptHidden}>
          No conversation entries recorded.
        </p>
      </div>
    );
  }

  const sentimentMap = new Map(
    (turnSentiments ?? []).map(ts => [ts.turn_index, ts.sentiment])
  );

  return (
    <div className={styles.card}>
      {header}
      <div className={styles.transcript}>
        {entries.map((entry, idx) => {
          const sentiment = sentimentMap.get(idx);
          const isActive = activeIndex === idx;
          const roleLabel = resolveRoleLabel(entry.role, roleLabels);
          return (
            <div
              key={idx}
              ref={isActive ? activeRef : undefined}
              className={`${styles.messageRow} ${isActive ? styles.messageRowActive : ''}`}
            >
              {roleLabel && (
                <span
                  className={`${styles.messageRole} ${
                    OUR_SIDE_ROLES.has(entry.role) ? styles.roleAssistant : styles.roleUser
                  }`}
                >
                  {roleLabel}
                </span>
              )}
              <div className={styles.messageBody}>
                <p className={styles.messageContent}>{entry.content}</p>
                <div className={styles.messageMeta}>
                  {sentiment && (
                    <span
                      className={styles.sentimentIndicator}
                      style={{ color: getSentimentColor(sentiment.label) }}
                      title={`Sentiment: ${sentiment.label} (${sentiment.score})`}
                    >
                      {sentiment.label}
                    </span>
                  )}
                  {entry.language && (
                    <span className={styles.langBadge}>{entry.language}</span>
                  )}
                  {entry.timestamp && (
                    <span className={styles.messageTimestamp}>
                      {new Date(entry.timestamp).toLocaleTimeString('en-IN', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Statuses whose copy is "we're still working" — rendered with a spinner. */
const WORKING_ANALYSIS_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'awaiting_recording',
]);

interface AnalysisStatusCardProps {
  status: string;
  callId: string;
  onRetryComplete: () => void;
  /**
   * Override the retry action. Defaults to `retryAnalysis`
   * (`POST /proxy/calls/:id/retry-analysis`, which reads the `calls` table); a
   * caller with its own route passes it here.
   */
  onRetry?: () => Promise<void>;
  /** Card heading. Dialer surfaces use plainer wording ("Call summary"). */
  title?: string;
  /** Per-status copy override, merged over the defaults. */
  messages?: Record<string, string>;
  /** Retry button text. */
  retryLabel?: string;
  /**
   * Whether to offer Retry. Defaults to `failed` only — the dialer also allows it
   * from `expired`, but ONLY when a recording actually exists (the API 400s with
   * ANALYSIS_NO_RECORDING otherwise), which the caller alone can determine.
   */
  canRetry?: boolean;
}

/** Default per-status copy — the existing AI-call wording, unchanged. */
const DEFAULT_ANALYSIS_MESSAGES: Record<string, string> = {
  failed: 'Post-call analysis failed. You can retry generating the analysis.',
  pending: 'Analysis is in progress...',
  awaiting_recording: ANALYSIS_STATUS_MESSAGES.awaiting_recording!,
  expired: ANALYSIS_STATUS_MESSAGES.expired!,
  deleted: ANALYSIS_STATUS_MESSAGES.deleted!,
};

export function AnalysisStatusCard({
  status,
  callId,
  onRetryComplete,
  onRetry,
  title = 'Call Analysis',
  messages,
  retryLabel = 'Retry Analysis',
  canRetry,
}: AnalysisStatusCardProps) {
  const { tenantId, accountId } = useTenant();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const handleRetry = async () => {
    if (!onRetry && !tenantId) return;
    setRetrying(true);
    setRetryError(null);
    try {
      if (onRetry) {
        await onRetry();
      } else {
        await retryAnalysis(tenantId!, callId, accountId ?? undefined);
      }
      onRetryComplete();
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setRetrying(false);
    }
  };

  const copy = { ...DEFAULT_ANALYSIS_MESSAGES, ...messages }[status];
  const working = WORKING_ANALYSIS_STATUSES.has(status);
  const showRetry = canRetry ?? status === 'failed';

  return (
    <div className={`${styles.card} ${styles.analysisStatusCard}`}>
      <h3 className={styles.cardTitle}>
        <BarChart3 size={16} className={styles.cardTitleIcon} />
        {title}
      </h3>
      {working ? (
        <div className={styles.analysisStatusBox} role="status" aria-atomic="true">
          <div className={styles.analysisStatusPending}>
            <LoadingSpinner size="sm" decorative />
            {copy}
          </div>
        </div>
      ) : copy || showRetry ? (
        <div className={styles.analysisStatusBox}>
          {copy && (
            <div className={styles.analysisStatusFailed}>
              <AlertTriangle size={16} />
              {copy}
            </div>
          )}
          {retryError && (
            <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{retryError}</p>
          )}
          {showRetry && (
            <button
              className="btn-primary"
              onClick={handleRetry}
              disabled={retrying}
              style={{ marginTop: 12 }}
            >
              <RefreshCw size={14} />
              {retrying ? 'Retrying...' : retryLabel}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function RecordingSection({
  callId,
  recordingUrl,
  onTimeUpdate,
}: {
  callId: string;
  /**
   * The `recording_url` from the call record. When it's an absolute URL
   * (`https://…`) the provider serves a public, directly-playable recording
   * (e.g. VoiceLink/Elision) — the browser plays it as-is, bypassing the
   * server-side proxy (which our cloud egress may be firewalled from reaching).
   * Otherwise it's the relative proxy path and we blob-fetch through the API
   * with auth headers (Twilio/VoBiz, whose upstream needs our credentials).
   */
  recordingUrl: string;
  onTimeUpdate?: (currentTime: number) => void;
}) {
  const { tenantId, accountId } = useTenant();
  const isDirectUrl = /^https?:\/\//i.test(recordingUrl);
  const [blobUrl, setBlobUrl] = useState<string | null>(isDirectUrl ? recordingUrl : null);
  const [loading, setLoading] = useState(!isDirectUrl);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (isDirectUrl) return; // Direct URL is played as-is; no proxy fetch needed.
    if (!tenantId || !accountId) return;
    setLoading(true);
    setError(null);
    try {
      const url = await fetchRecordingBlobUrl(tenantId, callId, accountId);
      setBlobUrl(url);
    } catch {
      setError('Failed to load recording');
    } finally {
      setLoading(false);
    }
  }, [tenantId, accountId, callId, isDirectUrl]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    // Only object URLs created via createObjectURL need revoking; a direct
    // provider URL is a plain string and must not be revoked.
    return () => {
      if (blobUrl && !isDirectUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl, isDirectUrl]);

  // A cross-origin href makes browsers ignore `download` and navigate instead,
  // which would tear the SPA down to show the audio file. Open a direct provider
  // link in a new tab; a blob URL is same-origin and downloads in place, so it
  // keeps the plain in-tab behaviour (and its `download` filename).
  const downloadTargetProps = isDirectUrl
    ? ({ target: '_blank', rel: 'noopener noreferrer' } as const)
    : {};

  return (
    <div className={styles.card}>
      <h3 className={styles.cardTitle}>
        <Mic size={16} className={styles.cardTitleIcon} />
        Recording
        {blobUrl && (
          <a
            href={blobUrl}
            download={`recording_${callId}.wav`}
            {...downloadTargetProps}
            className={styles.downloadBtn}
          >
            <Download size={13} />
            Download
          </a>
        )}
      </h3>
      {loading ? (
        <div style={{ padding: '16px 0' }}>
          <LoadingSpinner size="sm" />
        </div>
      ) : error ? (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}><ErrorText message={error} /></div>
      ) : blobUrl ? (
        <AudioWaveform src={blobUrl} onTimeUpdate={onTimeUpdate} />
      ) : (
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Recording not available.</div>
      )}
    </div>
  );
}
