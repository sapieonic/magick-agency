import { useCallback, useMemo } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { clearAgentCallerId, getAgentCallerIds, setAgentCallerId } from '../api/agencyAssignment';
import type {
  AgencyAgentCallerId,
  AgencyAgentCallerIds,
} from '@magick-agency/contracts/api/agency/agent-caller-id';

/**
 * One campaign's dedicated caller IDs (DN1–DN10) for the Agents tab: who holds
 * which number, the campaign's usable numbers, and whether the rotation is
 * sharing dedicated ones (`all_dedicated`).
 *
 * Render it only behind `agency.supervise`, the routes' gate. The read and the
 * release work whatever `agency_contact_assignment_enabled` says; only `set` is
 * refused with it off (`assignment_disabled`), so a flag-off caller offers only
 * `clear`.
 *
 * `set` and `clear` reload on success and throw the `ApiError` on a refusal, for
 * the caller to word with `agentCallerIdRefusal`.
 */
export interface AgentCallerIdsResource {
  /** `null` until the first read succeeds. */
  data: AgencyAgentCallerIds | null;
  error: string | null;
  /** Dedicated numbers by agent user id. */
  byUser: ReadonlyMap<string, AgencyAgentCallerId>;
  /** Dedicated numbers by caller ID: who holds each one. */
  byNumber: ReadonlyMap<string, AgencyAgentCallerId>;
  reload: () => Promise<void>;
  set: (userId: string, callerId: string) => Promise<void>;
  clear: (userId: string) => Promise<void>;
}

const NO_DEDICATIONS: ReadonlyMap<string, AgencyAgentCallerId> = new Map();

export function useAgentCallerIds(campaignId: string): AgentCallerIdsResource {
  const { tenantId, accountId } = useTenant();
  const ready = Boolean(campaignId && tenantId && accountId);

  const fetcher = useCallback(
    () => getAgentCallerIds(campaignId, tenantId!, accountId!),
    [campaignId, tenantId, accountId],
  );
  const { data, error, reload } = useAsyncResource<AgencyAgentCallerIds | null>(fetcher, {
    initialData: null,
    errorMessage: 'Could not load the agents’ caller IDs.',
    enabled: ready,
  });

  const byUser = useMemo(
    () => (data ? new Map(data.dedicated.map((row) => [row.user_id, row])) : NO_DEDICATIONS),
    [data],
  );
  const byNumber = useMemo(
    () => (data ? new Map(data.dedicated.map((row) => [row.caller_id, row])) : NO_DEDICATIONS),
    [data],
  );

  const set = useCallback(
    async (userId: string, callerId: string) => {
      await setAgentCallerId(campaignId, userId, callerId, tenantId!, accountId!);
      await reload();
    },
    [campaignId, tenantId, accountId, reload],
  );

  const clear = useCallback(
    async (userId: string) => {
      await clearAgentCallerId(campaignId, userId, tenantId!, accountId!);
      await reload();
    },
    [campaignId, tenantId, accountId, reload],
  );

  return { data, error, byUser, byNumber, reload, set, clear };
}
