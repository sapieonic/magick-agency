import { useCallback, useState } from 'react';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import type {
  AgencyCampaignTemplateEffective,
  AgencyCampaignTemplateSummary,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { diffSections, sectionsFromCampaign } from '@magick-agency/domain/campaign-templates';
import { useTenant } from '../../../contexts/TenantContext';
import { getCampaignTemplate, getEffectiveCampaignTemplate, listCampaignTemplates } from '../../../api/campaignTemplates';
import { noteSentence, templateRefusal } from '../../../utils/agency/campaignTemplates/templateCopy';
import { formatDayMonth } from '../../../utils/format/date';
import { errorCode } from '../../../utils/agencyErrors';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import { SectionDiffList } from './SectionDiffList';
import { SaveAsTemplateDialog } from './SaveAsTemplateDialog';
import { builtinEffective } from './useStartFrom';
import { useTemplatesAccess } from './useTemplatesAccess';
import { useTemplateSectionKeys } from './useTemplateSectionKeys';
import styles from './CampaignTemplates.module.css';

/**
 * Campaign Settings' template line (`docs/campaign-templates.md` §7): "Started from <template>,
 * version n · created <date>", the notes of its filling-in as sentences, that the template has
 * moved on since or been archived (the campaign is not affected, CT1), "See what's different from
 * the template now" (`diffSections` of the campaign's saved settings against the template as it
 * fills in today; not for an archived template, which no longer fills in), and "Save as
 * template…". A campaign with no record (made before templates, or with them off) gets only Save
 * as template. Nothing at all with the flag off.
 *
 * The comparison leaves out numbers the template leaves on built-in: those are each campaign's
 * own, as New campaign treats them (U7). It is worked out from the campaign as it is now, so a
 * save of the campaign shows at once.
 */
export function CampaignTemplateSource({ campaign }: { campaign: AgencyCampaign }) {
  const { tenantId, accountId } = useTenant();
  const access = useTemplatesAccess();
  const source = campaign.template_source ?? null;
  const started = source?.template ?? null;
  const [comparing, setComparing] = useState(false);
  /** The template as it fills in now, read by "See what's different"; the comparison is made at render. */
  const [filledIn, setFilledIn] = useState<Pick<AgencyCampaignTemplateEffective, 'config' | 'sources'> | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);

  /** The sections shown and compared: those whose feature is on for the account. */
  const sections = useTemplateSectionKeys('account');

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

  // A campaign with no record has nothing to say but Save as template.
  if (!access.use || (source === null && !access.manage)) return null;

  const compare = async () => {
    setComparing(true);
    setDiffError(null);
    try {
      const effective = started
        ? await getEffectiveCampaignTemplate(started.id, tenantId ?? undefined, accountId ?? undefined)
        : builtinEffective();
      setFilledIn({ config: effective.config, sources: effective.sources });
    } catch (err) {
      setDiffError(errorCode(err) === 'campaign_template_archived'
        ? `${templateName} has since been archived, so there is nothing to compare with.`
        : templateRefusal(err, 'Could not read the template.'));
    } finally {
      setComparing(false);
    }
  };

  const templateName = started?.name ?? 'the built-in settings';
  const archived = Boolean(now.data?.archived_at);
  const created = campaign.created_at ? new Date(campaign.created_at) : null;
  const createdOn = created && !Number.isNaN(created.getTime()) ? ` · created ${formatDayMonth(created)}` : '';
  const notes = source?.notes ?? [];
  // Numbers the template leaves on built-in are this campaign's own: not a difference (U7).
  const compared = filledIn ? sections.filter((k) => k !== 'numbers' || filledIn.sources.numbers !== 'builtin') : [];
  const diffs = filledIn
    ? diffSections(sectionsFromCampaign(campaign, 'account', compared), sectionsFromCampaign(filledIn.config, 'account', compared))
    : null;

  return (
    <section className={styles.banner} aria-label="Campaign template" data-testid="campaign-template-source">
      {source ? (
        <p data-testid="campaign-template-started">
          {started ? `Started from ${started.name}, version ${started.version}${createdOn}.` : `Started from the built-in settings${createdOn}.`}
          {source.based_on ? ` Based on ${source.based_on.name}, version ${source.based_on.version}.` : ''}
        </p>
      ) : null}
      {notes.length > 0 ? (
        <ul className={styles.notes} data-testid="campaign-template-notes">
          {notes.map((note, i) => (
            <li key={`${note.code}-${note.section}-${i}`}>{noteSentence(note)}</li>
          ))}
        </ul>
      ) : null}
      {now.data && archived ? (
        <p data-testid="campaign-template-moved">{`${now.data.name} has since been archived (this campaign is not affected).`}</p>
      ) : now.data && started && now.data.version !== started.version ? (
        <p data-testid="campaign-template-moved">
          {`${now.data.name} is now on version ${now.data.version} (this campaign is not affected).`}
        </p>
      ) : null}
      <div className={styles.actions}>
        {source && !archived ? (
          <button type="button" className={styles.linkButton} onClick={() => void compare()} disabled={comparing} aria-expanded={filledIn !== null}>
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
      {filledIn && diffs ? (
        <SectionDiffList
          diffs={diffs}
          from={{ label: 'This campaign', sections: sectionsFromCampaign(campaign, 'account', compared) }}
          to={{ label: started ? `${templateName} now` : 'Built-in now', config: filledIn.config }}
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
          onReload={list.reload}
        />
      ) : null}
    </section>
  );
}
