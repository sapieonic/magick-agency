import { useId, type ReactNode } from 'react';
import type { AgencyCampaignTemplateSectionKey } from '@magick-agency/contracts/api/agency/campaign-templates';
import { SECTION_LABELS } from '../../../utils/agency/campaignTemplates/templateForm';
import styles from './CampaignTemplates.module.css';

/**
 * One section of a template in the editor: its name, its values in one line, and a two-option
 * choice, as a radio group: "Use <what it follows>" (the organisation template an account template
 * follows, or the built-in settings) or "Set in this template". Set, the card opens with the
 * section's editors; not set, it shows the inherited values, dimmed (CT2). A section with a field
 * to fix is marked, in words as well as by its border (U13).
 *
 * `readOnly` (a template the reader may look at but not change here, L4): the summary and where it
 * comes from, as text; no choice and no editors.
 */
export function TemplateSectionCard({
  section,
  set,
  onSetChange,
  inheritLabel,
  inheritedFrom,
  summary,
  children,
  invalid = false,
  readOnly = false,
}: {
  section: AgencyCampaignTemplateSectionKey;
  set: boolean;
  onSetChange: (set: boolean) => void;
  /** "Use Collections", "Use the organisation's default", "Use built-in settings". */
  inheritLabel: string;
  /** Read-only: where an unset section comes from ("Built-in settings"). */
  inheritedFrom?: string;
  /** The section's values in plain words: the template's when set, else what it inherits. */
  summary: string;
  children?: ReactNode;
  /** A field of the section has an error. */
  invalid?: boolean;
  readOnly?: boolean;
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
        <div className={styles.cardHeading}>
          <div className={styles.cardTitleRow}>
            <h2 className={styles.cardTitle} id={`${id}-title`}>
              {label}
            </h2>
            {invalid ? <span className={styles.invalidChip}>Needs a fix</span> : null}
          </div>
          <p className={styles.summary} data-inherited={set ? undefined : ''} data-testid={`template-summary-${section}`}>
            {summary}
          </p>
        </div>
        {readOnly ? (
          <span className={styles.chip} data-testid={`template-from-${section}`}>
            {set ? 'Set in this template' : inheritedFrom ?? inheritLabel}
          </span>
        ) : (
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
        )}
      </header>
      {set && !readOnly ? <div className={styles.cardBody}>{children}</div> : null}
    </section>
  );
}
