import { useId, type ReactNode } from 'react';
import type { AgencyCampaignTemplateSectionKey } from '@magick-agency/contracts/api/agency/campaign-templates';
import { SECTION_LABELS } from '../../../utils/agency/campaignTemplates/templateForm';
import styles from './CampaignTemplates.module.css';

/**
 * One section of a template in the editor: its name, its values in one line, and a two-option
 * choice, as a radio group: "Use <what it follows>" (the organisation template an account template
 * follows, or the built-in settings) or "Set in this template". Set, the card opens with the
 * section's editors; not set, it shows the inherited values, dimmed (CT2).
 */
export function TemplateSectionCard({
  section,
  set,
  onSetChange,
  inheritLabel,
  summary,
  children,
  invalid = false,
}: {
  section: AgencyCampaignTemplateSectionKey;
  set: boolean;
  onSetChange: (set: boolean) => void;
  /** "Use Collections (organisation)", "Use organisation's default", "Built-in". */
  inheritLabel: string;
  /** The section's values in plain words: the template's when set, else what it inherits. */
  summary: string;
  children: ReactNode;
  /** A field of the section has an error. */
  invalid?: boolean;
}) {
  const id = useId();
  const name = `${id}-mode`;
  const label = SECTION_LABELS[section];
  return (
    <section
      className={styles.card}
      aria-labelledby={`${id}-title`}
      data-testid={`template-section-${section}`}
      data-set={set || undefined}
      data-invalid={invalid || undefined}
    >
      <header className={styles.cardHeader}>
        <div>
          <h2 className={styles.cardTitle} id={`${id}-title`}>
            {label}
          </h2>
          <p className={styles.summary} data-inherited={set ? undefined : ''} data-testid={`template-summary-${section}`}>
            {summary}
          </p>
        </div>
        <fieldset className={styles.segmented} role="radiogroup" aria-label={`${label}: where it comes from`}>
          <legend>{`${label}: where it comes from`}</legend>
          <label className={styles.segment}>
            <input type="radio" name={name} checked={!set} onChange={() => onSetChange(false)} />
            <span>{inheritLabel}</span>
          </label>
          <label className={styles.segment}>
            <input type="radio" name={name} checked={set} onChange={() => onSetChange(true)} />
            <span>Set in this template</span>
          </label>
        </fieldset>
      </header>
      {set ? <div className={styles.cardBody}>{children}</div> : null}
    </section>
  );
}
