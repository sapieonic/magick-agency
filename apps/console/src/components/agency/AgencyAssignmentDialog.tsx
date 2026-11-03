import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { commitAssignment, previewAssignment } from '../../api/agencyAssignment';
import { useTenant } from '../../contexts/TenantContext';
import { useModalFocus } from '../../hooks/useModalFocus';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { errorCode } from '../../utils/agencyErrors';
import {
  trackAgencyAssignmentCommitted,
  trackAgencyAssignmentPreviewed,
  trackAgencyAssignmentRefused,
} from '../../analytics/events';
import {
  ASSIGNMENT_KIND_COPY,
  ASSIGNMENT_REFUSAL_COPY,
  CONTACT_BUCKET_LABELS,
  previewSentence,
} from '../../utils/agencyAssignmentCopy';
import {
  buildOperation,
  emptyDraft,
  operationAgentCount,
  splitValues,
  stalePreviewOf,
  withPreviewSeed,
  type AssignmentDraft,
} from '../../utils/agencyAssignmentOps';
import { CONTACT_STATE_LABELS } from '../../types/agency-spine';
import type {
  AgencyAssignmentErrorCode,
  AgencyAssignmentKind,
  AgencyAssignmentPreview,
  AgencyAssignmentResult,
} from '@magick-agency/contracts/api/agency/assignment';
import frame from './AgencyRetryDialog.module.css';
import styles from './AgencyAssignmentDialog.module.css';

/**
 * One assignment operation, previewed, then committed.
 *
 * ── Why a preview first ─────────────────────────────────────────────────────
 * An operation moves contacts between agents by rule, over the whole campaign,
 * not over the rows on screen — "split the pool across these four" can move
 * thousands. So the supervisor sees what it would do (per agent, and what will
 * NOT move: contacts on a call, contacts already with their target) before
 * anything is written. The commit sends the preview's token, and the seed of a
 * random split, so what is committed is what was shown.
 *
 * ── When the roster moved underneath ────────────────────────────────────────
 * The server recomputes on commit and refuses `409 preview_stale` with the fresh
 * preview when the result would differ. That preview replaces the one on screen
 * and the supervisor confirms again; nothing is committed that they did not see.
 *
 * Modelled on `AgencyRetryDialog` and wearing its frame (same overlay, header,
 * body and footer), the product's one modal idiom for "preview, then commit".
 * Unlike a retry campaign, an assignment is undoable (reassign it back), so the
 * commit is an ordinary button rather than a press-and-hold.
 *
 * Only staffed agents are offered as targets: the server refuses any other
 * (`agent_not_staffed`), so offering one would be a control that fails.
 */

export interface AssignmentAgentOption {
  user_id: string;
  name: string;
}

export interface AgencyAssignmentDialogProps {
  campaignId: string;
  kind: AgencyAssignmentKind;
  /** Staffed agents: the only legal targets. */
  agents: readonly AssignmentAgentOption[];
  /** Agents whose contacts may move (`reassign` / `unassign` sources): staffed or not. */
  owners?: readonly AssignmentAgentOption[];
  /** A display name for any agent id in a preview line (a former member included). */
  agentName: (userId: string) => string;
  /** The roster's ticked rows, in on-screen order. */
  selectedIds?: readonly string[];
  /** The campaign's outcome codes, for the filter's "last outcome". */
  dispositionOptions?: ReadonlyArray<{ code: string; label: string }>;
  /** Fields filled in on open, e.g. the progress table's "Reassign…" names the agent. */
  prefill?: Partial<AssignmentDraft>;
  origin: 'roster' | 'progress';
  onClose: () => void;
  onCommitted: (result: AgencyAssignmentResult) => void;
}

/** A refusal in the console's words: ours for a known code, the server's otherwise. */
function refusal(err: unknown, fallback: string): string {
  const code = errorCode(err) as AgencyAssignmentErrorCode | null;
  return code && code in ASSIGNMENT_REFUSAL_COPY ? ASSIGNMENT_REFUSAL_COPY[code] : getErrorMessage(err, fallback);
}

/** The commit button's word for each kind. */
const COMMIT_LABEL: Record<AgencyAssignmentKind, string> = {
  random_split: 'Assign',
  count: 'Assign',
  filter: 'Assign',
  range: 'Assign',
  reassign: 'Reassign',
  unassign: 'Unassign',
  rebalance: 'Rebalance',
};

export function AgencyAssignmentDialog({
  campaignId,
  kind,
  agents,
  owners,
  agentName,
  selectedIds = [],
  dispositionOptions = [],
  prefill,
  origin,
  onClose,
  onCommitted,
}: AgencyAssignmentDialogProps) {
  const { tenantId, accountId } = useTenant();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<AssignmentDraft>(() => emptyDraft(kind, {
    ...(kind === 'unassign' && selectedIds.length > 0 ? { unassignSource: 'selected' as const } : {}),
    ...prefill,
  }));
  const [preview, setPreview] = useState<AgencyAssignmentPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The server answered `preview_stale`: the preview on screen is the fresh one. */
  const [stale, setStale] = useState(false);
  const busy = previewing || committing;

  const built = useMemo(() => buildOperation(draft, selectedIds), [draft, selectedIds]);
  const sources = owners ?? agents;

  /** Any edit invalidates the preview: a commit always matches the numbers on screen. */
  const update = useCallback((patch: Partial<AssignmentDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setPreview(null);
    setStale(false);
    setError(null);
  }, []);

  useModalFocus(true, dialogRef);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  const onPreview = useCallback(async () => {
    if (!built.ok || !tenantId || !accountId) return;
    setPreviewing(true);
    setError(null);
    setStale(false);
    try {
      const result = await previewAssignment(campaignId, built.operation, tenantId, accountId);
      setPreview(result);
      trackAgencyAssignmentPreviewed({
        campaign_id: campaignId,
        kind: built.operation.kind,
        origin,
        agent_count: operationAgentCount(built.operation),
        group_same_number: draft.groupSameNumber,
        matched: result.matched,
        moving: result.moving,
        skipped_live: result.skipped_live,
      });
    } catch (err: unknown) {
      setPreview(null);
      setError(refusal(err, 'Could not work out what this would change.'));
    } finally {
      setPreviewing(false);
    }
  }, [built, tenantId, accountId, campaignId, origin, draft.groupSameNumber]);

  const onCommit = useCallback(async () => {
    if (!built.ok || !preview || !tenantId || !accountId) return;
    setCommitting(true);
    setError(null);
    const operation = withPreviewSeed(built.operation, preview);
    try {
      const result = await commitAssignment(
        campaignId,
        { operation, preview_token: preview.preview_token },
        tenantId,
        accountId,
      );
      trackAgencyAssignmentCommitted({
        campaign_id: campaignId,
        kind: operation.kind,
        origin,
        agent_count: operationAgentCount(operation),
        moved: result.moved,
        skipped_live: result.skipped_live,
        unchanged: result.unchanged,
        to_pool: result.to_pool,
        after_stale: stale,
      });
      onCommitted(result);
    } catch (err: unknown) {
      trackAgencyAssignmentRefused({ campaign_id: campaignId, kind: operation.kind, code: errorCode(err) });
      const fresh = stalePreviewOf(err);
      if (fresh) {
        setPreview(fresh);
        setStale(true);
      } else {
        setError(refusal(err, 'Nothing was changed.'));
      }
    } finally {
      setCommitting(false);
    }
  }, [built, preview, tenantId, accountId, campaignId, origin, stale, onCommitted]);

  const copy = ASSIGNMENT_KIND_COPY[draft.kind];
  const canCommit = preview !== null && preview.moving > 0 && !busy;

  const agentPicker = (label: string, value: string, onPick: (id: string) => void, from = agents, testId?: string) => (
    <div className={frame.field}>
      <label className={frame.label} htmlFor={`assign-${testId ?? label}`}>{label}</label>
      <select
        id={`assign-${testId ?? label}`}
        className={frame.input}
        value={value}
        onChange={(event) => onPick(event.target.value)}
        disabled={busy}
        data-testid={testId}
      >
        <option value="">Choose an agent…</option>
        {from.map((agent) => (
          <option key={agent.user_id} value={agent.user_id}>{agent.name}</option>
        ))}
      </select>
    </div>
  );

  const agentChecklist = (
    <fieldset className={styles.fieldset} disabled={busy} data-testid="assign-agents">
      <legend className={frame.label}>Agents</legend>
      {agents.length === 0 ? (
        <p className={styles.note}>Nobody is staffed on this campaign. Add agents on the Agents tab first.</p>
      ) : (
        <div className={styles.options}>
          {agents.map((agent) => (
            <label key={agent.user_id} className={styles.option}>
              <input
                type="checkbox"
                checked={draft.agentIds.includes(agent.user_id)}
                onChange={(event) => update({
                  agentIds: event.target.checked
                    ? [...draft.agentIds, agent.user_id]
                    : draft.agentIds.filter((id) => id !== agent.user_id),
                })}
              />
              {agent.name}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );

  const countBox = (label: string, hint?: string) => (
    <div className={frame.field}>
      <label className={frame.label} htmlFor="assign-count">{label}</label>
      <input
        id="assign-count"
        className={frame.input}
        inputMode="numeric"
        value={draft.count}
        onChange={(event) => update({ count: event.target.value })}
        disabled={busy}
        placeholder={hint}
      />
    </div>
  );

  const onlyUnassignedBox = (
    <label className={styles.option}>
      <input
        type="checkbox"
        checked={draft.onlyUnassigned}
        onChange={(event) => update({ onlyUnassigned: event.target.checked })}
        disabled={busy}
      />
      Only contacts in the pool (leave assigned contacts where they are)
    </label>
  );

  return (
    <div
      className={frame.overlay}
      onClick={() => {
        if (!busy) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="agency-assignment-title"
      data-testid="assignment-dialog"
    >
      <div ref={dialogRef} className={frame.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={frame.header}>
          <div>
            <h2 className={frame.title} id="agency-assignment-title">{copy.label}</h2>
            <p className={frame.subtitle}>{copy.explain}</p>
          </div>
          <button type="button" className={frame.close} onClick={onClose} aria-label="Close" disabled={busy}>
            <X size={16} />
          </button>
        </div>

        <div className={frame.body}>
          {draft.kind === 'random_split' || draft.kind === 'rebalance' ? agentChecklist : null}
          {draft.kind === 'random_split' ? onlyUnassignedBox : null}

          {draft.kind === 'count' ? (
            <>
              {agentPicker('Agent', draft.agentId, (agentId) => update({ agentId }), agents, 'assign-agent')}
              {countBox('How many contacts')}
            </>
          ) : null}

          {draft.kind === 'range' ? (
            <>
              <p className={frame.cohort} data-testid="assign-selected-count">
                {`${selectedIds.length.toLocaleString()} selected row${selectedIds.length === 1 ? '' : 's'}.`}
              </p>
              {agentPicker('Give them to', draft.agentId, (agentId) => update({ agentId }), agents, 'assign-agent')}
            </>
          ) : null}

          {draft.kind === 'filter' ? (
            <>
              <fieldset className={styles.fieldset} disabled={busy}>
                <legend className={frame.label}>Contacts in these states</legend>
                <div className={styles.options}>
                  {Object.entries(CONTACT_STATE_LABELS).map(([value, label]) => (
                    <label key={value} className={styles.option}>
                      <input
                        type="checkbox"
                        checked={draft.filterStates.includes(value)}
                        onChange={(event) => update({
                          filterStates: event.target.checked
                            ? [...draft.filterStates, value]
                            : draft.filterStates.filter((v) => v !== value),
                        })}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
              {dispositionOptions.length > 0 ? (
                <fieldset className={styles.fieldset} disabled={busy}>
                  <legend className={frame.label}>Last outcome</legend>
                  <div className={styles.options}>
                    {dispositionOptions.map((entry) => (
                      <label key={entry.code} className={styles.option}>
                        <input
                          type="checkbox"
                          checked={draft.filterDispositions.includes(entry.code)}
                          onChange={(event) => update({
                            filterDispositions: event.target.checked
                              ? [...draft.filterDispositions, entry.code]
                              : draft.filterDispositions.filter((v) => v !== entry.code),
                          })}
                        />
                        {entry.label || entry.code}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              <div className={frame.windowRow}>
                <div className={frame.field}>
                  <label className={frame.label} htmlFor="assign-column">Column (as in your file)</label>
                  <input
                    id="assign-column"
                    className={frame.input}
                    value={draft.columnName}
                    onChange={(event) => update({ columnName: event.target.value })}
                    placeholder="e.g. Region"
                    disabled={busy}
                  />
                </div>
                <div className={frame.field}>
                  <label className={frame.label} htmlFor="assign-column-values">Equals one of</label>
                  <input
                    id="assign-column-values"
                    className={frame.input}
                    value={draft.columnValues}
                    onChange={(event) => update({ columnValues: event.target.value })}
                    placeholder="North, East"
                    disabled={busy}
                  />
                </div>
              </div>
              {draft.columnName.trim() && splitValues(draft.columnValues).length > 0 ? (
                <p className={styles.note}>Values must match exactly, after trimming spaces.</p>
              ) : null}
              {agentChecklist}
              {draft.agentIds.length > 1 ? (
                <p className={styles.note}>Split evenly at random across the agents you picked.</p>
              ) : null}
              {onlyUnassignedBox}
            </>
          ) : null}

          {draft.kind === 'reassign' ? (
            <>
              {agentPicker('From', draft.fromId, (fromId) => update({ fromId }), sources, 'assign-from')}
              {agentPicker('To', draft.agentId, (agentId) => update({ agentId }), agents, 'assign-to')}
              {countBox('How many (blank for all their open contacts)', 'All')}
            </>
          ) : null}

          {draft.kind === 'unassign' ? (
            <>
              <fieldset className={styles.fieldset} disabled={busy}>
                <legend className={frame.label}>Which contacts</legend>
                <label className={styles.option}>
                  <input
                    type="radio"
                    name="unassign-source"
                    checked={draft.unassignSource === 'agent'}
                    onChange={() => update({ unassignSource: 'agent' })}
                  />
                  One agent’s open contacts
                </label>
                <label className={styles.option}>
                  <input
                    type="radio"
                    name="unassign-source"
                    checked={draft.unassignSource === 'selected'}
                    onChange={() => update({ unassignSource: 'selected' })}
                    disabled={selectedIds.length === 0}
                  />
                  {`The ${selectedIds.length.toLocaleString()} selected row${selectedIds.length === 1 ? '' : 's'}`}
                </label>
              </fieldset>
              {draft.unassignSource === 'agent' ? (
                <>
                  {agentPicker('Agent', draft.fromId, (fromId) => update({ fromId }), sources, 'assign-from')}
                  {countBox('How many (blank for all their open contacts)', 'All')}
                </>
              ) : null}
            </>
          ) : null}

          <label className={styles.option}>
            <input
              type="checkbox"
              checked={draft.groupSameNumber}
              onChange={(event) => update({ groupSameNumber: event.target.checked })}
              disabled={busy}
              data-testid="assign-group-same-number"
            />
            Keep same number together
          </label>

          <div className={frame.countBlock} aria-live="polite">
            {!built.ok ? (
              <p className={frame.counting} data-testid="assign-incomplete">{built.reason}</p>
            ) : previewing ? (
              <p className={frame.counting}>Working it out…</p>
            ) : preview ? (
              <PreviewBlock preview={preview} stale={stale} agentName={agentName} />
            ) : (
              <p className={frame.counting}>Preview to see what this changes before anything moves.</p>
            )}
          </div>

          {error ? (
            <p className={frame.submitError} role="alert" data-testid="assign-error">{error}</p>
          ) : null}
        </div>

        <div className={frame.footer}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void onPreview()}
            disabled={!built.ok || busy}
            data-testid="assign-preview"
          >
            {preview ? 'Preview again' : 'Preview'}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void onCommit()}
            disabled={!canCommit}
            title={preview && preview.moving === 0 ? 'Nothing would move.' : undefined}
            data-testid="assign-commit"
          >
            {committing ? 'Saving…' : stale ? `${COMMIT_LABEL[draft.kind]} — confirm again` : COMMIT_LABEL[draft.kind]}
          </button>
        </div>
      </div>
    </div>
  );
}

function PreviewBlock({
  preview,
  stale,
  agentName,
}: {
  preview: AgencyAssignmentPreview;
  stale: boolean;
  agentName: (userId: string) => string;
}) {
  return (
    <div data-testid="assign-preview-result">
      {stale ? (
        <p className={frame.parentRunning} data-testid="assign-stale">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{ASSIGNMENT_REFUSAL_COPY.preview_stale}</span>
        </p>
      ) : null}
      <p className={frame.count} data-testid="assign-sentence">{previewSentence(preview)}</p>
      <dl className={styles.stats}>
        <div><dt>Moving</dt><dd data-testid="assign-moving">{preview.moving.toLocaleString()}</dd></div>
        <div>
          <dt>{CONTACT_BUCKET_LABELS.in_progress} — won’t move</dt>
          <dd data-testid="assign-skipped-live">{preview.skipped_live.toLocaleString()}</dd>
        </div>
        <div><dt>Unchanged</dt><dd>{preview.unchanged.toLocaleString()}</dd></div>
        <div><dt>To the pool</dt><dd>{preview.to_pool.toLocaleString()}</dd></div>
        <div><dt>Same-number groups</dt><dd>{preview.same_number_groups.toLocaleString()}</dd></div>
      </dl>
      {preview.per_agent.length > 0 ? (
        <div className={frame.breakdown}>
          <h3 className={frame.breakdownTitle}>Per agent</h3>
          <ul className={frame.breakdownList}>
            {preview.per_agent.map((line) => (
              <li key={line.agent_user_id} className={frame.breakdownRow} data-testid={`assign-agent-${line.agent_user_id}`}>
                <span>{agentName(line.agent_user_id)}</span>
                <span className={frame.breakdownCount}>
                  {line.receiving > 0 ? `+${line.receiving.toLocaleString()}` : ''}
                  {line.receiving > 0 && line.giving > 0 ? ' / ' : ''}
                  {line.giving > 0 ? `−${line.giving.toLocaleString()}` : ''}
                  {line.receiving === 0 && line.giving === 0 ? '0' : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
