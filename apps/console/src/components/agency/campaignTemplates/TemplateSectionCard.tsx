import type { ReactNode } from 'react';
import type { AgencyCampaignTemplateSectionKey } from '@magick-agency/contracts/api/agency/campaign-templates';
import { PillGroup, SetupCard, StatusChip } from '../../campaign-setup';
import { SECTION_LABELS } from '../../../utils/agency/campaignTemplates/templateForm';
import styles from './CampaignTemplates.module.css';

type Choice = 'use' | 'set';

/**
 * One section of a template in the editor (CS21), drawn with the campaign setup's parts: a
 * `SetupCard` whose compact header holds the section's name, its values in one line, and the
 * two-option choice as a `PillGroup` (CT2): "Use <what it follows>" (the organisation template an
 * account template follows, or the built-in settings) or "Set in this template". The checked pill
 * is where the section comes from. Set, the card opens on the section's editors (the setup steps'
 * own blocks, `TemplateSectionEditors`); not set, only the inherited values show, dimmed. A
 * section with a field to fix is marked, in words as well as by its border (U13).
 *
 * `readOnly` (a template the reader may look at but not change here, L4): the summary and where it
 * comes from as a chip; no choice and no editors.
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
  const label = SECTION_LABELS[section];
  const open = set && !readOnly;
  const actions = (
    <>
      {invalid ? (
        <StatusChip tone="danger" testId={`template-invalid-${section}`}>
          Needs a fix
        </StatusChip>
      ) : null}
      {readOnly ? (
        <StatusChip tone={set ? 'info' : 'muted'} icon={null} testId={`template-from-${section}`}>
          {set ? 'Set in this template' : inheritedFrom ?? inheritLabel}
        </StatusChip>
      ) : (
        <PillGroup<Choice>
          legend={`${label}: where it comes from`}
          hideLegend
          size="sm"
          options={[
            { value: 'use', label: inheritLabel },
            { value: 'set', label: 'Set in this template' },
          ]}
          value={set ? 'set' : 'use'}
          onChange={(choice) => onSetChange(choice === 'set')}
          testId={`template-choice-${section}`}
        />
      )}
    </>
  );
  return (
    <div
      className={styles.sectionCard}
      data-testid={`template-section-${section}`}
      data-set={set || undefined}
      data-invalid={invalid || undefined}
    >
      <SetupCard
        title={label}
        helper={
          <span className={styles.summary} data-inherited={set ? undefined : ''} data-testid={`template-summary-${section}`}>
            {summary}
          </span>
        }
        actions={actions}
        density={open ? 'regular' : 'slim'}
      >
        {open ? children : null}
      </SetupCard>
    </div>
  );
}
