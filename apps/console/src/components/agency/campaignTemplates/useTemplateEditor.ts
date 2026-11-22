import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import {
  AGENCY_CAMPAIGN_TEMPLATE_NAME_MAX,
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  type AgencyCampaignTemplate,
  type AgencyCampaignTemplateScope,
  type AgencyCampaignTemplateSectionKey,
  type AgencyCampaignTemplateSections,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { diffSections, sectionKeysSet } from '@magick-agency/domain/campaign-templates';
import { useTenant } from '../../../contexts/TenantContext';
import { createCampaignTemplate, replaceCampaignTemplate } from '../../../api/campaignTemplates';
import { errorCode } from '../../../utils/agencyErrors';
import {
  filledConfig,
  formOfConfig,
  organisationRecording,
  SCRIPT_LEFT_OUT_NOTE,
  sectionOfPath,
  sectionsOfForm,
  templateFormErrors,
  templateSectionsFromCampaign,
  withSectionFrom,
  type TemplateForm,
} from '../../../utils/agency/campaignTemplates/templateForm';
import { sectionSummary, templateRefusal } from '../../../utils/agency/campaignTemplates/templateCopy';
import { trackAgencyCampaignTemplateSaved } from '../../../analytics/events';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import type { NewTemplateStart } from './NewTemplateDialog';
import { useTemplateEditorData } from './useTemplateEditorData';

/** The server's word on the name, when a `campaign_template_invalid` refusal is about it (N9). */
function nameDetail(err: unknown): string | null {
  const details = (err as { details?: { details?: Record<string, unknown> } } | null)?.details?.details;
  const name = details?.['name'];
  return typeof name === 'string' && name.trim() !== '' ? name : null;
}

/** The editor's saved state: what Discard puts back and what "unsaved" is measured against. */
interface Baseline {
  name: string;
  description: string;
  basedOnId: string | null;
  setKeys: AgencyCampaignTemplateSectionKey[];
  form: TemplateForm;
  sections: AgencyCampaignTemplateSections;
}

/**
 * The template editor's state (`docs/campaign-templates.md` §7): the name, description and
 * "Based on", which sections the template sets, every section's editors (`TemplateForm`), what it
 * inherits (CT2), the saved baseline with Discard, the checks, and Save with the version it opened
 * (CT6; a save in between is a conflict, offered as "Reload the latest version"). The reads are
 * `useTemplateEditorData`'s; the page draws it (`TemplateEditorForm`) and holds the dialogs.
 *
 * A template is read by its own scope once loaded: one of another scope than the page's (an
 * organisation template opened from an account's page) is `readOnly` (L4).
 */
export function useTemplateEditor({
  scope,
  id,
  enabled,
  start,
  visible,
}: {
  scope: AgencyCampaignTemplateScope;
  id: string;
  enabled: boolean;
  /** What a new template starts from (the list's "New template"), read once. */
  start: NewTemplateStart | null;
  /** The sections the editor shows (`useTemplateSectionKeys`). */
  visible: readonly AgencyCampaignTemplateSectionKey[];
}) {
  const isNew = id === 'new';
  const { tenantId, accountId } = useTenant();
  const { showToast } = useToast();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [basedOnId, setBasedOnId] = useState<string | null>(null);
  const [setKeys, setSetKeys] = useState<AgencyCampaignTemplateSectionKey[]>([]);
  const [form, setForm] = useState<TemplateForm | null>(null);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  /** Remounts the outcome editors after their list is replaced (a copy, Discard). */
  const [epoch, setEpoch] = useState(0);
  /** What a copy of a campaign left out, said above the cards until Discard (U2). */
  const [notice, setNotice] = useState<string | null>(start?.note ?? null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const data = useTemplateEditorData({
    scope,
    id,
    enabled,
    basedOnId,
    // Seed the fields; the form follows once what it inherits is known.
    onLoaded: (one) => {
      setName(one?.name ?? start?.name ?? '');
      setDescription(one?.description ?? start?.description ?? '');
      setBasedOnId(scope === 'account' ? (one ? one.based_on?.id ?? null : start?.basedOnId ?? null) : null);
      setSetKeys(sectionKeysSet(one?.sections ?? start?.sections ?? {}));
      setForm(null);
      setBaseline(null);
    },
  });
  const { template, inherited, inheritedReady, loading, loadError } = data;
  /** The template's own scope: the page's, unless it opened one of the other scope (read-only). */
  const ownScope = template?.scope ?? scope;
  const readOnly = template !== null && template.scope !== scope;

  /** What every unset section shows and gives: the followed template, then built-in. Worked out once per inheritance. */
  const inheritedConfig = useMemo(() => filledConfig(ownScope, {}, inherited), [ownScope, inherited]);
  const inheritedForm = useMemo(() => formOfConfig(inheritedConfig), [inheritedConfig]);

  // The form, once its inheritance is known; then kept in step with "Based on".
  const sourceSections = template?.sections ?? start?.sections ?? {};
  useEffect(() => {
    if (loading || loadError || !inheritedReady) return;
    if (form === null) {
      let next = formOfConfig(filledConfig(ownScope, sourceSections, inherited));
      if (ownScope === 'organisation') next = { ...next, recording: organisationRecording(next.recording) };
      const keys = sectionKeysSet(sourceSections);
      setForm(next);
      setBaseline({
        name: template?.name ?? '',
        description: template?.description ?? '',
        basedOnId: ownScope === 'account' ? template?.based_on?.id ?? null : null,
        setKeys: keys,
        form: next,
        // A new template's saved state is nothing at all: whatever it starts from is unsaved.
        sections: template ? sectionsOfForm(next, ownScope, keys) : {},
      });
      return;
    }
    // "Based on" changed: every unset section now shows the new inheritance.
    let moved = form;
    for (const key of AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS) if (!setKeys.includes(key)) moved = withSectionFrom(moved, inheritedForm, key);
    if (moved !== form) setForm(moved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, loadError, inheritedReady, inheritedForm]);

  const sections = useMemo(() => (form ? sectionsOfForm(form, ownScope, setKeys) : {}), [form, ownScope, setKeys]);
  const dirty = baseline !== null && form !== null && (
    name.trim() !== baseline.name
    || description.trim() !== (baseline.description ?? '')
    || basedOnId !== baseline.basedOnId
    || diffSections(baseline.sections, sections).length > 0
  );

  const liveErrors = useMemo(() => (form ? templateFormErrors(form, setKeys) : {}), [form, setKeys]);
  const invalidSections = useMemo(() => {
    const out = new Set<AgencyCampaignTemplateSectionKey>();
    for (const path of [...Object.keys(liveErrors), ...Object.keys(fieldErrors)]) {
      const key = path.startsWith('break_reasons') ? 'breaks' : sectionOfPath(path);
      if (key) out.add(key);
    }
    return out;
  }, [liveErrors, fieldErrors]);

  /**
   * Section `key`'s values in one line: the template's when set, else what it inherits. Unset
   * numbers are no template's: each new campaign picks its own (U8). Nothing is said for an
   * inheritance that could not be read (U9).
   */
  const summaryOf = (key: AgencyCampaignTemplateSectionKey) => {
    if (setKeys.includes(key)) return sectionSummary(key, sections);
    if (key === 'numbers') return 'Each new campaign picks its own numbers';
    if (data.inheritedError) return 'Not shown: what it follows could not be read';
    return sectionSummary(key, inheritedConfig);
  };

  const setSection = useCallback(
    (key: AgencyCampaignTemplateSectionKey, set: boolean) => {
      if (!form) return;
      setSetKeys((keys) => (set ? [...keys.filter((k) => k !== key), key] : keys.filter((k) => k !== key)));
      // Not set: the section shows (and would give) what it inherits.
      if (!set) setForm(withSectionFrom(form, inheritedForm, key));
    },
    [form, inheritedForm],
  );

  /** "Copy from a campaign…": every shown section set from the campaign's settings. */
  const copyCampaign = (campaign: AgencyCampaign) => {
    if (!form) return;
    const { sections: copied, scriptLeftOut } = templateSectionsFromCampaign(campaign, scope, visible);
    setNotice(scriptLeftOut ? SCRIPT_LEFT_OUT_NOTE : null);
    const copiedForm = formOfConfig(filledConfig(scope, copied, inherited));
    let next = form;
    for (const key of visible) next = withSectionFrom(next, copiedForm, key);
    setForm(scope === 'organisation' ? { ...next, recording: organisationRecording(next.recording) } : next);
    setSetKeys((keys) => [...new Set([...keys, ...visible])]);
    setEpoch((n) => n + 1);
  };

  const discard = () => {
    if (!baseline) return;
    setName(baseline.name);
    setDescription(baseline.description);
    setBasedOnId(baseline.basedOnId);
    setSetKeys(baseline.setKeys);
    setForm(baseline.form);
    setFieldErrors({});
    setSaveError(null);
    setNameError(null);
    setNotice(null);
    setEpoch((n) => n + 1);
  };

  const reloadLatest = () => {
    setConflict(false);
    setSaveError(null);
    setFieldErrors({});
    setForm(null);
    setBaseline(null);
    data.reload();
  };

  /** Save; the template saved, or null when it was not. */
  const save = async (): Promise<AgencyCampaignTemplate | null> => {
    if (!form) return null;
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > AGENCY_CAMPAIGN_TEMPLATE_NAME_MAX) {
      setNameError(trimmed.length === 0 ? 'Give the template a name.' : `Keep the name to ${AGENCY_CAMPAIGN_TEMPLATE_NAME_MAX} characters.`);
      return null;
    }
    if (Object.keys(liveErrors).length > 0) return null;
    setSaving(true);
    setSaveError(null);
    setNameError(null);
    setFieldErrors({});
    setConflict(false);
    const desc = description.trim() === '' ? null : description.trim();
    const based = scope === 'account' ? basedOnId : null;
    try {
      const saved = isNew
        ? await createCampaignTemplate(
          { scope, name: trimmed, description: desc, ...(scope === 'account' ? { based_on_template_id: based } : {}), sections },
          tenantId ?? undefined,
          accountId ?? undefined,
        )
        : await replaceCampaignTemplate(
          id,
          scope,
          { name: trimmed, description: desc, based_on_template_id: based, sections, expected_version: template!.version },
          tenantId ?? undefined,
          accountId ?? undefined,
        );
      trackAgencyCampaignTemplateSaved({ scope, created: isNew, sections_set: setKeys.length, version: saved.version });
      showToast(isNew ? `“${saved.name}” created.` : `“${saved.name}” saved as version ${saved.version}.`, 'success');
      data.setTemplate(saved);
      setBaseline({ name: saved.name, description: saved.description ?? '', basedOnId: based, setKeys, form, sections });
      setName(saved.name);
      setDescription(saved.description ?? '');
      return saved;
    } catch (err) {
      const code = errorCode(err);
      if (code === 'campaign_template_changed') setConflict(true);
      if (code === 'campaign_template_name_taken') setNameError(templateRefusal(err, ''));
      else if (code === 'campaign_template_invalid' && nameDetail(err)) setNameError(nameDetail(err));
      else if (code === 'campaign_template_section_invalid') {
        const details = (err as { details?: { details?: Record<string, string> } }).details?.details ?? {};
        setFieldErrors(details);
        setSaveError('Some settings cannot be saved. They are marked below.');
      } else setSaveError(templateRefusal(err, 'Could not save the template.'));
      return null;
    } finally {
      setSaving(false);
    }
  };

  /*
    What a section left unset uses (CTC12): the next level's name. An account template based on an
    organisation template uses that one; one that follows the organisation's default uses whichever
    that is when a campaign is made (CT10); an organisation template uses the built-in settings.
    Numbers are never an organisation template's (CT5, CT15): unset, each new campaign picks its
    own (U8).
  */
  const basedOn = data.organisationTemplates.find((t) => t.id === basedOnId) ?? null;
  const followedName = basedOn?.name ?? template?.based_on?.name ?? 'the organisation template';
  const inheritLabelOf = (key: AgencyCampaignTemplateSectionKey) => {
    if (ownScope === 'organisation') return 'Use built-in settings';
    if (key === 'numbers') return 'Pick them in each campaign';
    return basedOnId !== null ? `Use ${followedName}` : 'Use the organisation’s default';
  };
  /** Where an unset section comes from, as a read-only card says it. */
  const inheritedFromOf = (key: AgencyCampaignTemplateSectionKey) => {
    if (ownScope === 'organisation') return 'Built-in settings';
    if (key === 'numbers') return 'Picked in each campaign';
    return basedOnId !== null ? `From ${followedName}` : 'From the organisation’s default';
  };

  return {
    isNew,
    data,
    form,
    setForm,
    ready: form !== null && baseline !== null,
    name,
    setName: (value: string) => {
      setName(value);
      setNameError(null);
    },
    description,
    setDescription,
    basedOnId,
    setBasedOnId,
    setKeys,
    setSection,
    sections,
    summaryOf,
    inheritLabelOf,
    inheritedFromOf,
    ownScope,
    readOnly,
    epoch,
    notice,
    dirty,
    /** The call summary profile the saved template holds (null for none, and for a new one). */
    savedProfileId: baseline?.sections.recording?.analysis_profile_id ?? null,
    blocked: Object.keys(liveErrors).length > 0,
    /** The server refused fields of the last save (shown on their cards). */
    hasFieldErrors: Object.keys(fieldErrors).length > 0,
    shownErrors: { ...liveErrors, ...fieldErrors },
    invalidSections,
    saving,
    saveError,
    conflict,
    nameError,
    save,
    discard,
    reloadLatest,
    copyCampaign,
  };
}
