import type { useConfigFieldErrors } from '../../campaigns/agency/configFieldErrors';
import { UNCONNECTED_ACTION_LABELS, type InboundRouteDraft } from '../../../utils/inbound/routeForm';
import type { AgencyInboundRouteWarning, AgencyInboundUnconnectedAction } from '../../../types/inbound';
import styles from '../../../components/agency/inbound/Inbound.module.css';

/** The editor's field errors (`useConfigFieldErrors`): the server's and the form's, by path. */
export type RouteFieldErrors = ReturnType<typeof useConfigFieldErrors>;

/** What each of the route editor's cards is given: the draft, how to change it, and its errors. */
export interface RouteSectionProps {
  draft: InboundRouteDraft;
  update: (patch: Partial<InboundRouteDraft>) => void;
  errors: RouteFieldErrors;
}

/** A whole-number field with its hint and its errors. */
export function NumberField({
  id, label, value, hint, onChange, errors, path, disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  hint: string;
  onChange: (value: string) => void;
  errors: RouteFieldErrors;
  path: string;
  disabled?: boolean;
}) {
  return (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={[`${id}-hint`, errors.describedBy(path)].filter(Boolean).join(' ')}
      />
      <span className={styles.hint} id={`${id}-hint`}>{hint}</span>
      {errors.render(path)}
    </div>
  );
}

/** A route's warnings about one field (or the whole route), as the server's `warnings` say them. */
export function RouteWarnings({ warnings }: { warnings: AgencyInboundRouteWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className={styles.warnings} aria-label="Before you save">
      {warnings.map((w) => (
        <li key={w.code} className={styles.warning} data-testid={`inbound-route-warning-${w.code}`}>
          {w.message}
        </li>
      ))}
    </ul>
  );
}

/** One of the two "when nobody answers" choices: the actions the server accepts, as radios. */
export function ActionChoice({
  name,
  legend,
  actions,
  value,
  onChange,
  testId,
}: {
  name: string;
  legend: string;
  actions: readonly AgencyInboundUnconnectedAction[];
  value: AgencyInboundUnconnectedAction;
  onChange: (next: AgencyInboundUnconnectedAction) => void;
  testId: string;
}) {
  return (
    <fieldset className={styles.radioGroup} data-testid={testId}>
      <legend>{legend}</legend>
      {actions.map((action) => (
        <label key={action} className={styles.choice}>
          <input
            type="radio"
            name={name}
            value={action}
            checked={value === action}
            onChange={() => onChange(action)}
            data-testid={`${testId}-${action}`}
          />
          <span>
            {UNCONNECTED_ACTION_LABELS[action].label}
            <span className={styles.sub}>{UNCONNECTED_ACTION_LABELS[action].hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
