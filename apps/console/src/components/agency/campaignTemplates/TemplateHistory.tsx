import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import type { AgencyCampaignTemplateSections } from '@magick-agency/contracts/api/agency/campaign-templates';
import { diffSections } from '@magick-agency/domain/campaign-templates';
import { useTenant } from '../../../contexts/TenantContext';
import { getCampaignTemplateVersion, listCampaignTemplateVersions } from '../../../api/campaignTemplates';
import { actorLabel, formatStamp } from '../../../utils/agency/campaignTemplates/templateCopy';
import { SECTION_LABELS } from '../../../utils/agency/campaignTemplates/templateForm';
import { SectionDiffList, type DiffExtraRow } from './SectionDiffList';
import styles from './CampaignTemplates.module.css';

const CURRENT = 'current';

/** What a version is besides its sections: its name and the organisation template it is based on. */
interface VersionHead {
  name: string;
  basedOnId: string | null;
}

/**
 * A template's history (CT6): every saved version, newest first, and a side-by-side comparison of
 * any two of them, or of one and the template as it is now, per section in plain words
 * (`diffSections`), with the name and "Based on" when those changed too (U11). A template with one
 * version has nothing to compare, and says so (N4).
 */
export function TemplateHistory({
  templateId,
  current,
  basedOnName,
}: {
  templateId: string;
  /** The template as it is now: its version, name, based-on and sections. */
  current: { version: number; sections: AgencyCampaignTemplateSections } & VersionHead;
  /** An organisation template's name by its id, as the reader can tell it. */
  basedOnName: (id: string) => string;
}) {
  const { tenantId, accountId } = useTenant();
  const id = useId();
  const fetchVersions = useCallback(
    () => listCampaignTemplateVersions(templateId, tenantId ?? undefined, accountId ?? undefined),
    // `current.version` reads the list again after a save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [templateId, tenantId, accountId, current.version],
  );
  const versions = useAsyncResource(fetchVersions, { initialData: [], errorMessage: 'Could not load the history.' });
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>(CURRENT);
  const [loaded, setLoaded] = useState<Record<number, AgencyCampaignTemplateSections>>({});
  const [error, setError] = useState<string | null>(null);
  /** The versions besides the current one: what "Compare" may pick. */
  const older = versions.data.filter((v) => v.version !== current.version);

  // Open on the version before the current one, against the current one; none when there is none.
  useEffect(() => {
    if (from !== '') return;
    const previous = older.find((v) => v.version < current.version) ?? older[0];
    if (previous) setFrom(String(previous.version));
  }, [older, from, current.version]);

  // Read each chosen version's sections once.
  useEffect(() => {
    for (const choice of [from, to]) {
      if (choice === '' || choice === CURRENT) continue;
      const n = Number(choice);
      if (loaded[n] !== undefined) continue;
      getCampaignTemplateVersion(templateId, n, tenantId ?? undefined, accountId ?? undefined)
        .then((v) => {
          setLoaded((all) => ({ ...all, [n]: v.sections }));
          setError(null);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load that version.'));
    }
  }, [from, to, loaded, templateId, tenantId, accountId]);

  const sectionsOf = (choice: string): AgencyCampaignTemplateSections | undefined =>
    choice === CURRENT ? current.sections : choice === '' ? undefined : loaded[Number(choice)];
  const headOf = (choice: string): VersionHead | undefined => {
    if (choice === CURRENT) return current;
    const v = versions.data.find((x) => String(x.version) === choice);
    return v ? { name: v.name, basedOnId: v.based_on_template_id } : undefined;
  };
  const labelOf = (choice: string) => (choice === CURRENT ? `Version ${current.version} (now)` : `Version ${choice}`);
  const a = sectionsOf(from);
  const b = sectionsOf(to);
  const diffs = useMemo(() => (a && b ? diffSections(a, b) : null), [a, b]);

  // The name and "Based on" are part of a version too (U11).
  const headA = headOf(from);
  const headB = headOf(to);
  const based = (head: VersionHead) => (head.basedOnId === null ? 'The organisation’s default' : basedOnName(head.basedOnId));
  const extra: DiffExtraRow[] = headA && headB
    ? [
      ...(headA.name !== headB.name ? [{ key: 'name', label: 'Name', from: headA.name, to: headB.name }] : []),
      ...(headA.basedOnId !== headB.basedOnId ? [{ key: 'based_on', label: 'Based on', from: based(headA), to: based(headB) }] : []),
    ]
    : [];

  const options = (
    <>
      <option value={CURRENT}>{`Version ${current.version} (now)`}</option>
      {/* The current version is "now"; it is not offered twice. */}
      {older.map((v) => (
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
      {!versions.loading && !versions.error && older.length === 0 ? (
        <p className={styles.muted} data-testid="history-only-version">
          This is the only version so far. Each save adds one you can compare with.
        </p>
      ) : older.length > 0 ? (
        <>
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
              extra={extra}
              from={{ label: labelOf(from), sections: a }}
              to={{ label: labelOf(to), sections: b }}
              empty="These two versions are the same."
              testId="history-diff"
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
