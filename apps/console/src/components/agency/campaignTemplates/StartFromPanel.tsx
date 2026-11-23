import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  AgencyCampaignTemplateEffective,
  AgencyCampaignTemplateSummary,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { actorLabel, formatStamp, noteSentence } from '../../../utils/agency/campaignTemplates/templateCopy';
import { SetupCard } from '../../campaign-setup';
import { BUILT_IN_START } from './useStartFrom';
import styles from './StartFromPanel.module.css';

/**
 * New campaign's "Start from" (CS17), a slim card above the step cards: the picker (the account's
 * templates first, then the organisation's, then the built-in settings), then where the form was
 * filled in from, that changes here are this campaign's alone, and the notes on the filling-in as
 * sentences. It fills every step; once the draft exists it is locked, and says so.
 *
 * Choosing in the list does nothing by itself; "Use this template" starts from the one chosen (U12):
 * in Chromium on Windows and Linux an arrow key on a closed list changes it at once, which would
 * otherwise start a read on every press and take the focus away.
 */
export function StartFromPanel({
  templates,
  effective,
  value,
  onChange,
  disabled,
  lockedNote,
  viewPath,
}: {
  templates: readonly AgencyCampaignTemplateSummary[];
  effective: AgencyCampaignTemplateEffective;
  value: string;
  onChange: (choice: string) => void;
  disabled: boolean;
  /** Why the picker cannot be changed now (the draft exists), or null. */
  lockedNote: string | null;
  /** Where "View template" goes, or null when the reader cannot open it. */
  viewPath: string | null;
}) {
  const id = useId();
  const [picked, setPicked] = useState(value);
  // What is in use moved (a switch done, or held back by Cancel): the list shows it again.
  useEffect(() => setPicked(value), [value]);
  const account = templates.filter((t) => t.scope === 'account');
  const organisation = templates.filter((t) => t.scope === 'organisation');
  const label = (t: AgencyCampaignTemplateSummary) =>
    (t.is_default ? `${t.name} (${t.scope === 'organisation' ? 'organisation default' : 'account default'})` : t.name);
  const chosen = effective.template ? templates.find((t) => t.id === effective.template!.id) ?? null : null;
  const who = chosen ? actorLabel(chosen.updated_by) : null;

  return (
    <SetupCard density="slim" testId="start-from">
      <div className={styles.picker}>
        <label htmlFor={`${id}-start`} className={styles.label}>
          Start from
        </label>
        <select
          id={`${id}-start`}
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
          disabled={disabled}
          aria-describedby={lockedNote ? `${id}-locked` : undefined}
          data-testid="start-from-select"
        >
          {account.length > 0 ? (
            <optgroup label="This account’s templates">
              {account.map((t) => (
                <option key={t.id} value={t.id}>
                  {label(t)}
                </option>
              ))}
            </optgroup>
          ) : null}
          {organisation.length > 0 ? (
            <optgroup label="Organisation templates">
              {organisation.map((t) => (
                <option key={t.id} value={t.id}>
                  {label(t)}
                </option>
              ))}
            </optgroup>
          ) : null}
          <option value={BUILT_IN_START}>Built-in settings</option>
        </select>
        {picked !== value && !disabled ? (
          <button type="button" className="btn-secondary" onClick={() => {
              // The list shows what is in use until the switch is made (a Cancel keeps it).
              setPicked(value);
              onChange(picked);
            }} data-testid="start-from-use">
            {picked === BUILT_IN_START ? 'Use the built-in settings' : 'Use this template'}
          </button>
        ) : null}
        {lockedNote ? (
          <span className={styles.muted} id={`${id}-locked`}>
            {lockedNote}
          </span>
        ) : null}
      </div>
      <div className={styles.banner} role="status" data-testid="start-from-banner">
        <p>
          {effective.template
            ? `Filled in from ${effective.template.name} (version ${effective.template.version}${
                chosen ? `, changed${who ? ` by ${who}` : ''} on ${formatStamp(chosen.updated_at)}` : ''
              }). `
            : 'Filled in from the built-in settings. '}
          Changes you make here apply to this campaign only.
          {viewPath ? (
            <>
              {' '}
              <Link to={viewPath}>View template</Link>
            </>
          ) : null}
        </p>
        {effective.notes.length > 0 ? (
          <ul className={styles.notes} data-testid="start-from-notes">
            {effective.notes.map((note, i) => (
              <li key={`${note.code}-${note.section}-${i}`}>{noteSentence(note)}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </SetupCard>
  );
}
