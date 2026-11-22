import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import type { AgencyCampaignTemplateSections } from '@magick-agency/contracts/api/agency/campaign-templates';
import { diffSections } from '@magick-agency/domain/campaign-templates';
import { useTenant } from '../../../contexts/TenantContext';
import { getCampaignTemplateVersion, listCampaignTemplateVersions } from '../../../api/campaignTemplates';
import { actorLabel, formatStamp } from '../../../utils/agency/campaignTemplates/templateCopy';
import { SECTION_LABELS } from '../../../utils/agency/campaignTemplates/templateForm';
import { SectionDiffList } from './SectionDiffList';
import styles from './CampaignTemplates.module.css';

const CURRENT = 'current';

/**
 * A template's history (CT6): every saved version, newest first, and a side-by-side comparison of
 * any two of them, or of one and the template as it is now, per section in plain words
 * (`diffSections`).
 */
export function TemplateHistory({
  templateId,
  current,
}: {
  templateId: string;
  /** The template as it is now: its version and its sections. */
  current: { version: number; sections: AgencyCampaignTemplateSections };
}) {
  const { tenantId, accountId } = useTenant();
  const id = useId();
  const fetchVersions = useCallback(
    () => listCampaignTemplateVersions(templateId, tenantId ?? undefined, accountId ?? undefined),
    [templateId, tenantId, accountId, current.version],
  );
  const versions = useAsyncResource(fetchVersions, { initialData: [], errorMessage: 'Could not load the history.' });
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>(CURRENT);
  const [loaded, setLoaded] = useState<Record<number, AgencyCampaignTemplateSections>>({});
  const [error, setError] = useState<string | null>(null);

  // Open on the version before the current one, against the current one.
  useEffect(() => {
    if (from !== '' || versions.data.length === 0) return;
    const previous = versions.data.find((v) => v.version < current.version) ?? versions.data[0]!;
    setFrom(String(previous.version));
  }, [versions.data, from, current.version]);

  // Read each chosen version's sections once.
  useEffect(() => {
    for (const choice of [from, to]) {
      if (choice === '' || choice === CURRENT) continue;
      const n = Number(choice);
      if (loaded[n] !== undefined) continue;
      getCampaignTemplateVersion(templateId, n, tenantId ?? undefined, accountId ?? undefined)
        .then((v) => setLoaded((all) => ({ ...all, [n]: v.sections })))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load that version.'));
    }
  }, [from, to, loaded, templateId, tenantId, accountId]);

  const sectionsOf = (choice: string): AgencyCampaignTemplateSections | undefined =>
    choice === CURRENT ? current.sections : choice === '' ? undefined : loaded[Number(choice)];
  const labelOf = (choice: string) => (choice === CURRENT ? `Now (version ${current.version})` : `Version ${choice}`);
  const a = sectionsOf(from);
  const b = sectionsOf(to);
  const diffs = useMemo(() => (a && b ? diffSections(a, b) : null), [a, b]);

  const options = (
    <>
      <option value={CURRENT}>{`Now (version ${current.version})`}</option>
      {versions.data.map((v) => (
        <option key={v.version} value={String(v.version)}>
          {`Version ${v.version}`}
        </option>
      ))}
    </>
  );

  return (
    <div className={styles.cardBody} data-testid="template-history">
      {versions.error ? <p className={styles.fieldError}>{versions.error}</p> : null}
      <ol className={styles.list} aria-label="Versions">
        {versions.data.map((v) => (
          <li key={v.version} className={styles.meta} data-testid={`template-version-${v.version}`}>
            {`Version ${v.version} · ${actorLabel(v.saved_by) ? `saved by ${actorLabel(v.saved_by)} on ` : 'saved on '}${formatStamp(v.saved_at)}`}
            {v.sections_set.length > 0 ? ` · ${v.sections_set.map((k) => SECTION_LABELS[k]).join(', ')}` : ' · sets nothing'}
          </li>
        ))}
      </ol>
      <div className={styles.toolbar}>
        <div className="form-group">
          <label htmlFor={`${id}-from`}>Compare</label>
          <select id={`${id}-from`} value={from} onChange={(e) => setFrom(e.target.value)}>
            {from === '' ? <option value="">Choose a version</option> : null}
            {options}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor={`${id}-to`}>With</label>
          <select id={`${id}-to`} value={to} onChange={(e) => setTo(e.target.value)}>
            {options}
          </select>
        </div>
      </div>
      {error ? <p className={styles.fieldError}>{error}</p> : null}
      {diffs && a && b ? (
        <SectionDiffList
          diffs={diffs}
          from={{ label: labelOf(from), sections: a }}
          to={{ label: labelOf(to), sections: b }}
          empty="These two versions set the same values."
          testId="history-diff"
        />
      ) : null}
    </div>
  );
}
