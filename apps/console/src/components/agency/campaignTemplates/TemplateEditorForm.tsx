import { useId } from 'react';
import {
  AGENCY_CAMPAIGN_TEMPLATE_DESCRIPTION_MAX,
  AGENCY_CAMPAIGN_TEMPLATE_NAME_MAX,
  type AgencyCampaignTemplateScope,
  type AgencyCampaignTemplateSectionKey,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import type { AgencyCarrier } from '@magick-agency/contracts/api/agency/agency-campaign';
import { TemplateSectionCard } from './TemplateSectionCard';
import { TemplateSectionEditors } from './TemplateSectionEditors';
import type { useTemplateEditor } from './useTemplateEditor';
import styles from './CampaignTemplates.module.css';

/**
 * The template editor's form: one card per shown section in the §3 order, "Use <what it follows>"
 * or "Set in this template", and the footer with the name, the description, an account template's
 * "Based on", Discard and Save. State and saving are `useTemplateEditor`'s.
 */
export function TemplateEditorForm({
  editor,
  scope,
  visible,
  recordingEnabled,
  analyticsEnabled,
  carriers,
  onSave,
}: {
  editor: ReturnType<typeof useTemplateEditor>;
  scope: AgencyCampaignTemplateScope;
  visible: readonly AgencyCampaignTemplateSectionKey[];
  recordingEnabled: boolean;
  analyticsEnabled: boolean;
  carriers: readonly AgencyCarrier[] | null;
  onSave: () => void;
}) {
  const fieldId = useId();
  const { form, data } = editor;
  if (!form) return null;
  const { organisationTemplates, organisationDefault, template } = data;
  // A based-on that is no longer live (archived through a race) still shows as what it is (C5).
  const basedOnGone = editor.basedOnId !== null && !organisationTemplates.some((t) => t.id === editor.basedOnId);

  return (
    <>
      {visible.map((key) => (
        <TemplateSectionCard
          key={key}
          section={key}
          set={editor.setKeys.includes(key)}
          onSetChange={(next) => editor.setSection(key, next)}
          inheritLabel={editor.inheritLabel}
          summary={editor.summaryOf(key)}
          invalid={editor.invalidSections.has(key)}
        >
          <TemplateSectionEditors
            section={key}
            form={form}
            onChange={editor.setForm}
            scope={scope}
            fieldErrors={editor.shownErrors}
            recordingEnabled={recordingEnabled}
            analyticsEnabled={analyticsEnabled}
            carriers={carriers}
            epoch={editor.epoch}
          />
        </TemplateSectionCard>
      ))}

      <div className={styles.footer} role="region" aria-label="Save the template">
        <div className={styles.footerFields}>
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
        <div className={styles.actions}>
          {editor.blocked ? <span className={styles.muted}>Fix the marked settings to save.</span> : null}
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
    </>
  );
}
