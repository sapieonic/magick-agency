import { useId, useRef } from 'react';
import {
  AGENCY_CAMPAIGN_TEMPLATE_DESCRIPTION_MAX,
  AGENCY_CAMPAIGN_TEMPLATE_NAME_MAX,
  type AgencyCampaignTemplateScope,
  type AgencyCampaignTemplateSectionKey,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import type { AgencyCarrier } from '@magick-agency/contracts/api/agency/agency-campaign';
import { focusFirstFieldError } from '../../../pages/campaigns/agency/configFieldErrors';
import { TemplateSectionCard } from './TemplateSectionCard';
import { TemplateSectionEditors } from './TemplateSectionEditors';
import type { useTemplateEditor } from './useTemplateEditor';
import styles from './CampaignTemplates.module.css';

/**
 * The template editor's form: at the top the name, the description and an account template's
 * "Based on"; then one card per shown section in the §3 order, "Use <what it follows>" or "Set in
 * this template"; and a slim bar stuck to the bottom with Discard and Save, which on a phone
 * covers little of the screen (U4). When a field holds Save back, the bar's note takes the person
 * to it (U13). State and saving are `useTemplateEditor`'s.
 *
 * `readOnly` (L4): a template the reader may look at here but not change (an organisation
 * template opened from an account's page): the name and description as text, each card's summary
 * and where it comes from, no choices, no editors, no bar.
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
  const { form, data } = editor;
  if (!form) return null;
  const { organisationTemplates, organisationDefault, template } = data;
  // A based-on that is no longer live (archived through a race) still shows as what it is (C5).
  const basedOnGone = editor.basedOnId !== null && !organisationTemplates.some((t) => t.id === editor.basedOnId);
  const fixable = editor.blocked || editor.hasFieldErrors;

  const about = readOnly ? (
    <section className={styles.card} aria-label="About this template" data-testid="template-about">
      {template?.description ? <p className={styles.description}>{template.description}</p> : null}
      <p className={styles.muted}>
        {scope === 'organisation'
          ? 'An organisation template. You can see what it sets here; an organisation admin changes it.'
          : 'An account template. You can see what it sets here.'}
      </p>
    </section>
  ) : (
    <section className={styles.card} aria-label="About this template" data-testid="template-about">
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
    </section>
  );

  return (
    <div className={styles.form} ref={formRef}>
      {about}

      {visible.map((key) => (
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
            fieldErrors={editor.shownErrors}
            recordingEnabled={recordingEnabled}
            analyticsEnabled={analyticsEnabled}
            carriers={carriers}
            epoch={editor.epoch}
          />
        </TemplateSectionCard>
      ))}

      {readOnly ? null : (
        <div className={styles.saveBar} role="region" aria-label="Save the template" data-testid="template-save-bar">
          <div className={styles.saveBarNote} aria-live="polite">
            {fixable ? (
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  if (formRef.current) focusFirstFieldError(formRef.current);
                }}
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
