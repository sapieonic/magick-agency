import type {
  AgencyCampaignTemplateConfig,
  AgencyCampaignTemplateSectionKey,
  AgencyCampaignTemplateSections,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import type { TemplateSectionDiff } from '@magick-agency/domain/campaign-templates';
import { SECTION_LABELS } from '../../../utils/agency/campaignTemplates/templateForm';
import { diffWords, sectionSummary } from '../../../utils/agency/campaignTemplates/templateCopy';
import styles from './CampaignTemplates.module.css';

/** One side of a comparison: what it is called and what it holds (a template's sections, or a whole config). */
export interface DiffSide {
  label: string;
  /** `sections`: a template's (an unset section reads "Not set"); `config`: every section's fields. */
  sections?: AgencyCampaignTemplateSections;
  config?: AgencyCampaignTemplateConfig | Record<string, unknown>;
}

/** A difference that is not a section's (a version's name, its "Based on"), said as one. */
export interface DiffExtraRow {
  key: string;
  label: string;
  from: string;
  to: string;
}

function sideText(side: DiffSide, key: AgencyCampaignTemplateSectionKey): string {
  if (side.config) return sectionSummary(key, side.config);
  const values = side.sections?.[key];
  return values === undefined ? 'Not set' : sectionSummary(key, side.sections!);
}

/**
 * A comparison of two sets of settings, section by section, in plain words (`diffSections`, the
 * domain's rule): version history, "What's different from the template now" and the apply preview.
 */
export function SectionDiffList({
  diffs,
  extra = [],
  from,
  to,
  empty,
  testId = 'section-diff',
}: {
  diffs: readonly TemplateSectionDiff[];
  /** Differences listed before the sections' (U11). */
  extra?: readonly DiffExtraRow[];
  from: DiffSide;
  to: DiffSide;
  /** Said when nothing differs. */
  empty: string;
  testId?: string;
}) {
  if (diffs.length === 0 && extra.length === 0) {
    return (
      <p className={styles.muted} data-testid={`${testId}-empty`}>
        {empty}
      </p>
    );
  }
  return (
    <ul className={styles.diff} data-testid={testId}>
      {extra.map((row) => (
        <li key={row.key} className={styles.diffRow} data-section={row.key}>
          <div>
            <p className={styles.diffLabel}>{row.label}</p>
            <p className={styles.muted}>Changed</p>
          </div>
          <div>
            <p className={styles.diffHead}>{from.label}</p>
            <p className={styles.diffSide}>{row.from}</p>
          </div>
          <div>
            <p className={styles.diffHead}>{to.label}</p>
            <p className={styles.diffSide}>{row.to}</p>
          </div>
        </li>
      ))}
      {diffs.map((diff) => (
        <li key={diff.section} className={styles.diffRow} data-section={diff.section}>
          <div>
            <p className={styles.diffLabel}>{SECTION_LABELS[diff.section]}</p>
            <p className={styles.muted}>{diffWords(diff, { from: from.label, to: to.label })}</p>
          </div>
          <div>
            <p className={styles.diffHead}>{from.label}</p>
            <p className={styles.diffSide}>{sideText(from, diff.section)}</p>
          </div>
          <div>
            <p className={styles.diffHead}>{to.label}</p>
            <p className={styles.diffSide}>{sideText(to, diff.section)}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
