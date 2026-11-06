import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { formatPhone } from '@magick-agency/web-ui/format';
import { FORMER_MEMBER_LABEL } from '../../utils/agencyAssignmentCopy';
import { errorCode } from '../../utils/agencyErrors';
import {
  SHARED_ROTATION_LABEL,
  STALE_CALLER_ID_FLAG,
  agentCallerIdRefusal,
} from '../../utils/agencyAgentCallerIdCopy';
import type { AgentCallerIdsResource } from '../../hooks/useAgentCallerIds';
import type { AgencyAgentCallerId } from '@magick-agency/contracts/api/agency/agent-caller-id';
import styles from './AgentCallerIdControl.module.css';

/**
 * One staffed agent's caller ID on the campaign's Agents tab (DN1–DN10): the
 * number every call to their contacts goes out from, or the shared rotation.
 *
 * The picker lists the campaign's usable caller IDs. A number another agent
 * holds is offered disabled with the holder's name rather than hidden: the
 * server refuses it (`caller_id_taken`), and a supervisor looking for "the Pune
 * number" needs to see that it exists and who has it. Refusals are worded by
 * `agentCallerIdRefusal` and shown in place, beside the control that caused them.
 *
 * A dedication whose number has left the campaign's caller IDs (`in_campaign:
 * false`) is flagged on the row: the dial path ignores it, so "+91… " alone would
 * claim calls go out from a number they do not.
 *
 * Rendered by `CampaignAgentAssignments` only for a supervisor with
 * `agency_contact_assignment_enabled` on, the gate on the routes.
 */

/**
 * Refusals that mean the picker is out of date (the number left the campaign,
 * someone else took it, the agent was unstaffed): the list is read again so
 * the next pick is made from what the server holds now.
 */
const STALE_PICKER_CODES: ReadonlySet<string> = new Set([
  'caller_id_taken',
  'caller_id_not_in_campaign',
  'agent_not_staffed',
]);

export interface AgentCallerIdControlProps {
  userId: string;
  /** For labels and toasts: the staffing row's name for this person. */
  agentName: string;
  resource: AgentCallerIdsResource;
}

export function AgentCallerIdControl({ userId, agentName, resource }: AgentCallerIdControlProps) {
  const { data, error, byUser, set, clear, reload } = resource;
  const { showToast } = useToast();
  const current = byUser.get(userId) ?? null;

  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  /** Who holds each dedicated number. */
  const holders = useMemo(
    () => new Map<string, AgencyAgentCallerId>((data?.dedicated ?? []).map((row) => [row.caller_id, row])),
    [data],
  );

  const open = useCallback(() => {
    setPicked(current && current.in_campaign ? current.caller_id : '');
    setRefusal(null);
    setEditing(true);
  }, [current]);

  const onSet = useCallback(async () => {
    if (!picked) return;
    setBusy(true);
    setRefusal(null);
    try {
      await set(userId, picked);
      showToast(`Calls to ${agentName}’s contacts now go from ${formatPhone(picked)}.`, 'success');
      setEditing(false);
    } catch (err: unknown) {
      setRefusal(agentCallerIdRefusal(err, 'Could not set that caller ID.'));
      if (STALE_PICKER_CODES.has(errorCode(err) ?? '')) void reload();
    } finally {
      setBusy(false);
    }
  }, [picked, set, userId, agentName, showToast, reload]);

  const onClear = useCallback(async () => {
    setBusy(true);
    setRefusal(null);
    try {
      await clear(userId);
      showToast(`${agentName}’s contacts are back on the shared rotation.`, 'success');
      setEditing(false);
    } catch (err: unknown) {
      setRefusal(agentCallerIdRefusal(err, 'Could not clear that caller ID.'));
      if (STALE_PICKER_CODES.has(errorCode(err) ?? '')) void reload();
    } finally {
      setBusy(false);
    }
  }, [clear, userId, agentName, showToast, reload]);

  if (!data) {
    // Unknown is not "Shared rotation": a failed or pending read says nothing
    // about which number this agent dials from. The panel shows the error.
    return (
      <div className={styles.cell} data-testid={`caller-id-${userId}`}>
        <span className={styles.label}>Caller ID</span>
        <span className={styles.muted}>{error ? 'Unavailable' : 'Loading…'}</span>
      </div>
    );
  }

  const optionLabel = (number: string): string => {
    const holder = holders.get(number);
    if (holder && holder.user_id !== userId) {
      return `${formatPhone(number)} — dedicated to ${holder.agent_name ?? FORMER_MEMBER_LABEL}`;
    }
    if (holder) return `${formatPhone(number)} (current)`;
    return formatPhone(number);
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.cell} data-testid={`caller-id-${userId}`}>
        <span className={styles.label}>Caller ID</span>
        <span className={current ? styles.value : styles.rotation}>
          {current ? formatPhone(current.caller_id) : SHARED_ROTATION_LABEL}
        </span>
        {current && !current.in_campaign ? (
          <span className={styles.stale} data-testid={`caller-id-stale-${userId}`}>
            <AlertTriangle size={13} aria-hidden="true" />
            {STALE_CALLER_ID_FLAG}
          </span>
        ) : null}
        {!editing ? (
          <button
            type="button"
            className={styles.change}
            onClick={open}
            aria-label={`Change caller ID for ${agentName}`}
          >
            Change
          </button>
        ) : null}
      </div>

      {editing ? (
        <div className={styles.editor} role="group" aria-label={`Caller ID for ${agentName}`}>
          {data.caller_ids.length === 0 ? (
            <p className={styles.muted}>This campaign has no caller IDs to dedicate.</p>
          ) : (
            <select
              className={styles.picker}
              aria-label={`Number for ${agentName}`}
              value={picked}
              onChange={(event) => setPicked(event.target.value)}
              disabled={busy}
            >
              <option value="">Choose a number…</option>
              {data.caller_ids.map((number) => {
                const holder = holders.get(number);
                return (
                  <option
                    key={number}
                    value={number}
                    disabled={holder !== undefined && holder.user_id !== userId}
                  >
                    {optionLabel(number)}
                  </option>
                );
              })}
            </select>
          )}
          <button
            type="button"
            className="btn-primary"
            onClick={() => void onSet()}
            disabled={busy || !picked || picked === current?.caller_id}
          >
            Dedicate
          </button>
          {current ? (
            <button type="button" className="btn-secondary" onClick={() => void onClear()} disabled={busy}>
              Use shared rotation
            </button>
          ) : null}
          <button
            type="button"
            className={styles.cancel}
            onClick={() => {
              setEditing(false);
              setRefusal(null);
            }}
            disabled={busy}
          >
            Cancel
          </button>
          {refusal ? (
            <p className={styles.refusal} role="alert" data-testid={`caller-id-refusal-${userId}`}>
              {refusal}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
