import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import {
  AGENCY_LATE_CALLBACKS_KIND,
  type AgencyLateCallbacksPreview,
  type AgencyLateCallbacksResult,
  type AgencyLateCallbacksToLiveAgents,
} from '@magick-agency/contracts/api/agency/assignment';
import { commitLateCallbacks, previewLateCallbacks } from '../../../api/agencyAssignment';
import { useTenant } from '../../../contexts/TenantContext';
import { useLatestRef } from '../../../hooks/useLatestRef';
import { useMountedRef } from '../../../hooks/useMountedRef';
import { errorCode } from '../../../utils/agencyErrors';
import { stalePreviewOf } from '../../../utils/agencyAssignmentOps';
import { ASSIGNMENT_REFUSAL_COPY, assignmentRefusal } from '../../../utils/agencyAssignmentCopy';
import {
  LATE_CALLBACKS_POOL_COPY,
  lateCallbacksQuestion,
  lateCallbacksReceivers,
  lateCallbacksResultText,
} from '../../../utils/agency/lateCallbacks';
import { formatCount, plural } from '../../../utils/format/number';
import styles from './LiveFloor.module.css';

/** The hand-off's operation: no agents named, the server picks the live ones (LF21). */
const OPERATION: AgencyLateCallbacksToLiveAgents = { kind: AGENCY_LATE_CALLBACKS_KIND };

type Step =
  | { kind: 'previewing' }
  | { kind: 'preview'; preview: AgencyLateCallbacksPreview; stale: boolean }
  | { kind: 'committing'; preview: AgencyLateCallbacksPreview; stale: boolean }
  | { kind: 'done'; result: AgencyLateCallbacksResult }
  | { kind: 'refused'; message: string };

/**
 * Give late callbacks to free agents (LF7, LF21, LF30): the late-callbacks row's action, on the
 * assignment routes like every operation. Opening it previews (`{ kind:
 * 'late_callbacks_to_live_agents' }`) and asks "Give 4 late callbacks to 2 free agents?", naming
 * the receivers (the preview's `per_agent` lines receiving any, not every free agent); Give commits with the preview's token; the result says what moved.
 *
 * - **The roster moved** (`409 preview_stale`, a second press included): the fresh preview replaces
 *   the one on screen, said so, and the supervisor confirms again; nothing is moved they did not see.
 * - **A `pool` campaign** (`409 late_callbacks_pool_mode`): not offered at all (the page reads each
 *   campaign's mode first); if the mode changed under the page, said so and `onPool` hides the action.
 * - **Assignment off** (`403 assignment_disabled`) and anything else: in words, nothing changed.
 */
export function LateCallbacksDialog({
  campaign,
  agentName,
  onClose,
  onGiven,
  onPool,
}: {
  campaign: { id: string; name: string };
  /** A display name for any agent id the preview names (the floor's names). */
  agentName: (userId: string) => string;
  onClose: () => void;
  /** Something moved: the page reads the board again. */
  onGiven: () => void;
  /** The server said the campaign is `pool`: the page stops offering the action on it. */
  onPool: (campaignId: string) => void;
}) {
  const { tenantId, accountId } = useTenant();
  const [step, setStep] = useState<Step>({ kind: 'previewing' });
  const mounted = useMountedRef();

  const refuse = useCallback((err: unknown, fallback: string) => {
    if (errorCode(err) !== 'late_callbacks_pool_mode') return assignmentRefusal(err, fallback);
    onPool(campaign.id);
    return LATE_CALLBACKS_POOL_COPY;
  }, [campaign.id, onPool]);

  // The preview, once per opening: a parent's new callbacks never preview it again.
  const refuseRef = useLatestRef(refuse);
  useEffect(() => {
    if (!tenantId || !accountId) return;
    previewLateCallbacks(campaign.id, OPERATION, tenantId, accountId)
      .then((preview) => {
        if (mounted.current) setStep({ kind: 'preview', preview, stale: false });
      })
      .catch((err: unknown) => {
        if (mounted.current) setStep({ kind: 'refused', message: refuseRef.current(err, 'Couldn’t work out which callbacks would move.') });
      });
  }, [campaign.id, tenantId, accountId, mounted, refuseRef]);

  const give = async () => {
    if (step.kind !== 'preview' || !tenantId || !accountId) return;
    const { preview, stale } = step;
    setStep({ kind: 'committing', preview, stale });
    try {
      const result = await commitLateCallbacks(campaign.id, { operation: OPERATION, preview_token: preview.preview_token }, tenantId, accountId);
      if (!mounted.current) return;
      setStep({ kind: 'done', result });
      if (result.moved > 0) onGiven();
    } catch (err: unknown) {
      if (!mounted.current) return;
      const fresh = stalePreviewOf(err) as AgencyLateCallbacksPreview | null;
      if (fresh) setStep({ kind: 'preview', preview: fresh, stale: true });
      else setStep({ kind: 'refused', message: refuse(err, 'Nothing was changed.') });
    }
  };

  const busy = step.kind === 'previewing' || step.kind === 'committing';
  const shown = step.kind === 'preview' || step.kind === 'committing' ? step : null;
  // The agents the plan gives callbacks to, not every free agent (`lateCallbacksReceivers`).
  const receivers = shown ? lateCallbacksReceivers(shown.preview).map(agentName) : [];
  const canGive = step.kind === 'preview' && step.preview.moving > 0;

  return (
    <Modal
      open
      onClose={() => {
        if (step.kind !== 'committing') onClose();
      }}
      title="Give late callbacks to free agents"
      subtitle={campaign.name}
      size="sm"
      closeOnOverlayClick={!busy}
      footer={
        <div className={styles.dialogFooter}>
          {step.kind === 'done' || step.kind === 'refused' ? (
            <button type="button" className="btn-primary" onClick={onClose} data-testid="handoff-done">Done</button>
          ) : (
            <>
              <button type="button" className="btn-secondary" onClick={onClose} disabled={step.kind === 'committing'}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={() => void give()} disabled={!canGive} data-testid="handoff-give">
                {step.kind === 'committing'
                  ? 'Giving…'
                  : shown && receivers.length > 0
                    ? `Give to ${plural(receivers.length, 'agent')}${shown.stale ? ': confirm again' : ''}`
                    : 'Give'}
              </button>
            </>
          )}
        </div>
      }
    >
      <div className={styles.handOff} aria-live="polite" data-testid="handoff-dialog">
        {step.kind === 'previewing' && <p className={styles.quiet}>Working out which callbacks would move…</p>}
        {shown && (
          <>
            {shown.stale && (
              <p className={styles.handOffStale} data-testid="handoff-stale">
                <AlertTriangle size={15} aria-hidden="true" />
                <span>{ASSIGNMENT_REFUSAL_COPY.preview_stale}</span>
              </p>
            )}
            <p className={styles.handOffQuestion} data-testid="handoff-question">{lateCallbacksQuestion(shown.preview)}</p>
            {receivers.length > 0 && (
              <p className={styles.quiet} data-testid="handoff-receivers">
                {`They go to the free agents with the fewest callbacks due: ${receivers.join(', ')}.`}
              </p>
            )}
            {shown.preview.skipped_live > 0 && (
              <p className={styles.quiet}>{`${formatCount(shown.preview.skipped_live)} on a call or awaiting an outcome won’t move.`}</p>
            )}
          </>
        )}
        {step.kind === 'done' && <p className={styles.handOffQuestion} role="status" data-testid="handoff-result">{lateCallbacksResultText(step.result, agentName)}</p>}
        {step.kind === 'refused' && <p className="error-text" role="alert" data-testid="handoff-error">{step.message}</p>}
      </div>
    </Modal>
  );
}
