import type { ReactNode } from 'react';
import {
  AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS,
  type AgencyCampaignTemplateSectionKey,
  type AgencyCampaignTemplateSectionSource,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { SECTION_LABELS } from '../../../utils/agency/campaignTemplates/templateForm';
import { SOURCE_CHIP_LABELS } from '../../../utils/agency/campaignTemplates/templateCopy';
import templateStyles from './CampaignTemplates.module.css';
import styles from './SectionSource.module.css';

/** What a section's Reset says, by section, where the label alone would not say it. */
const RESET_HINTS: Partial<Record<AgencyCampaignTemplateSectionKey, string>> = {
  outcomes: 'The buttons and what unanswered calls are filed as go together: Reset puts both back.',
  recording: 'Recording and the call summary go together: Reset puts both back.',
  agent_screen: 'The daily target, how the number is shown and the script go together: Reset puts all three back.',
  wrapup: 'The wrap-up time, what agents do after it and redial from wrap-up go together: Reset puts all three back.',
};

export interface SectionSourceProps {
  section: AgencyCampaignTemplateSectionKey;
  /** Where the section's settings come from now; nothing is shown for `null` (no template, or numbers left to the operator). */
  source?: AgencyCampaignTemplateSectionSource | null;
  /** Put the section back as the template filled it in; offered once it is changed. */
  onReset?: () => void;
}

/**
 * Where one template section's settings came from, and its Reset (CS18): the chip ("Account
 * template", "Organisation template", "Built-in", "Changed for this campaign") and, once changed,
 * Reset. New campaign places one at the heading of each block that edits a section, through the
 * steps' `sectionSources` prop; the steps know nothing of templates.
 */
export function SectionSource({ section, source, onReset }: SectionSourceProps) {
  if (!source) return null;
  const label = SECTION_LABELS[section];
  const name = label.toLowerCase();
  const hint = RESET_HINTS[section];
  return (
    <span className={styles.source} data-testid={`section-source-${section}`}>
      <span className={templateStyles.srOnly}>{`${label}: `}</span>
      <span className={templateStyles.source} data-source={source} data-testid="section-source-chip" title={hint}>
        {SOURCE_CHIP_LABELS[source]}
      </span>
      {source === 'campaign' && onReset ? (
        <button
          type="button"
          className={styles.reset}
          onClick={onReset}
          aria-label={`Reset ${name} to the template`}
          title={hint}
        >
          Reset
        </button>
      ) : null}
    </span>
  );
}

/** Each section's piece, as the steps' `sectionSources` prop takes them. */
export type SectionSources = Partial<Record<AgencyCampaignTemplateSectionKey, ReactNode>>;

/**
 * One {@link SectionSource} per section, from `useBuilderTemplate`'s `sourceProps`; `undefined`
 * without a template, so the steps show nothing.
 */
export function sectionSourcesOf(
  on: boolean,
  sourceProps: (key: AgencyCampaignTemplateSectionKey) => Omit<SectionSourceProps, 'section'>,
): SectionSources | undefined {
  if (!on) return undefined;
  return Object.fromEntries(
    AGENCY_CAMPAIGN_TEMPLATE_SECTION_KEYS.map((key) => [key, <SectionSource key={key} section={key} {...sourceProps(key)} />]),
  ) as SectionSources;
}
