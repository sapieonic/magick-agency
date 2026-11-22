import { useState } from 'react';
import { ScriptEditor } from '../../../pages/campaigns/agency/ScriptEditor';
import { useConfigFieldErrors } from '../../../pages/campaigns/agency/configFieldErrors';
import type { FactsForm, ScriptForm } from '../../../utils/agency/stationSettings';
import styles from './CampaignTemplates.module.css';

/**
 * New campaign's Review, when the template's script uses a key the roster's card has no fact for
 * (C10, AS19): what is wrong, in the server's words, and the script editor on the card's keys.
 * Nothing while the script fits and the editor has not been opened.
 */
export function ReviewScriptFix({
  script,
}: {
  script: {
    value: ScriptForm;
    onChange: (next: ScriptForm) => void;
    errors: Record<string, string>;
    allowed: readonly string[];
    facts: FactsForm;
  };
}) {
  const [open, setOpen] = useState(false);
  const errors = useConfigFieldErrors(script.errors);
  const problems = [...new Set(Object.values(script.errors))];
  if (!open && problems.length === 0) return null;
  return (
    <div className={styles.banner} data-testid="review-script-fix">
      {problems.length > 0 ? (
        // A status, not an alert: it changes with each key typed, and is read out when it does, not each time (U12).
        <div role="status" data-testid="review-script-problem">
          <p>
            The template’s script does not fit the card your contacts gave this campaign, so the draft has no script
            yet. Change the script here, then save the campaign.
          </p>
          <ul className={styles.notes}>
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
        />
      ) : (
        <div>
          <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
            Edit the script
          </button>
        </div>
      )}
    </div>
  );
}
