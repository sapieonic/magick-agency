import { useId } from 'react';
import { Link } from 'react-router-dom';
import type {
  AgencyCampaignTemplateEffective,
  AgencyCampaignTemplateSummary,
} from '@magick-agency/contracts/api/agency/campaign-templates';
import { actorLabel, formatStamp, noteSentence } from '../../../utils/agency/campaignTemplates/templateCopy';
import { BUILT_IN_START } from './useStartFrom';
import styles from './CampaignTemplates.module.css';

/**
 * New campaign's "Start from" picker and the violet banner under it: the account's templates
 * first, then the organisation's, then the built-in settings; then where the form was filled in
 * from, that changes here are this campaign's alone, and the notes on the filling-in as sentences.
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
  const account = templates.filter((t) => t.scope === 'account');
  const organisation = templates.filter((t) => t.scope === 'organisation');
  const label = (t: AgencyCampaignTemplateSummary) => (t.is_default ? `${t.name} (default)` : t.name);
  const chosen = effective.template ? templates.find((t) => t.id === effective.template!.id) ?? null : null;
  const who = chosen ? actorLabel(chosen.updated_by) : null;

  return (
    <div className={styles.cardBody} data-testid="start-from">
      <div className={styles.picker}>
        <label htmlFor={`${id}-start`}>Start from</label>
        <select
          id={`${id}-start`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
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
    </div>
  );
}
