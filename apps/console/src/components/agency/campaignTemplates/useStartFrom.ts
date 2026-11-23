import { useCallback, useEffect, useState } from 'react';
import {
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  type AgencyCampaignTemplateEffective,
  type AgencyCampaignTemplateFilledSource,
  type AgencyCampaignTemplateSectionKey,
  type AgencyCampaignTemplateSummary,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { builtinTemplateSections, resolveTemplateSections } from '@magick-agency/domain/campaign-templates';
import { useTenant } from '../../../contexts/TenantContext';
import { getEffectiveCampaignTemplate, listCampaignTemplates } from '../../../api/campaignTemplates';

/** The picker's value for the built-in settings. */
export const BUILT_IN_START = '__builtin__';

/**
 * The built-in settings as a filled-in form (no template): the domain's built-in sections, every
 * section's source `builtin`. Worked out here rather than asked of the server, which has no way
 * to name "no template" (an effective read without `template_id` is the default chain).
 */
export function builtinEffective(): AgencyCampaignTemplateEffective {
  const resolved = resolveTemplateSections({
    chosen: null,
    basedOn: null,
    builtin: builtinTemplateSections(),
    can: { record: true, assignment: true, inbound: true },
  });
  return {
    template: null,
    based_on: null,
    config: resolved.config,
    sources: Object.fromEntries(
      AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.map((k) => [k, 'builtin' as AgencyCampaignTemplateFilledSource]),
    ) as Record<AgencyCampaignTemplateSectionKey, AgencyCampaignTemplateFilledSource>,
    notes: [],
  };
}

export type StartFromStatus = 'off' | 'loading' | 'ready' | 'failed';

/**
 * New campaign's "Start from" (`docs/campaign-templates.md` §7): the templates the account can see
 * and the settings the account's default chain fills in (`GET /campaign-templates/effective`).
 * `status` is `off` while `enabled` is false (the flag, or no right to create campaigns) and
 * `failed` when either read fails: the builder then starts exactly as it did before templates.
 */
export function useStartFrom(enabled: boolean): {
  status: StartFromStatus;
  templates: AgencyCampaignTemplateSummary[];
  initial: AgencyCampaignTemplateEffective | null;
  read: (choice: string) => Promise<AgencyCampaignTemplateEffective>;
} {
  const { tenantId, accountId } = useTenant();
  const [status, setStatus] = useState<StartFromStatus>(enabled ? 'loading' : 'off');
  const [templates, setTemplates] = useState<AgencyCampaignTemplateSummary[]>([]);
  const [initial, setInitial] = useState<AgencyCampaignTemplateEffective | null>(null);

  useEffect(() => {
    if (!enabled || !tenantId || !accountId) {
      setStatus('off');
      return undefined;
    }
    let live = true;
    setStatus('loading');
    Promise.all([listCampaignTemplates(tenantId, accountId), getEffectiveCampaignTemplate(null, tenantId, accountId)])
      .then(([list, effective]) => {
        if (!live) return;
        setTemplates(list);
        setInitial(effective);
        setStatus('ready');
      })
      .catch(() => {
        if (live) setStatus('failed');
      });
    return () => {
      live = false;
    };
  }, [enabled, tenantId, accountId]);

  const read = useCallback(
    (choice: string) =>
      choice === BUILT_IN_START
        ? Promise.resolve(builtinEffective())
        : getEffectiveCampaignTemplate(choice, tenantId ?? undefined, accountId ?? undefined),
    [tenantId, accountId],
  );

  return { status, templates, initial, read };
}
