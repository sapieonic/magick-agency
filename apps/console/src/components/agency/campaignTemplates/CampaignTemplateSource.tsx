import { useCallback, useMemo, useState } from 'react';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import {
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  type AgencyCampaignTemplateSummary,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { diffSections, sectionsFromCampaign, type TemplateSectionDiff } from '@magick-agency/domain/campaign-templates';
import { useTenant } from '../../../contexts/TenantContext';
import { useFeatureFlagEnabled } from '../../../hooks/useFeatureFlagEnabled';
import { getCampaignTemplate, getEffectiveCampaignTemplate, listCampaignTemplates } from '../../../api/campaignTemplates';
import { CONTACT_ASSIGNMENT_FLAG } from '../../../utils/agencyAssignmentCopy';
import { INBOUND_FLAG } from '../../../utils/inbound/inboundFlag';
import { templateRefusal } from '../../../utils/agency/campaignTemplates/templateCopy';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import { SectionDiffList } from './SectionDiffList';
import { SaveAsTemplateDialog } from './SaveAsTemplateDialog';
import { builtinEffective } from './useStartFrom';
import { useTemplatesAccess } from './useTemplatesAccess';
import styles from './CampaignTemplates.module.css';

/**
 * Campaign Settings' template line (`docs/campaign-templates.md` §7): "Started from <template>,
 * version n", that the template has moved on since (the campaign is not affected, CT1), "See what's
 * different from the template now" (`diffSections` of the campaign's saved settings against the
 * template as it fills in today), and "Save as template…". Nothing at all with the flag off.
 */
export function CampaignTemplateSource({ campaign }: { campaign: AgencyCampaign }) {
  const { tenantId, accountId } = useTenant();
  const access = useTemplatesAccess();
  const assignmentOn = useFeatureFlagEnabled(CONTACT_ASSIGNMENT_FLAG);
  const inboundOn = useFeatureFlagEnabled(INBOUND_FLAG);
  const source = campaign.template_source ?? null;
  const started = source?.template ?? null;
  const [comparing, setComparing] = useState(false);
  const [diff, setDiff] = useState<{ diffs: TemplateSectionDiff[]; config: Record<string, unknown> } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);

  /** The sections shown and compared: those whose feature is on for the account. */
  const sections = useMemo(
    () => AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.filter((k) => !(k === 'assignment' && !assignmentOn) && !(k === 'inbound' && !inboundOn)),
    [assignmentOn, inboundOn],
  );

  // The template as it is now: has it moved on, or been archived?
  const fetchNow = useCallback(
    () => getCampaignTemplate(started!.id, tenantId ?? undefined, accountId ?? undefined),
    [started, tenantId, accountId],
  );
  const now = useAsyncResource(fetchNow, { initialData: null as Awaited<ReturnType<typeof getCampaignTemplate>> | null, enabled: access.use && started !== null });

  // The templates "Save as template…" may replace.
  const fetchList = useCallback(() => listCampaignTemplates(tenantId ?? undefined, accountId ?? undefined), [tenantId, accountId]);
  const list = useAsyncResource(fetchList, {
    initialData: [] as AgencyCampaignTemplateSummary[],
    enabled: access.manage && saveOpen,
  });
  const replaceable = list.data.filter((t) => t.scope === 'account' || access.manageOrganisation);

  if (!access.use) return null;

  const compare = async () => {
    setComparing(true);
    setDiffError(null);
    try {
      const effective = started
        ? await getEffectiveCampaignTemplate(started.id, tenantId ?? undefined, accountId ?? undefined)
        : builtinEffective();
      const filled = sectionsFromCampaign(effective.config, 'account', sections);
      setDiff({
        diffs: diffSections(sectionsFromCampaign(campaign, 'account', sections), filled),
        config: effective.config as unknown as Record<string, unknown>,
      });
    } catch (err) {
      setDiffError(templateRefusal(err, 'Could not read the template.'));
    } finally {
      setComparing(false);
    }
  };

  const templateName = started?.name ?? 'the built-in settings';

  return (
    <section className={styles.banner} aria-label="Campaign template" data-testid="campaign-template-source">
      {source ? (
        <p data-testid="campaign-template-started">
          {started ? `Started from ${started.name}, version ${started.version}.` : 'Started from the built-in settings.'}
          {source.based_on ? ` Based on ${source.based_on.name}, version ${source.based_on.version}.` : ''}
        </p>
      ) : (
        <p>This campaign was not made from a template.</p>
      )}
      {now.data && now.data.archived_at ? (
        <p data-testid="campaign-template-moved">{`${now.data.name} has been archived since (this campaign is not affected).`}</p>
      ) : now.data && started && now.data.version !== started.version ? (
        <p data-testid="campaign-template-moved">
          {`${now.data.name} is now on version ${now.data.version} (this campaign is not affected).`}
        </p>
      ) : null}
      <div className={styles.actions}>
        {source ? (
          <button type="button" className={styles.linkButton} onClick={() => void compare()} disabled={comparing} aria-expanded={diff !== null}>
            {comparing ? 'Comparing…' : 'See what’s different from the template now'}
          </button>
        ) : null}
        {access.manage ? (
          <button type="button" className="btn-secondary" onClick={() => setSaveOpen(true)}>
            Save as template…
          </button>
        ) : null}
      </div>
      {diffError ? <p className={styles.fieldError}>{diffError}</p> : null}
      {diff ? (
        <SectionDiffList
          diffs={diff.diffs}
          from={{ label: 'This campaign', sections: sectionsFromCampaign(campaign, 'account', sections) }}
          to={{ label: started ? `${templateName} now` : 'Built-in now', config: diff.config }}
          empty={`This campaign has the same settings as ${templateName} fills in now.`}
          testId="campaign-template-diff"
        />
      ) : null}
      {saveOpen ? (
        <SaveAsTemplateDialog
          open
          onClose={() => setSaveOpen(false)}
          campaign={campaign}
          templates={replaceable}
          sections={sections}
          organisation={access.manageOrganisation}
        />
      ) : null}
    </section>
  );
}
