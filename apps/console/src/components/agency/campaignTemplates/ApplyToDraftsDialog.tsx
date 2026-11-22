import { useId, useMemo, useState } from 'react';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import {
  AGENCY_CAMPAIGN_TEMPLATE_APPLY_MAX_CAMPAIGNS,
  type AgencyCampaignTemplateApplyResult,
  type AgencyCampaignTemplateEffective,
  type AgencyCampaignTemplateScope,
  type AgencyCampaignTemplateSectionKey,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { diffSections, sectionsFromCampaign, type TemplateSectionDiff } from '@magick-agency/domain/campaign-templates';
import { useTenant } from '../../../contexts/TenantContext';
import { getAgencyCampaign } from '../../../api/agencyCampaigns';
import { applyCampaignTemplate, getEffectiveCampaignTemplate } from '../../../api/campaignTemplates';
import { trackAgencyCampaignTemplateApplied } from '../../../analytics/events';
import { SECTION_LABELS } from '../../../utils/agency/campaignTemplates/templateForm';
import { templateRefusal } from '../../../utils/agency/campaignTemplates/templateCopy';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import { SectionDiffList } from './SectionDiffList';
import { useAccountCampaigns } from './useAccountCampaigns';
import styles from './CampaignTemplates.module.css';

interface Preview {
  effective: AgencyCampaignTemplateEffective;
  campaigns: Array<{ campaign: AgencyCampaign; diffs: TemplateSectionDiff[] }>;
}

/**
 * "Apply to draft campaigns…" (CT16): choose draft campaigns of this account and the sections to
 * apply, see what would change in each (`diffSections` of the campaign against the template as
 * filled in for the account), apply, then each campaign's result. Never a running campaign: the
 * server refuses anything but a draft, for that campaign alone.
 */
export function ApplyToDraftsDialog({
  open,
  onClose,
  template,
  sections,
}: {
  open: boolean;
  onClose: () => void;
  template: { id: string; name: string; version: number; scope: AgencyCampaignTemplateScope; sections_set: readonly AgencyCampaignTemplateSectionKey[] };
  /** The sections that may be applied (the editor's visible ones). */
  sections: readonly AgencyCampaignTemplateSectionKey[];
}) {
  const { tenantId, accountId } = useTenant();
  const id = useId();
  const drafts = useAccountCampaigns(open, ['draft']);
  const [chosen, setChosen] = useState<string[]>([]);
  const initialSections = useMemo(() => {
    const set = sections.filter((k) => template.sections_set.includes(k));
    return set.length > 0 ? set : [...sections];
  }, [sections, template.sections_set]);
  const [keys, setKeys] = useState<AgencyCampaignTemplateSectionKey[]>(initialSections);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [results, setResults] = useState<AgencyCampaignTemplateApplyResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = <T,>(list: T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  const close = () => {
    setPreview(null);
    setResults(null);
    setError(null);
    setChosen([]);
    setKeys(initialSections);
    onClose();
  };
  const orderedKeys = sections.filter((k) => keys.includes(k));

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const [effective, ...campaigns] = await Promise.all([
        getEffectiveCampaignTemplate(template.id, tenantId ?? undefined, accountId ?? undefined),
        ...chosen.map((cid) => getAgencyCampaign(cid, tenantId ?? undefined, accountId ?? undefined)),
      ]);
      const filled = sectionsFromCampaign((effective as AgencyCampaignTemplateEffective).config, 'account', orderedKeys);
      setPreview({
        effective: effective as AgencyCampaignTemplateEffective,
        campaigns: (campaigns as AgencyCampaign[]).map((campaign) => ({
          campaign,
          diffs: diffSections(sectionsFromCampaign(campaign, 'account', orderedKeys), filled),
        })),
      });
    } catch (err) {
      setError(templateRefusal(err, 'Could not prepare the preview.'));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await applyCampaignTemplate(
        template.id,
        { campaign_ids: chosen, sections: orderedKeys, expected_version: template.version },
        tenantId ?? undefined,
        accountId ?? undefined,
      );
      setResults(res.results);
      trackAgencyCampaignTemplateApplied({
        scope: template.scope,
        campaign_count: chosen.length,
        applied_count: res.results.filter((r) => r.result === 'applied').length,
        refused_count: res.results.filter((r) => r.result === 'refused').length,
        section_count: orderedKeys.length,
      });
    } catch (err) {
      setError(templateRefusal(err, 'Could not apply the template.'));
    } finally {
      setBusy(false);
    }
  };

  const nameOf = (cid: string) =>
    preview?.campaigns.find((c) => c.campaign.id === cid)?.campaign.name ?? drafts.data.find((c) => c.id === cid)?.name ?? cid;

  const footer = results ? (
    <button type="button" className="btn-primary" onClick={close}>
      Done
    </button>
  ) : preview ? (
    <>
      <button type="button" className="btn-secondary" onClick={() => setPreview(null)} disabled={busy}>
        Back
      </button>
      <button type="button" className="btn-primary" onClick={() => void apply()} disabled={busy} data-testid="apply-confirm">
        {busy ? 'Applying…' : `Apply to ${chosen.length === 1 ? '1 campaign' : `${chosen.length} campaigns`}`}
      </button>
    </>
  ) : (
    <>
      <button type="button" className="btn-secondary" onClick={close}>
        Cancel
      </button>
      <button
        type="button"
        className="btn-primary"
        onClick={() => void runPreview()}
        disabled={busy || chosen.length === 0 || orderedKeys.length === 0}
        data-testid="apply-preview"
      >
        {busy ? 'Checking…' : 'See what changes'}
      </button>
    </>
  );

  return (
    <Modal open={open} onClose={close} title={`Apply “${template.name}” to draft campaigns`} size="lg" footer={footer}>
      {error ? (
        <p className={styles.fieldError} role="alert" data-testid="apply-error">
          {error}
        </p>
      ) : null}
      {results ? (
        <ul className={styles.list} data-testid="apply-results">
          {results.map((r) => (
            <li key={r.campaign_id} className={styles.result} data-result={r.result}>
              <strong>{nameOf(r.campaign_id)}</strong>
              {': '}
              {r.result === 'applied'
                ? r.changed_sections.length === 0
                  ? 'Applied. It already had these settings.'
                  : `Applied. Changed ${r.changed_sections.map((k) => SECTION_LABELS[k].toLowerCase()).join(', ')}.`
                : `Not changed. ${r.message}`}
            </li>
          ))}
        </ul>
      ) : preview ? (
        <div className={styles.cardBody} data-testid="apply-preview-list">
          <p className={styles.muted}>
            Only these draft campaigns change. A campaign that has been started since is left as it is.
          </p>
          {preview.campaigns.map(({ campaign, diffs }) => (
            <section key={campaign.id} aria-label={campaign.name}>
              <h3 className={styles.heading}>{campaign.name}</h3>
              <SectionDiffList
                diffs={diffs}
                from={{ label: 'Now', sections: sectionsFromCampaign(campaign, 'account', orderedKeys) }}
                to={{ label: 'After', config: preview.effective.config }}
                empty="Nothing changes: it already has these settings."
                testId={`apply-diff-${campaign.id}`}
              />
            </section>
          ))}
        </div>
      ) : (
        <div className={styles.cardBody}>
          <fieldset className={styles.checks}>
            <legend className={styles.heading}>Draft campaigns</legend>
            {drafts.loading ? <p className={styles.muted}>Loading draft campaigns…</p> : null}
            {!drafts.loading && drafts.data.length === 0 ? (
              <p className={styles.muted}>This account has no draft campaigns.</p>
            ) : null}
            {drafts.data.map((c) => (
              <label key={c.id} className={styles.option}>
                <input
                  type="checkbox"
                  checked={chosen.includes(c.id)}
                  disabled={!chosen.includes(c.id) && chosen.length >= AGENCY_CAMPAIGN_TEMPLATE_APPLY_MAX_CAMPAIGNS}
                  onChange={() => setChosen((list) => toggle(list, c.id))}
                />
                {c.name}
              </label>
            ))}
          </fieldset>
          <fieldset className={styles.checks} aria-describedby={`${id}-sections`}>
            <legend className={styles.heading}>Sections to apply</legend>
            <p className={styles.muted} id={`${id}-sections`}>
              Each section is applied as the template fills it in for this account.
            </p>
            {sections.map((k) => (
              <label key={k} className={styles.option}>
                <input type="checkbox" checked={keys.includes(k)} onChange={() => setKeys((list) => toggle(list, k))} />
                {SECTION_LABELS[k]}
              </label>
            ))}
          </fieldset>
        </div>
      )}
    </Modal>
  );
}
