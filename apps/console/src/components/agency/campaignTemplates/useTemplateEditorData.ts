import { useEffect, useRef, useState } from 'react';
import type {
  AgencyCampaignTemplate,
  AgencyCampaignTemplateScope,
  AgencyCampaignTemplateSections,
  AgencyCampaignTemplateSummary,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { useTenant } from '../../../contexts/TenantContext';
import { getCampaignTemplate, listCampaignTemplates } from '../../../api/campaignTemplates';
import { templateRefusal } from '../../../utils/agency/campaignTemplates/templateCopy';

/**
 * What the template editor reads (`docs/campaign-templates.md` §7): the template (unless it is
 * new), the organisation's live templates (an account template's "Based on" and the organisation's
 * default), and the sections of the organisation template an account template follows (its
 * based-on, else the organisation's default; CT2, CT10), read once per template followed.
 * `onLoaded` is told each time the template is read, so the form can start again from it.
 *
 * What a template follows is worked out by its own scope once it is read (an organisation
 * template opened from an account's page follows nothing, L4). When the followed template cannot
 * be read, the editor is not held, but `inheritedError` says so (with `retryInherited`), so the
 * built-in values standing in are never shown as that template's (U9).
 */
export function useTemplateEditorData({
  scope,
  id,
  enabled,
  basedOnId,
  onLoaded,
}: {
  scope: AgencyCampaignTemplateScope;
  /** The template's id, or `new`. */
  id: string;
  enabled: boolean;
  /** The "Based on" the form holds (account templates; null: the organisation's default). */
  basedOnId: string | null;
  onLoaded: (template: AgencyCampaignTemplate | null) => void;
}) {
  const { tenantId, accountId } = useTenant();
  const isNew = id === 'new';
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const [template, setTemplate] = useState<AgencyCampaignTemplate | null>(null);
  const [organisationTemplates, setOrganisationTemplates] = useState<AgencyCampaignTemplateSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  /** The organisation template's sections an account template inherits, by that template's id. */
  const [inheritedById, setInheritedById] = useState<Record<string, AgencyCampaignTemplateSections>>({});
  /** The followed templates whose read failed, by id, until Retry. */
  const [inheritedFailed, setInheritedFailed] = useState<Record<string, true>>({});

  // The template (unless new) and the organisation's live templates.
  useEffect(() => {
    if (!enabled || !tenantId || !accountId) return undefined;
    let live = true;
    setLoading(true);
    setLoadError(null);
    Promise.all([
      isNew ? Promise.resolve(null) : getCampaignTemplate(id, tenantId, accountId),
      listCampaignTemplates(tenantId, accountId),
    ])
      .then(([one, list]) => {
        if (!live) return;
        setTemplate(one);
        setOrganisationTemplates(list.filter((t) => t.scope === 'organisation'));
        if (one?.follows) setInheritedById((all) => ({ ...all, [one.follows!.id]: one.follows!.sections }));
        onLoadedRef.current(one);
      })
      .catch((err: unknown) => {
        if (live) setLoadError(templateRefusal(err, 'Could not load this template.'));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [enabled, tenantId, accountId, id, isNew, scope, reloadKey]);

  // What an account template inherits: its based-on, else the organisation's default.
  const organisationDefault = organisationTemplates.find((t) => t.is_default) ?? null;
  const ownScope = template?.scope ?? scope;
  const followsId = ownScope === 'account' ? basedOnId ?? organisationDefault?.id ?? null : null;
  const failed = followsId !== null && inheritedById[followsId] === undefined && inheritedFailed[followsId] === true;
  const inheritedReady = followsId === null || inheritedById[followsId] !== undefined || failed;
  useEffect(() => {
    if (followsId === null || inheritedById[followsId] !== undefined || inheritedFailed[followsId] || !tenantId || !accountId) return undefined;
    let live = true;
    getCampaignTemplate(followsId, tenantId, accountId)
      .then((t) => live && setInheritedById((all) => ({ ...all, [followsId]: t.sections })))
      // Unreadable: the editor goes on (on the built-in values), and says it could not read it.
      .catch(() => live && setInheritedFailed((all) => ({ ...all, [followsId]: true })));
    return () => {
      live = false;
    };
  }, [followsId, inheritedById, inheritedFailed, tenantId, accountId]);
  const followedName = followsId === null
    ? null
    : organisationTemplates.find((t) => t.id === followsId)?.name ?? (template?.follows?.id === followsId ? template.follows.name : null);

  return {
    template,
    /** After a save: the template as the server now has it. */
    setTemplate,
    organisationTemplates,
    organisationDefault,
    loading,
    loadError,
    reload: () => setReloadKey((n) => n + 1),
    /** The followed organisation template's sections; null for an organisation template or none followed. */
    inherited: followsId === null ? null : inheritedById[followsId] ?? null,
    inheritedReady,
    /** The followed template could not be read: what it gives is not known. */
    inheritedError: failed ? `Could not read ${followedName ?? 'the organisation template'}, so the values it gives are not shown.` : null,
    retryInherited: () => {
      if (followsId === null) return;
      setInheritedFailed((all) => {
        const { [followsId]: _gone, ...rest } = all;
        return rest;
      });
    },
  };
}
