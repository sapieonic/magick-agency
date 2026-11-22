import { useId, useState } from 'react';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import {
  AGENCY_CAMPAIGN_TEMPLATE_DESCRIPTION_MAX,
  AGENCY_CAMPAIGN_TEMPLATE_NAME_MAX,
  type AgencyCampaignTemplateScope,
  type AgencyCampaignTemplateSectionKey,
  type AgencyCampaignTemplateSummary,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { sectionsFromCampaign } from '@magick-agency/domain/campaign-templates';
import { useTenant } from '../../../contexts/TenantContext';
import { createCampaignTemplate, replaceCampaignTemplate } from '../../../api/campaignTemplates';
import { trackAgencyCampaignSavedAsTemplate } from '../../../analytics/events';
import { templateRefusal } from '../../../utils/agency/campaignTemplates/templateCopy';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import styles from './CampaignTemplates.module.css';

/**
 * Campaign Settings' "Save as template…": the campaign's saved settings as a new template, or in
 * place of an existing template's sections (`sectionsFromCampaign`; an organisation template
 * leaves out the account's numbers and summary profile, CT5). The replace sends the version the
 * list showed (`expected_version`), so a save made in between is refused rather than overwritten.
 */
export function SaveAsTemplateDialog({
  open,
  onClose,
  campaign,
  templates,
  sections,
  organisation,
}: {
  open: boolean;
  onClose: () => void;
  campaign: AgencyCampaign;
  /** The templates this reader may replace. */
  templates: readonly AgencyCampaignTemplateSummary[];
  /** The sections saved (those whose feature is on). */
  sections: readonly AgencyCampaignTemplateSectionKey[];
  /** The reader may write organisation templates. */
  organisation: boolean;
}) {
  const { tenantId, accountId } = useTenant();
  const { showToast } = useToast();
  const id = useId();
  const [mode, setMode] = useState<'new' | 'replace'>('new');
  const [name, setName] = useState(campaign.name.slice(0, AGENCY_CAMPAIGN_TEMPLATE_NAME_MAX));
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<AgencyCampaignTemplateScope>('account');
  const [replaceId, setReplaceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const replacing = templates.find((t) => t.id === replaceId) ?? null;
  const ready = mode === 'new' ? name.trim().length > 0 : replacing !== null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'new') {
        const created = await createCampaignTemplate(
          {
            scope,
            name: name.trim(),
            description: description.trim() === '' ? null : description.trim(),
            sections: sectionsFromCampaign(campaign, scope, sections),
          },
          tenantId ?? undefined,
          accountId ?? undefined,
        );
        showToast(`Template “${created.name}” created from this campaign.`, 'success');
      } else if (replacing) {
        const saved = await replaceCampaignTemplate(
          replacing.id,
          replacing.scope,
          {
            name: replacing.name,
            description: replacing.description,
            based_on_template_id: replacing.based_on?.id ?? null,
            sections: sectionsFromCampaign(campaign, replacing.scope, sections),
            expected_version: replacing.version,
          },
          tenantId ?? undefined,
          accountId ?? undefined,
        );
        showToast(`“${saved.name}” now has this campaign’s settings (version ${saved.version}).`, 'success');
      }
      trackAgencyCampaignSavedAsTemplate({ mode, scope: mode === 'new' ? scope : replacing!.scope });
      onClose();
    } catch (err) {
      setError(templateRefusal(err, 'Could not save the template.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save as template"
      subtitle="Uses this campaign’s saved settings. Changes not saved yet are left out."
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={() => void save()} disabled={!ready || busy}>
            {busy ? 'Saving…' : mode === 'new' ? 'Save template' : 'Replace its settings'}
          </button>
        </>
      }
    >
      <fieldset className={styles.options}>
        <legend className={styles.heading}>Save as</legend>
        <label className={styles.option}>
          <input type="radio" name={`${id}-mode`} checked={mode === 'new'} onChange={() => setMode('new')} />
          A new template
        </label>
        <label className={styles.option}>
          <input
            type="radio"
            name={`${id}-mode`}
            checked={mode === 'replace'}
            onChange={() => setMode('replace')}
            disabled={templates.length === 0}
          />
          The settings of an existing template
        </label>
      </fieldset>
      {mode === 'new' ? (
        <>
          <div className="form-group">
            <label htmlFor={`${id}-name`}>Name</label>
            <input id={`${id}-name`} value={name} maxLength={AGENCY_CAMPAIGN_TEMPLATE_NAME_MAX} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor={`${id}-description`}>Description (optional)</label>
            <input
              id={`${id}-description`}
              value={description}
              maxLength={AGENCY_CAMPAIGN_TEMPLATE_DESCRIPTION_MAX}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {organisation ? (
            <div className="form-group">
              <label htmlFor={`${id}-scope`}>For</label>
              <select id={`${id}-scope`} value={scope} onChange={(e) => setScope(e.target.value as AgencyCampaignTemplateScope)}>
                <option value="account">This account</option>
                <option value="organisation">The whole organisation (without this account’s numbers and call summary)</option>
              </select>
            </div>
          ) : null}
        </>
      ) : (
        <div className="form-group">
          <label htmlFor={`${id}-replace`}>Template</label>
          <select id={`${id}-replace`} value={replaceId} onChange={(e) => setReplaceId(e.target.value)}>
            <option value="">Choose a template</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.scope === 'organisation' ? `${t.name} (organisation)` : t.name}
              </option>
            ))}
          </select>
          {replacing ? (
            <p className={styles.muted}>
              {`Every section of “${replacing.name}” is set from this campaign, as version ${replacing.version + 1}. Campaigns already made from it do not change.`}
            </p>
          ) : null}
        </div>
      )}
      {error ? (
        <p className={styles.fieldError} role="alert" data-testid="save-as-template-error">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
