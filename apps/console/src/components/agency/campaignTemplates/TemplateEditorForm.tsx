import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AGENCY_CAMPAIGN_TEMPLATE_DESCRIPTION_MAX,
  AGENCY_CAMPAIGN_TEMPLATE_NAME_MAX,
  type AgencyCampaignTemplateScope,
  type AgencyCampaignTemplateSectionKey,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import type { AgencyCarrier } from '@magick-agency/contracts/api/agency/agency-campaign';
import { focusFirstFieldError } from '../../../pages/campaigns/agency/configFieldErrors';
import { SetupCard, StepCards } from '../../campaign-setup';
import { templateTabOf, templateTabs, type TemplateTabId } from '../../../utils/agency/campaignTemplates/templateTabs';
import { TemplateSectionCard } from './TemplateSectionCard';
import { TemplateSectionEditors } from './TemplateSectionEditors';
import type { useTemplateEditor } from './useTemplateEditor';
import styles from './CampaignTemplates.module.css';

/** The tabs' ids and their panels' (`StepCards` names the panels the same way). */
const TABS_ID = 'template-editor';
const panelId = (tab: TemplateTabId) => `${TABS_ID}-panel-${tab}`;

/**
 * The template editor's form (CS21): at the top the name, the description and an account
 * template's "Based on" ("About this template"); then the campaign setup's step cards as tabs
 * (`StepCards`, as campaign Settings has them), less Customers, each tab holding the cards of the
 * shown sections it edits (`templateTabs`), "Use <what it follows>" or "Set in this template"; and
 * a slim bar stuck to the bottom with Discard and Save, which on a phone covers little of the
 * screen (U4). A tab with a section to fix carries the needs-fixing mark, one with a section
 * changed since the save the unsaved dot. When a field holds Save back, the bar's note brings
 * forward the tab holding it and takes the person to it (U13). Every panel stays mounted, so no
 * section's editor loses its place on a tab change. State and saving are `useTemplateEditor`'s.
 *
 * `readOnly` (L4): a template the reader may look at here but not change (an organisation
 * template opened from an account's page): the description as text, the same tabs with each
 * card's summary and where it comes from, no choices, no editors, no bar.
 */
export function TemplateEditorForm({
  editor,
  scope,
  visible,
  recordingEnabled,
  analyticsEnabled,
  carriers,
  onSave,
  readOnly = false,
}: {
  editor: ReturnType<typeof useTemplateEditor>;
  /** The template's own scope. */
  scope: AgencyCampaignTemplateScope;
  visible: readonly AgencyCampaignTemplateSectionKey[];
  recordingEnabled: boolean;
  analyticsEnabled: boolean;
  carriers: readonly AgencyCarrier[] | null;
  onSave: () => void;
  readOnly?: boolean;
}) {
  const fieldId = useId();
  const formRef = useRef<HTMLDivElement>(null);
  const tabs = useMemo(() => templateTabs(visible), [visible]);
  const [chosenTab, setTab] = useState<TemplateTabId | null>(null);
  // The first tab until one is chosen; a tab that went (a flag turned off) gives way to the first.
  const tab = tabs.find((t) => t.step.id === chosenTab)?.step.id ?? tabs[0]?.step.id ?? 'agents';
  const invalidTabs = useMemo(() => new Set([...editor.invalidSections].map(templateTabOf)), [editor.invalidSections]);
  const unsavedTabs = useMemo(() => new Set([...editor.changedSections].map(templateTabOf)), [editor.changedSections]);

  /** A tab whose first field with a finding takes focus, once it is on screen. */
  const [focusRequest, setFocusRequest] = useState<{ tab: TemplateTabId } | null>(null);
  useEffect(() => {
    if (!focusRequest) return;
    const panel = document.getElementById(panelId(focusRequest.tab));
    if (panel) focusFirstFieldError(panel);
  }, [focusRequest]);

  const { form, data } = editor;
  if (!form) return null;
  const { organisationTemplates, organisationDefault, template } = data;
  // A based-on that is no longer live (archived through a race) still shows as what it is (CTC5).
  const basedOnGone = editor.basedOnId !== null && !organisationTemplates.some((t) => t.id === editor.basedOnId);
  const fixable = editor.blocked || editor.hasFieldErrors;

  // Read-only, the page says whose template it is; the card only carries a description.
  const about = readOnly ? (
    template?.description ? (
      <SetupCard title="About this template" density="slim" testId="template-about">
        <p className={styles.description}>{template.description}</p>
      </SetupCard>
    ) : null
  ) : (
    <SetupCard title="About this template" testId="template-about">
      <div className={styles.aboutFields}>
        <div className="form-group">
          <label htmlFor={`${fieldId}-name`}>
            Name<span className="required-star">*</span>
          </label>
          <input
            id={`${fieldId}-name`}
            value={editor.name}
            maxLength={AGENCY_CAMPAIGN_TEMPLATE_NAME_MAX}
            onChange={(e) => editor.setName(e.target.value)}
            aria-invalid={editor.nameError ? true : undefined}
            aria-describedby={editor.nameError ? `${fieldId}-name-error` : undefined}
          />
          {editor.nameError ? (
            <p className={styles.fieldError} id={`${fieldId}-name-error`} role="alert">
              {editor.nameError}
            </p>
          ) : null}
        </div>
        <div className="form-group">
          <label htmlFor={`${fieldId}-description`}>Description (optional)</label>
          <input
            id={`${fieldId}-description`}
            value={editor.description}
            maxLength={AGENCY_CAMPAIGN_TEMPLATE_DESCRIPTION_MAX}
            onChange={(e) => editor.setDescription(e.target.value)}
          />
        </div>
        {scope === 'account' ? (
          <div className="form-group">
            <label htmlFor={`${fieldId}-based-on`}>Based on</label>
            <select
              id={`${fieldId}-based-on`}
              value={editor.basedOnId ?? ''}
              onChange={(e) => editor.setBasedOnId(e.target.value === '' ? null : e.target.value)}
            >
              <option value="">
                {organisationDefault ? `Organisation’s default (now ${organisationDefault.name})` : 'Organisation’s default'}
              </option>
              {organisationTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
              {basedOnGone ? (
                <option value={editor.basedOnId!}>{`${template?.based_on?.name ?? 'Its organisation template'} (archived)`}</option>
              ) : null}
            </select>
          </div>
        ) : null}
      </div>
    </SetupCard>
  );

  /** The tab holding a finding (the one on screen first), brought forward with its first field focused. */
  const showProblem = () => {
    const target = invalidTabs.has(tab) ? tab : tabs.find((t) => invalidTabs.has(t.step.id))?.step.id;
    if (target === undefined) {
      if (formRef.current) focusFirstFieldError(formRef.current);
      return;
    }
    setTab(target);
    setFocusRequest({ tab: target });
  };

  return (
    <div className={styles.form} ref={formRef}>
      {about}

      <StepCards
        mode="tabs"
        idPrefix={TABS_ID}
        label="Template settings"
        steps={tabs.map((t) => t.step)}
        current={tab}
        onSelect={(next) => setTab(next as TemplateTabId)}
        invalid={invalidTabs}
        unsaved={readOnly ? undefined : unsavedTabs}
      />

      {tabs.map(({ step, sections }) => (
        <div
          key={step.id}
          role="tabpanel"
          id={panelId(step.id)}
          aria-labelledby={`${TABS_ID}-tab-${step.id}`}
          hidden={tab !== step.id}
          tabIndex={0}
          className={styles.panel}
          data-testid={panelId(step.id)}
        >
          {sections.map((key) => (
            <TemplateSectionCard
              key={key}
              section={key}
              set={editor.setKeys.includes(key)}
              onSetChange={(next) => editor.setSection(key, next)}
              inheritLabel={editor.inheritLabelOf(key)}
              inheritedFrom={editor.inheritedFromOf(key)}
              summary={editor.summaryOf(key)}
              invalid={editor.invalidSections.has(key)}
              readOnly={readOnly}
            >
              <TemplateSectionEditors
                section={key}
                form={form}
                onChange={editor.setForm}
                scope={scope}
                liveErrors={editor.liveErrors}
                serverErrors={editor.serverErrors}
                recordingEnabled={recordingEnabled}
                analyticsEnabled={analyticsEnabled}
                carriers={carriers}
                epoch={editor.epoch}
                savedProfileId={editor.savedProfileId}
              />
            </TemplateSectionCard>
          ))}
        </div>
      ))}

      {readOnly ? null : (
        <div className={styles.saveBar} role="region" aria-label="Save the template" data-testid="template-save-bar">
          <div className={styles.saveBarNote} aria-live="polite">
            {fixable ? (
              <button
                type="button"
                className={styles.linkButton}
                onClick={showProblem}
                data-testid="template-show-problem"
              >
                Fix the marked settings to save.
              </button>
            ) : editor.dirty ? (
              <span>Changes not saved yet.</span>
            ) : null}
          </div>
          <div className={styles.saveBarActions}>
            <button type="button" className="btn-secondary" onClick={editor.discard} disabled={!editor.dirty || editor.saving || editor.isNew}>
              Discard
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={onSave}
              disabled={editor.saving || editor.blocked || (!editor.dirty && !editor.isNew)}
            >
              {editor.saving ? 'Saving…' : 'Save template'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
