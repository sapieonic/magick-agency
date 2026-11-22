import { useId, useState } from 'react';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import type {
  AgencyCampaignTemplateScope,
  AgencyCampaignTemplateSections,
  AgencyCampaignTemplateSummary,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { sectionsFromCampaign } from '@magick-agency/domain/campaign-templates';
import { useTenant } from '../../../contexts/TenantContext';
import { getAgencyCampaign } from '../../../api/agencyCampaigns';
import { getCampaignTemplate } from '../../../api/campaignTemplates';
import { collectionsStarterNames, collectionsStarterOutcomes } from '../../../utils/agency/collectionsStarter';
import { templateRefusal } from '../../../utils/agency/campaignTemplates/templateCopy';
import { useAccountCampaigns } from './useAccountCampaigns';
import styles from './CampaignTemplates.module.css';

/** What a new template starts from (the editor's router state). */
export interface NewTemplateStart {
  sections: AgencyCampaignTemplateSections;
  name?: string;
  description?: string | null;
  basedOnId?: string | null;
}

type Choice = 'builtin' | 'collections' | 'template' | 'campaign';

/**
 * "New template": start from the built-in settings (nothing set), the Collections set (AS4) on
 * the outcomes, a copy of a template, or a copy of a campaign (`sectionsFromCampaign`, which leaves
 * an organisation template without the account's numbers and summary profile, CT5).
 */
export function NewTemplateDialog({
  open,
  onClose,
  scope,
  templates,
  onStart,
}: {
  open: boolean;
  onClose: () => void;
  scope: AgencyCampaignTemplateScope;
  /** The templates a copy may be made of. */
  templates: readonly AgencyCampaignTemplateSummary[];
  onStart: (start: NewTemplateStart) => void;
}) {
  const { tenantId, accountId } = useTenant();
  const id = useId();
  const [choice, setChoice] = useState<Choice>('builtin');
  const [templateId, setTemplateId] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const campaigns = useAccountCampaigns(open && choice === 'campaign');

  const ready = choice === 'template' ? templateId !== '' : choice === 'campaign' ? campaignId !== '' : true;

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      if (choice === 'builtin') onStart({ sections: {} });
      else if (choice === 'collections') {
        onStart({
          sections: sectionsFromCampaign(
            { disposition_catalog: collectionsStarterOutcomes(), outcome_dispositions: {} },
            scope,
            ['outcomes'],
          ),
          name: 'Collections',
        });
      } else if (choice === 'template') {
        const source = await getCampaignTemplate(templateId, tenantId ?? undefined, accountId ?? undefined);
        // An organisation template may not hold an account's parts (CT5): read through the same rule.
        const sections = scope === 'organisation' && source.scope === 'account'
          ? stripAccountOnly(source.sections)
          : source.sections;
        onStart({
          sections,
          name: `Copy of ${source.name}`,
          description: source.description,
          basedOnId: scope === 'account' && source.scope === 'account' ? source.based_on?.id ?? null : null,
        });
      } else {
        const campaign = await getAgencyCampaign(campaignId, tenantId ?? undefined, accountId ?? undefined);
        onStart({ sections: sectionsFromCampaign(campaign, scope), name: campaign.name });
      }
    } catch (err) {
      setError(templateRefusal(err, 'Could not read what to copy.'));
    } finally {
      setBusy(false);
    }
  };

  const option = (value: Choice, label: string, hint: string) => (
    <label className={styles.option}>
      <input type="radio" name={`${id}-start`} value={value} checked={choice === value} onChange={() => setChoice(value)} />
      <span>
        <strong>{label}</strong>
        <br />
        <span className={styles.muted}>{hint}</span>
      </span>
    </label>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New template"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={() => void go()} disabled={!ready || busy}>
            {busy ? 'Opening…' : 'Continue'}
          </button>
        </>
      }
    >
      <fieldset className={styles.options}>
        <legend className={styles.heading}>Start from</legend>
        {option('builtin', 'Built-in settings', scope === 'organisation'
          ? 'Nothing is set yet: every section uses the built-in settings until you set it.'
          : 'Nothing is set yet: every section follows the organisation’s template until you set it.')}
        {option('collections', 'The Collections set', `Outcomes made for collecting payments: ${collectionsStarterNames()}.`)}
        {option('template', 'A copy of a template', 'Every section that template sets.')}
        {choice === 'template' ? (
          <div className="form-group">
            <label htmlFor={`${id}-template`}>Template to copy</label>
            <select id={`${id}-template`} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Choose a template</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.scope === 'organisation' && scope === 'account' ? `${t.name} (organisation)` : t.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {option('campaign', 'A copy of a campaign', scope === 'organisation'
          ? 'Every setting of one of this account’s campaigns, except its numbers and call summary.'
          : 'Every setting of one of this account’s campaigns.')}
        {choice === 'campaign' ? (
          <div className="form-group">
            <label htmlFor={`${id}-campaign`}>Campaign to copy</label>
            <select id={`${id}-campaign`} value={campaignId} onChange={(e) => setCampaignId(e.target.value)} disabled={campaigns.loading}>
              <option value="">{campaigns.loading ? 'Loading campaigns…' : 'Choose a campaign'}</option>
              {campaigns.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </fieldset>
      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

/** Sections without the account-only parts (CT5): no numbers, no summary profile. */
function stripAccountOnly(sections: AgencyCampaignTemplateSections): AgencyCampaignTemplateSections {
  const { numbers: _numbers, recording, ...rest } = sections;
  if (!recording) return rest;
  const { analysis_profile_id: _profile, ...keep } = recording;
  return { ...rest, recording: keep };
}
