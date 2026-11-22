import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import {
  AGENCY_CAMPAIGN_TEMPLATE_DESCRIPTION_MAX,
  AGENCY_CAMPAIGN_TEMPLATE_NAME_MAX,
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  type AgencyCampaignTemplate,
  type AgencyCampaignTemplateScope,
  type AgencyCampaignTemplateSectionKey,
  type AgencyCampaignTemplateSections,
  type AgencyCampaignTemplateSummary,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { diffSections, sectionKeysSet, sectionsFromCampaign } from '@magick-agency/domain/campaign-templates';
import { useTenant } from '../../../contexts/TenantContext';
import { useGovernance } from '../../../contexts/GovernanceContext';
import { useFeatureFlagEnabled } from '../../../hooks/useFeatureFlagEnabled';
import { useAgencyCarriers } from '../../../hooks/useAgencyCarriers';
import { useUnsavedChangesGuard } from '../../../hooks/useUnsavedChangesGuard';
import { LeaveUnsavedDialog } from '../../../components/agency/UnsavedChangesBar';
import { CapabilityUnavailable } from '../../../components/common/CapabilityUnavailable';
import { usePageCrumbs } from '../../../components/layout/PageCrumbs';
import {
  createCampaignTemplate,
  getCampaignTemplate,
  listCampaignTemplates,
  replaceCampaignTemplate,
} from '../../../api/campaignTemplates';
import { errorCode } from '../../../utils/agencyErrors';
import { CONTACT_ASSIGNMENT_FLAG } from '../../../utils/agencyAssignmentCopy';
import { INBOUND_FLAG } from '../../../utils/inbound/inboundFlag';
import { AGENCY_ANALYTICS_CAPABILITY, AGENCY_RECORDING_CAPABILITY } from '../../../utils/agencyCampaignRecording';
import { CAMPAIGN_TEMPLATES_PATH, ORGANISATION_CAMPAIGN_TEMPLATES_PATH, campaignTemplatePath } from '../../../utils/consoleNav';
import {
  formOfConfig,
  filledConfig,
  organisationRecording,
  sectionOfPath,
  sectionsOfForm,
  templateFormErrors,
  withSectionFrom,
  type TemplateForm,
} from '../../../utils/agency/campaignTemplates/templateForm';
import { changedLine, sectionSummary, templateRefusal } from '../../../utils/agency/campaignTemplates/templateCopy';
import { trackAgencyCampaignTemplateSaved } from '../../../analytics/events';
import { TemplateSectionCard } from '../../../components/agency/campaignTemplates/TemplateSectionCard';
import { TemplateSectionEditors } from '../../../components/agency/campaignTemplates/TemplateSectionEditors';
import { CopyFromCampaignDialog } from '../../../components/agency/campaignTemplates/CopyFromCampaignDialog';
import { TemplateHistory } from '../../../components/agency/campaignTemplates/TemplateHistory';
import { ApplyToDraftsDialog } from '../../../components/agency/campaignTemplates/ApplyToDraftsDialog';
import { useTemplatesAccess } from '../../../components/agency/campaignTemplates/useTemplatesAccess';
import type { NewTemplateStart } from '../../../components/agency/campaignTemplates/NewTemplateDialog';
import styles from '../../../components/agency/campaignTemplates/CampaignTemplates.module.css';

/** What a new template starts from, handed over by the list's "New template" (router state). */
type TemplateStart = NewTemplateStart;

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
 * Settings › Campaign templates › one template (`docs/campaign-templates.md` §7): one card per
 * section in the §3 order, each "Use <what it follows>" or "Set in this template", set sections
 * opening the editors campaign Settings uses. A name, a description and, for an account template,
 * the organisation template it is based on. Copy from a campaign, History, and Apply to draft
 * campaigns. A save sends the version it opened (CT6); another save in between is offered as
 * "Reload the latest version".
 */
export default function CampaignTemplateEditorPage({ scope }: { scope: AgencyCampaignTemplateScope }) {
  const { id = 'new' } = useParams<{ id: string }>();
  const isNew = id === 'new';
  const location = useLocation();
  const navigate = useNavigate();
  const { tenantId, accountId } = useTenant();
  const { showToast } = useToast();
  const access = useTemplatesAccess();
  const allowed = scope === 'organisation' ? access.manageOrganisation : access.manage;
  const assignmentOn = useFeatureFlagEnabled(CONTACT_ASSIGNMENT_FLAG);
  const inboundOn = useFeatureFlagEnabled(INBOUND_FLAG);
  const { isEnabled: isCapabilityEnabled } = useGovernance();
  const { carriers } = useAgencyCarriers({ enabled: allowed && scope === 'account' });
  const listPath = scope === 'organisation' ? ORGANISATION_CAMPAIGN_TEMPLATES_PATH : CAMPAIGN_TEMPLATES_PATH;
  const start = (location.state as { start?: TemplateStart } | null)?.start ?? null;
  const fieldId = useId();

  /** The sections this editor shows: the scope's, without those whose feature is off (CT5). */
  const visible = useMemo(
    () =>
      AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.filter(
        (k) =>
          !(scope === 'organisation' && k === 'numbers')
          && !(k === 'assignment' && !assignmentOn)
          && !(k === 'inbound' && !inboundOn),
      ),
    [scope, assignmentOn, inboundOn],
  );

  const [template, setTemplate] = useState<AgencyCampaignTemplate | null>(null);
  const [organisationTemplates, setOrganisationTemplates] = useState<AgencyCampaignTemplateSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [basedOnId, setBasedOnId] = useState<string | null>(null);
  const [setKeys, setSetKeys] = useState<AgencyCampaignTemplateSectionKey[]>([]);
  const [form, setForm] = useState<TemplateForm | null>(null);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  /** The organisation template's sections an account template inherits, by that template's id. */
  const [inheritedById, setInheritedById] = useState<Record<string, AgencyCampaignTemplateSections>>({});
  const [epoch, setEpoch] = useState(0);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [copyOpen, setCopyOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [goTo, setGoTo] = useState<string | null>(null);

  // ── Load: the template (unless new) and the organisation's live templates ────
  useEffect(() => {
    if (!allowed || !tenantId || !accountId) return;
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
        // Seed the fields; the form follows once what it inherits is known.
        setName(one?.name ?? start?.name ?? '');
        setDescription(one?.description ?? start?.description ?? '');
        setBasedOnId(scope === 'account' ? (one ? one.based_on?.id ?? null : start?.basedOnId ?? null) : null);
        setSetKeys(sectionKeysSet(one?.sections ?? start?.sections ?? {}));
        setForm(null);
        setBaseline(null);
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
    // `start` is read once, with the page it opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, tenantId, accountId, id, isNew, scope, reloadKey]);

  // ── What an account template inherits: its based-on, else the organisation's default ──
  const organisationDefault = organisationTemplates.find((t) => t.is_default) ?? null;
  const followsId = scope === 'account' ? basedOnId ?? organisationDefault?.id ?? null : null;
  const inheritedReady = followsId === null || inheritedById[followsId] !== undefined;
  useEffect(() => {
    if (followsId === null || inheritedById[followsId] !== undefined || !tenantId || !accountId) return;
    let live = true;
    getCampaignTemplate(followsId, tenantId, accountId)
      .then((t) => live && setInheritedById((all) => ({ ...all, [followsId]: t.sections })))
      // Unreadable: inherit the built-in settings rather than hold the editor.
      .catch(() => live && setInheritedById((all) => ({ ...all, [followsId]: {} })));
    return () => {
      live = false;
    };
  }, [followsId, inheritedById, tenantId, accountId]);
  const inherited = followsId === null ? null : inheritedById[followsId] ?? null;
  /** What every unset section shows: the followed template, then built-in. */
  const inheritedForm = useMemo(() => formOfConfig(filledConfig(scope, {}, inherited)), [scope, inherited]);

  // ── The form, once its inheritance is known; then kept in step with "Based on" ──
  const sourceSections = template?.sections ?? start?.sections ?? {};
  useEffect(() => {
    if (loading || loadError || !inheritedReady) return;
    if (form === null) {
      let next = formOfConfig(filledConfig(scope, sourceSections, inherited));
      if (scope === 'organisation') next = { ...next, recording: organisationRecording(next.recording) };
      const keys = sectionKeysSet(sourceSections);
      setForm(next);
      setBaseline({
        name: template?.name ?? '',
        description: template?.description ?? '',
        basedOnId: scope === 'account' ? template?.based_on?.id ?? null : null,
        setKeys: keys,
        form: next,
        // A new template's saved state is nothing at all: whatever it starts from is unsaved.
        sections: template ? sectionsOfForm(next, scope, keys) : {},
      });
      return;
    }
    // "Based on" changed: every unset section now shows the new inheritance.
    let moved = form;
    for (const key of AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS) if (!setKeys.includes(key)) moved = withSectionFrom(moved, inheritedForm, key);
    if (moved !== form) setForm(moved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, loadError, inheritedReady, inheritedForm]);

  const sections = useMemo(() => (form ? sectionsOfForm(form, scope, setKeys) : {}), [form, scope, setKeys]);
  const dirty = baseline !== null && form !== null && (
    name.trim() !== baseline.name
    || description.trim() !== (baseline.description ?? '')
    || basedOnId !== baseline.basedOnId
    || diffSections(baseline.sections, sections).length > 0
  );
  const guard = useUnsavedChangesGuard(dirty && goTo === null);

  // A navigation asked for by a save, once the guard has let go.
  useEffect(() => {
    if (goTo === null) return;
    navigate(goTo, { replace: true });
    setGoTo(null);
  }, [goTo, navigate]);

  usePageCrumbs(template ? [{ label: scope === 'organisation' ? 'Organisation campaign templates' : 'Campaign templates', to: listPath }, { label: template.name }] : null);

  const liveErrors = useMemo(() => (form ? templateFormErrors(form, setKeys) : {}), [form, setKeys]);
  const invalidSections = useMemo(() => {
    const out = new Set<AgencyCampaignTemplateSectionKey>();
    for (const path of [...Object.keys(liveErrors), ...Object.keys(fieldErrors)]) {
      const key = path.startsWith('break_reasons') ? 'breaks' : sectionOfPath(path);
      if (key) out.add(key);
    }
    return out;
  }, [liveErrors, fieldErrors]);

  const onSetChange = useCallback(
    (key: AgencyCampaignTemplateSectionKey, set: boolean) => {
      if (!form) return;
      setSetKeys((keys) => (set ? [...keys.filter((k) => k !== key), key] : keys.filter((k) => k !== key)));
      // Not set: the section shows (and would give) what it inherits.
      if (!set) setForm(withSectionFrom(form, inheritedForm, key));
    },
    [form, inheritedForm],
  );

  const onCopyCampaign = (campaign: Parameters<typeof sectionsFromCampaign>[0]) => {
    if (!form) return;
    const copied = sectionsFromCampaign(campaign, scope, visible);
    const copiedForm = formOfConfig(filledConfig(scope, copied, inherited));
    let next = form;
    for (const key of visible) next = withSectionFrom(next, copiedForm, key);
    setForm(scope === 'organisation' ? { ...next, recording: organisationRecording(next.recording) } : next);
    setSetKeys((keys) => [...new Set([...keys, ...visible])]);
    setEpoch((n) => n + 1);
    setCopyOpen(false);
    showToast('Settings copied from the campaign. Check them, then save the template.', 'success');
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
    setEpoch((n) => n + 1);
  };

  const reloadLatest = () => {
    setConflict(false);
    setSaveError(null);
    setFieldErrors({});
    setForm(null);
    setBaseline(null);
    setReloadKey((n) => n + 1);
  };

  const save = async () => {
    if (!form) return;
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > AGENCY_CAMPAIGN_TEMPLATE_NAME_MAX) {
      setNameError(trimmed.length === 0 ? 'Give the template a name.' : `Keep the name to ${AGENCY_CAMPAIGN_TEMPLATE_NAME_MAX} characters.`);
      return;
    }
    if (Object.keys(liveErrors).length > 0) return;
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
      setTemplate(saved);
      setBaseline({ name: saved.name, description: saved.description ?? '', basedOnId: based, setKeys, form, sections });
      setName(saved.name);
      setDescription(saved.description ?? '');
      if (isNew) setGoTo(campaignTemplatePath(scope, saved.id));
    } catch (err) {
      const code = errorCode(err);
      if (code === 'campaign_template_changed') setConflict(true);
      if (code === 'campaign_template_name_taken') setNameError(templateRefusal(err, ''));
      else if (code === 'campaign_template_section_invalid') {
        const details = (err as { details?: { details?: Record<string, string> } }).details?.details ?? {};
        setFieldErrors(details);
        setSaveError('Some settings cannot be saved. They are marked below.');
      } else setSaveError(templateRefusal(err, 'Could not save the template.'));
    } finally {
      setSaving(false);
    }
  };

  if (!allowed) return <CapabilityUnavailable />;
  if (loading || (form === null && !loadError)) return <LoadingSpinner />;
  if (loadError || !form || !baseline) {
    return (
      <div className={styles.page}>
        <PageHeader title={scope === 'organisation' ? 'Organisation campaign template' : 'Campaign template'} />
        <ErrorAlert message={loadError ?? 'Could not load this template.'} onRetry={() => setReloadKey((n) => n + 1)} />
      </div>
    );
  }

  const basedOnTemplate = organisationTemplates.find((t) => t.id === basedOnId) ?? null;
  const inheritLabel = scope === 'organisation'
    ? 'Built-in'
    : basedOnId !== null
      ? `Use ${basedOnTemplate?.name ?? template?.based_on?.name ?? 'the organisation template'}`
      : organisationDefault
        ? 'Use organisation’s default'
        : 'Built-in';
  const recordingEnabled = isCapabilityEnabled(AGENCY_RECORDING_CAPABILITY);
  const analyticsEnabled = isCapabilityEnabled(AGENCY_ANALYTICS_CAPABILITY);
  const blocked = Object.keys(liveErrors).length > 0;
  const shownErrors = { ...liveErrors, ...fieldErrors };

  return (
    <div className={styles.page}>
      <PageHeader
        title={isNew ? (scope === 'organisation' ? 'New organisation campaign template' : 'New campaign template') : template!.name}
        subtitle={template ? changedLine(template) : undefined}
        actions={
          <div className={styles.toolbar}>
            <button type="button" className="btn-secondary" onClick={() => setCopyOpen(true)}>
              Copy from a campaign…
            </button>
            {template ? (
              <>
                <button type="button" className="btn-secondary" onClick={() => setHistoryOpen((v) => !v)} aria-expanded={historyOpen}>
                  History
                </button>
                <button type="button" className="btn-secondary" onClick={() => setApplyOpen(true)} disabled={dirty}>
                  Apply to draft campaigns…
                </button>
              </>
            ) : null}
          </div>
        }
      />
      <p className={styles.muted}>
        {scope === 'organisation'
          ? 'Every account can start new campaigns from this template. A section left on Built-in uses the built-in settings.'
          : 'New campaigns of this account can start from this template. A section you do not set comes from the organisation template it is based on, or the built-in settings.'}{' '}
        Changing a template never changes a campaign that already exists. <Link to={listPath}>All templates</Link>
      </p>

      {conflict ? (
        <div className={styles.banner} role="alert" data-testid="template-conflict">
          <p>Someone else saved this template after you opened it. Your changes are not saved.</p>
          <div>
            <button type="button" className="btn-primary" onClick={reloadLatest}>
              Reload the latest version
            </button>
          </div>
        </div>
      ) : saveError ? (
        <ErrorAlert message={saveError} />
      ) : null}

      {historyOpen && template ? (
        <section className={styles.card} aria-label="History">
          <h2 className={styles.cardTitle}>History</h2>
          <TemplateHistory templateId={template.id} current={{ version: template.version, sections: template.sections }} />
        </section>
      ) : null}

      {visible.map((key) => {
        const set = setKeys.includes(key);
        return (
          <TemplateSectionCard
            key={key}
            section={key}
            set={set}
            onSetChange={(next) => onSetChange(key, next)}
            inheritLabel={inheritLabel}
            summary={set ? sectionSummary(key, sections) : sectionSummary(key, filledConfig(scope, {}, inherited))}
            invalid={invalidSections.has(key)}
          >
            <TemplateSectionEditors
              section={key}
              form={form}
              onChange={setForm}
              scope={scope}
              fieldErrors={shownErrors}
              recordingEnabled={recordingEnabled}
              analyticsEnabled={analyticsEnabled}
              carriers={carriers}
              epoch={epoch}
            />
          </TemplateSectionCard>
        );
      })}

      <div className={styles.footer} role="region" aria-label="Save the template">
        <div className={styles.footerFields}>
          <div className="form-group">
            <label htmlFor={`${fieldId}-name`}>
              Name<span className="required-star">*</span>
            </label>
            <input
              id={`${fieldId}-name`}
              value={name}
              maxLength={AGENCY_CAMPAIGN_TEMPLATE_NAME_MAX}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? `${fieldId}-name-error` : undefined}
            />
            {nameError ? (
              <p className={styles.fieldError} id={`${fieldId}-name-error`} role="alert">
                {nameError}
              </p>
            ) : null}
          </div>
          <div className="form-group">
            <label htmlFor={`${fieldId}-description`}>Description (optional)</label>
            <input
              id={`${fieldId}-description`}
              value={description}
              maxLength={AGENCY_CAMPAIGN_TEMPLATE_DESCRIPTION_MAX}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {scope === 'account' ? (
            <div className="form-group">
              <label htmlFor={`${fieldId}-based-on`}>Based on</label>
              <select
                id={`${fieldId}-based-on`}
                value={basedOnId ?? ''}
                onChange={(e) => setBasedOnId(e.target.value === '' ? null : e.target.value)}
              >
                <option value="">
                  {organisationDefault ? `Organisation’s default (now ${organisationDefault.name})` : 'Organisation’s default'}
                </option>
                {organisationTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
        <div className={styles.actions}>
          {blocked ? <span className={styles.muted}>Fix the marked settings to save.</span> : null}
          <button type="button" className="btn-secondary" onClick={discard} disabled={!dirty || saving || isNew}>
            Discard
          </button>
          <button type="button" className="btn-primary" onClick={() => void save()} disabled={saving || blocked || (!dirty && !isNew)}>
            {saving ? 'Saving…' : 'Save template'}
          </button>
        </div>
      </div>

      <CopyFromCampaignDialog
        open={copyOpen}
        onClose={() => setCopyOpen(false)}
        onCopy={onCopyCampaign}
        note="Every section is set from the campaign’s settings. Nothing is saved until you save the template."
      />
      {template ? (
        <ApplyToDraftsDialog
          open={applyOpen}
          onClose={() => setApplyOpen(false)}
          template={{ id: template.id, name: template.name, version: template.version, scope, sections_set: template.sections_set }}
          sections={visible}
        />
      ) : null}
      <LeaveUnsavedDialog
        guard={guard}
        message="Your changes to this template are not saved. Leave now and they are lost; Cancel keeps you here to save them."
      />
    </div>
  );
}
