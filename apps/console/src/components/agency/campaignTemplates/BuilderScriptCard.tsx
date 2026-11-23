import { useEffect, useState, type ReactNode } from 'react';
import { SetupCard } from '../../campaign-setup';
import { ScriptEditor } from '../../../pages/campaigns/agency/ScriptEditor';
import { useConfigFieldErrors } from '../../../pages/campaigns/agency/configFieldErrors';
import type { FactsForm, ScriptForm } from '../../../utils/agency/stationSettings';
import styles from './BuilderScriptCard.module.css';

/** What `useBuilderTemplate` gives for the template's script. */
export interface BuilderScript {
  value: ScriptForm;
  onChange: (next: ScriptForm) => void;
  errors: Record<string, string>;
  allowed: readonly string[];
  /** The roster's card once the import saved one; a card with no facts before. */
  facts: FactsForm;
}

/**
 * New campaign's script, on Purpose & buttons under the buttons, as campaign Settings shows its
 * Script (CS19): the script a campaign template brings, read-only with "Edit the script", which
 * opens the script editor. When the template's script uses a key the roster's card has no fact
 * for (CTC10, AS19), the draft has none for now: the card says why, in the server's words, with
 * the editor open on the card's keys; the page marks the step and holds its saves until it fits.
 */
export function BuilderScriptCard({
  script,
  source,
  campaignName,
  serverErrors,
}: {
  script: BuilderScript;
  /** The last save's refusals of the script, by field path: shown on its fields, the editor open. */
  serverErrors?: Record<string, string>;
  /** The agent screen section's source and Reset (CS18), in the card's heading. */
  source?: ReactNode;
  campaignName?: string;
}) {
  const problems = [...new Set(Object.values(script.errors))];
  const refused = serverErrors !== undefined && Object.keys(serverErrors).length > 0;
  const [open, setOpen] = useState(problems.length > 0 || refused);
  // A problem opens the editor, and it stays open once fixed, under the reader's hands.
  useEffect(() => {
    if (problems.length > 0 || refused) setOpen(true);
  }, [problems.length, refused]);
  const errors = useConfigFieldErrors({ ...script.errors, ...serverErrors });
  const steps = script.value.steps.filter((step) => step.trim() !== '');

  return (
    <SetupCard
      id="script"
      title="Script"
      helper="What agents say on a call, step by step, beside the buttons they pick. It came with the template; a change here is this campaign’s alone."
      actions={source}
      testId="builder-script"
    >
      {problems.length > 0 ? (
        // A status, not an alert: it changes with each key typed, and is read out when it does, not each time (U12).
        <div className={styles.problem} role="status" data-testid="script-problem" data-field-error>
          <p>
            The template’s script does not fit the card your customers gave this campaign, so the draft has no script
            yet. Change the script here, then save the campaign.
          </p>
          <ul className={styles.list}>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {open ? (
        <ScriptEditor
          value={script.value}
          onChange={script.onChange}
          errors={errors}
          facts={script.facts}
          offered={script.allowed}
          allowed={script.allowed}
          campaignName={campaignName}
          keysHint={script.facts.list.length === 0
            ? 'Until the customers’ card is saved, the script can use only the keys below.'
            : undefined}
        />
      ) : (
        <div className={styles.summary} data-testid="script-summary">
          {script.value.opening.trim() !== '' ? <p className={styles.opening}>{script.value.opening}</p> : null}
          {steps.length > 0 ? (
            <p className={styles.muted}>{steps.length === 1 ? 'Then 1 step.' : `Then ${steps.length} steps.`}</p>
          ) : null}
          <div>
            <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
              Edit the script
            </button>
          </div>
        </div>
      )}
    </SetupCard>
  );
}
