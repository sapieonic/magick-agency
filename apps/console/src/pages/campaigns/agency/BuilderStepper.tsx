import { AlertCircle, Check } from 'lucide-react';
import {
  BUILDER_STEPS,
  canVisitStep,
  type BuilderStepId,
} from './builderFlow';
import styles from './BuilderStepper.module.css';

export interface BuilderStepperProps {
  current: BuilderStepId;
  basicsReady: boolean;
  completed: ReadonlySet<BuilderStepId>;
  /** Steps holding a setting that stops the campaign saving: marked, and named for a screen reader. */
  invalid?: ReadonlySet<BuilderStepId>;
  onSelect: (id: BuilderStepId) => void;
}

/**
 * Horizontal progress for the campaign builder.
 *
 * Completed and reachable steps are buttons so an operator can jump back
 * without losing anything. Unreachable steps are disabled, not hidden —
 * hiding the rest of the path is how a first-time operator loses the plot.
 */
export function BuilderStepper({
  current,
  basicsReady,
  completed,
  invalid,
  onSelect,
}: BuilderStepperProps) {
  return (
    <nav className={styles.nav} aria-label="Campaign setup">
      <ol className={styles.list}>
        {BUILDER_STEPS.map((step, index) => {
          const reachable = canVisitStep(step.id, basicsReady);
          const isCurrent = step.id === current;
          const isInvalid = invalid?.has(step.id) ?? false;
          const isComplete = completed.has(step.id);
          return (
            <li key={step.id} className={styles.item} data-current={isCurrent || undefined}>
              {index > 0 ? <span className={styles.connector} aria-hidden="true" /> : null}
              <button
                type="button"
                className={styles.step}
                data-current={isCurrent || undefined}
                data-complete={isComplete && !isCurrent ? true : undefined}
                data-invalid={isInvalid || undefined}
                aria-label={isInvalid ? `${step.title}, needs fixing` : step.title}
                aria-current={isCurrent ? 'step' : undefined}
                disabled={!reachable}
                onClick={() => onSelect(step.id)}
              >
                <span className={styles.badge} aria-hidden="true">
                  {isInvalid ? (
                    <AlertCircle size={13} strokeWidth={2.5} />
                  ) : isComplete && !isCurrent ? (
                    <Check size={12} strokeWidth={2.5} />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className={styles.labelFull} aria-hidden="true">
                  {step.title}
                </span>
                <span className={styles.labelShort} aria-hidden="true">
                  {step.short}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
