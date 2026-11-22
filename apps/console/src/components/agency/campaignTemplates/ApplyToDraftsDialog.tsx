import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { mapWithConcurrency } from '@magick-agency/web-ui/concurrency';
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
import { applyCampaignTemplate, getCampaignTemplate, getEffectiveCampaignTemplate } from '../../../api/campaignTemplates';
import { errorCode } from '../../../utils/agencyErrors';
import { trackAgencyCampaignTemplateApplied } from '../../../analytics/events';
import { SECTION_LABELS } from '../../../utils/agency/campaignTemplates/templateForm';
import { detailSentences, refusalDetails, templateRefusal } from '../../../utils/agency/campaignTemplates/templateCopy';
import { plural } from '../../../utils/format/number';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import { SectionDiffList } from './SectionDiffList';
import { useAccountCampaigns } from './useAccountCampaigns';
import styles from './CampaignTemplates.module.css';

interface Preview {
  effective: AgencyCampaignTemplateEffective;
  campaigns: Array<{ campaign: AgencyCampaign; diffs: TemplateSectionDiff[] }>;
}

/** A refusal said in full: the sentence, then each of its details. */
interface Refusal {
  message: string;
  details: string[];
}

/** The drafts a preview reads at once (N6): at most 50 are chosen, and each is one request. */
const PREVIEW_READS_AT_ONCE = 6;

/** "Applied to 2 campaigns. 1 campaign not changed." */
function resultSummary(results: readonly AgencyCampaignTemplateApplyResult[]): string {
  const applied = results.filter((r) => r.result === 'applied').length;
  const refused = results.length - applied;
  return [
    ...(applied > 0 ? [`Applied to ${plural(applied, 'campaign')}.`] : []),
    ...(refused > 0 ? [`${plural(refused, 'campaign')} not changed.`] : []),
  ].join(' ');
}

/**
 * "Apply to draft campaigns…" (CT16): choose draft campaigns of this account and the sections to
 * apply, see what would change in each (`diffSections` of the campaign against the template as
 * filled in for the account), apply, then each campaign's result, a refused one with its reasons
 * (the refusal's `details`, as sentences). Never a running campaign: the server refuses anything
 * but a draft, for that campaign alone.
 *
 * The sections start as those the template sets, each time it opens (C7); none when it sets none.
 * Numbers are offered only when the template sets them: unset, the template has no numbers to
 * give, and the server refuses such an apply. A list that cannot be read says so, with Retry.
 * When someone saved the template in between (409), "Reload the latest version" reads it again
 * and the dialog stays open on the new version, back at the choice; `onReloaded` tells the editor
 * once the dialog closes. Closing it drops whatever is still being read (U10), and the preview and
 * the results are announced, with the focus moved to them (U12).
 */
export function ApplyToDraftsDialog({
  open,
  onClose,
  template,
  sections,
  accountName = null,
  onReloaded,
}: {
  open: boolean;
  onClose: () => void;
  template: { id: string; name: string; version: number; scope: AgencyCampaignTemplateScope; sections_set: readonly AgencyCampaignTemplateSectionKey[] };
  /** The sections that may be applied (the editor's visible ones). */
  sections: readonly AgencyCampaignTemplateSectionKey[];
  /** The account whose drafts change, named where it is not plain (the organisation's page). */
  accountName?: string | null;
  /** Called on close when the dialog read a newer version of the template. */
  onReloaded?: () => void;
}) {
  const { tenantId, accountId } = useTenant();
  const id = useId();
  const drafts = useAccountCampaigns(open, ['draft']);
  const [chosen, setChosen] = useState<string[]>([]);
  /** A newer version than the editor's, read after a 409. */
  const [latest, setLatest] = useState<typeof template | null>(null);
  const [stale, setStale] = useState(false);
  const current = latest ?? template;
  /** What may be applied: numbers only when the template sets them (U3). */
  const offered = useMemo(
    () => sections.filter((k) => k !== 'numbers' || current.sections_set.includes('numbers')),
    [sections, current.sections_set],
  );
  const initialSections = useMemo(() => offered.filter((k) => current.sections_set.includes(k)), [offered, current.sections_set]);
  const [keys, setKeys] = useState<AgencyCampaignTemplateSectionKey[]>(initialSections);
  // Each opening, and each version of the template, starts on the sections it sets.
  useEffect(() => {
    if (open) setKeys(initialSections);
  }, [open, initialSections]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [results, setResults] = useState<AgencyCampaignTemplateApplyResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Refusal | null>(null);
  /** Bumped on close: an answer that lands after it belongs to a dialog that is gone (U10). */
  const opening = useRef(0);
  const previewHeading = useRef<HTMLParagraphElement>(null);
  const summary = useRef<HTMLParagraphElement>(null);

  // The step that replaced the body takes the focus, whose button has gone (U12).
  useEffect(() => {
    if (results) summary.current?.focus();
    else if (preview) previewHeading.current?.focus();
  }, [results, preview]);

  const toggle = <T,>(list: T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  const close = () => {
    opening.current += 1;
    setPreview(null);
    setResults(null);
    setError(null);
    setStale(false);
    setBusy(false);
    setChosen([]);
    if (latest) onReloaded?.();
    setLatest(null);
    onClose();
  };

  /** Runs `work` while busy; what it sets after an await is dropped once the dialog has closed. */
  const run = async (work: (live: () => boolean) => Promise<void>, fallback: string) => {
    const at = opening.current;
    const live = () => opening.current === at;
    setBusy(true);
    setError(null);
    try {
      await work(live);
    } catch (err) {
      if (!live()) return;
      if (errorCode(err) === 'campaign_template_changed') setStale(true);
      else setError({ message: templateRefusal(err, fallback), details: refusalDetails(err) });
    } finally {
      if (live()) setBusy(false);
    }
  };

  const reload = () => run(async (live) => {
    const fresh = await getCampaignTemplate(template.id, tenantId ?? undefined, accountId ?? undefined);
    if (!live()) return;
    setLatest({ id: fresh.id, name: fresh.name, version: fresh.version, scope: fresh.scope, sections_set: fresh.sections_set });
    setStale(false);
    setPreview(null);
  }, 'Could not read the template.');

  const orderedKeys = offered.filter((k) => keys.includes(k));

  const runPreview = () => run(async (live) => {
    const [effective, read] = await Promise.all([
      getEffectiveCampaignTemplate(current.id, tenantId ?? undefined, accountId ?? undefined),
      mapWithConcurrency(chosen, (cid) => getAgencyCampaign(cid, tenantId ?? undefined, accountId ?? undefined), PREVIEW_READS_AT_ONCE),
    ]);
    const failed = read.find((r) => r.status === 'rejected');
    if (failed && failed.status === 'rejected') throw failed.reason;
    if (!live()) return;
    const campaigns = read.map((r) => (r as { value: AgencyCampaign }).value);
    const filled = sectionsFromCampaign(effective.config, 'account', orderedKeys);
    setPreview({
      effective,
      campaigns: campaigns.map((campaign) => ({
        campaign,
        diffs: diffSections(sectionsFromCampaign(campaign, 'account', orderedKeys), filled),
      })),
    });
  }, 'Could not prepare the preview.');

  const apply = () => run(async (live) => {
    const res = await applyCampaignTemplate(
      current.id,
      { campaign_ids: chosen, sections: orderedKeys, expected_version: current.version },
      tenantId ?? undefined,
      accountId ?? undefined,
    );
    if (!live()) return;
    setResults(res.results);
    trackAgencyCampaignTemplateApplied({
      scope: template.scope,
      campaign_count: chosen.length,
      applied_count: res.results.filter((r) => r.result === 'applied').length,
      refused_count: res.results.filter((r) => r.result === 'refused').length,
      section_count: orderedKeys.length,
    });
  }, 'Could not apply the template.');

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
      <button type="button" className="btn-primary" onClick={() => void apply()} disabled={busy || stale} data-testid="apply-confirm">
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
    <Modal
      open={open}
      onClose={close}
      title={`Apply “${current.name}” to draft campaigns${accountName ? ` of ${accountName}` : ''}`}
      size="lg"
      footer={footer}
    >
      {latest && !stale ? (
        <p className={styles.muted} role="status" data-testid="apply-reloaded">
          {`Now on version ${latest.version}. Check what changes again before you apply.`}
        </p>
      ) : null}
      {stale ? (
        <div className={styles.banner} role="alert" data-testid="apply-stale">
          <p>Someone else saved this template after you opened it. Nothing was applied.</p>
          <div>
            <button type="button" className="btn-primary" onClick={() => void reload()} disabled={busy}>
              Reload the latest version
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className={styles.fieldError} role="alert" data-testid="apply-error">
          <p className={styles.plain}>{error.message}</p>
          {error.details.length > 0 ? (
            <ul className={styles.notes}>
              {error.details.filter((d) => d !== error.message).map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {results ? (
        <>
          <p className={styles.heading} role="status" tabIndex={-1} ref={summary} data-testid="apply-summary">
            {resultSummary(results)}
          </p>
          <ul className={styles.list} data-testid="apply-results">
            {results.map((r) => {
              const reasons = r.result === 'refused' ? detailSentences(r.details ?? {}).filter((d) => d !== r.message) : [];
              return (
                <li key={r.campaign_id} className={styles.result} data-result={r.result}>
                  <strong>{nameOf(r.campaign_id)}</strong>
                  {': '}
                  {r.result === 'applied'
                    ? r.changed_sections.length === 0
                      ? 'Applied. It already had these settings.'
                      : `Applied. Changed ${r.changed_sections.map((k) => SECTION_LABELS[k].toLowerCase()).join(', ')}.`
                    : `Not changed. ${r.message}`}
                  {reasons.length > 0 ? (
                    <ul className={styles.notes} data-testid={`apply-refusal-${r.campaign_id}`}>
                      {reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : preview ? (
        <div className={styles.cardBody} data-testid="apply-preview-list">
          <p className={styles.muted} tabIndex={-1} ref={previewHeading}>
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
            {drafts.error ? (
              <ErrorAlert message="Could not load the draft campaigns." onRetry={() => void drafts.reload()} />
            ) : !drafts.loading && drafts.data.length === 0 ? (
              <p className={styles.muted}>{accountName ? `${accountName} has no draft campaigns.` : 'This account has no draft campaigns.'}</p>
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
              {offered.length < sections.length
                ? 'Each section is applied as the template fills it in for this account. Numbers are not offered: this template does not set them.'
                : 'Each section is applied as the template fills it in for this account.'}
            </p>
            {offered.map((k) => (
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
