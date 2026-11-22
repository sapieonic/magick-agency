import { useId, useRef, type KeyboardEvent } from 'react';
import { AlertCircle, Check } from 'lucide-react';
import styles from './StepCards.module.css';

export interface StepCardItem {
  id: string;
  title: string;
  subtitle: string;
}

export interface StepCardsProps {
  steps: readonly StepCardItem[];
  current: string;
  completed?: ReadonlySet<string>;
  /** Steps holding something that needs fixing: an alert badge, named "<title>, needs fixing". */
  invalid?: ReadonlySet<string>;
  /** Steps that cannot be opened yet: rendered and disabled, never hidden. */
  disabled?: ReadonlySet<string>;
  /** Steps holding an unsaved change (Settings): a small dot on the badge, named ", unsaved changes". */
  unsaved?: ReadonlySet<string>;
  onSelect: (id: string) => void;
  /**
   * `sequence` (New campaign): `<nav><ol>` of buttons, the current one `aria-current="step"`.
   * `tabs` (Settings): `role="tablist"` of `role="tab"`, `aria-selected`, roving focus on the
   * arrow keys, Home and End.
   */
  mode?: 'sequence' | 'tabs';
  /** Accessible name of the nav or the tablist. */
  label: string;
  /** Tabs mode: tab ids are `${idPrefix}-tab-${id}`, and each controls `${idPrefix}-panel-${id}`. */
  idPrefix?: string;
  /**
   * Tabs mode: `auto` (default) selects the tab an arrow key moves to; `manual` only moves focus,
   * and Enter or Space selects.
   */
  activation?: 'auto' | 'manual';
}

/**
 * The four-card step bar of the campaign setup (CS1). On a narrow container the cards shed their
 * subtitles, then every title but the current one, so the row never scrolls the page sideways.
 */
export function StepCards({
  steps,
  current,
  completed,
  invalid,
  disabled,
  unsaved,
  onSelect,
  mode = 'sequence',
  label,
  idPrefix = 'setup',
  activation = 'auto',
}: StepCardsProps) {
  const tabs = mode === 'tabs';
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const uid = useId();

  const enabledIds = steps.filter((s) => !disabled?.has(s.id)).map((s) => s.id);
  // The one tab in the Tab order: the current one, or the first that can be opened.
  const focusTarget = enabledIds.includes(current) ? current : enabledIds[0];

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (enabledIds.length === 0) return;
    const focusedId = (event.target as HTMLElement).dataset.stepId;
    const at = focusedId ? enabledIds.indexOf(focusedId) : -1;
    let next: string | undefined;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = enabledIds[(at + 1) % enabledIds.length];
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = enabledIds[(at - 1 + enabledIds.length) % enabledIds.length];
        break;
      case 'Home':
        next = enabledIds[0];
        break;
      case 'End':
        next = enabledIds[enabledIds.length - 1];
        break;
      default:
        return;
    }
    if (next === undefined) return;
    event.preventDefault();
    refs.current.get(next)?.focus();
    if (activation === 'auto' && next !== current) onSelect(next);
  }

  const items = steps.map((step, index) => {
    const isCurrent = step.id === current;
    const isInvalid = invalid?.has(step.id) ?? false;
    const isComplete = (completed?.has(step.id) ?? false) && !isCurrent;
    const isDisabled = disabled?.has(step.id) ?? false;
    const isUnsaved = unsaved?.has(step.id) ?? false;
    const subtitleId = `${uid}-${index}-subtitle`;
    const button = (
      <button
        key={step.id}
        ref={(el) => {
          if (el) refs.current.set(step.id, el);
          else refs.current.delete(step.id);
        }}
        type="button"
        className={styles.card}
        data-step-id={step.id}
        data-current={isCurrent || undefined}
        data-complete={isComplete || undefined}
        data-invalid={isInvalid || undefined}
        data-unsaved={isUnsaved || undefined}
        aria-label={`${step.title}${isInvalid ? ', needs fixing' : ''}${isUnsaved ? ', unsaved changes' : ''}`}
        aria-describedby={subtitleId}
        disabled={isDisabled}
        onClick={() => onSelect(step.id)}
        {...(tabs
          ? {
              role: 'tab',
              id: `${idPrefix}-tab-${step.id}`,
              'aria-selected': isCurrent,
              'aria-controls': `${idPrefix}-panel-${step.id}`,
              tabIndex: step.id === focusTarget ? 0 : -1,
            }
          : { 'aria-current': isCurrent ? ('step' as const) : undefined })}
      >
        <span className={styles.badge} aria-hidden="true">
          {isInvalid ? (
            <AlertCircle size={15} strokeWidth={2.5} />
          ) : isComplete ? (
            <Check size={15} strokeWidth={3} />
          ) : (
            index + 1
          )}
          {isUnsaved ? <span className={styles.unsavedDot} /> : null}
        </span>
        <span className={styles.text}>
          <span className={styles.title}>{step.title}</span>
          <span className={styles.subtitle} id={subtitleId}>
            {step.subtitle}
          </span>
        </span>
      </button>
    );
    return { step, isCurrent, button };
  });

  if (tabs) {
    return (
      <div className={styles.root}>
        <div
          role="tablist"
          aria-label={label}
          aria-orientation="horizontal"
          className={styles.list}
          onKeyDown={onKeyDown}
        >
          {items.map(({ step, isCurrent, button }) => (
            <div key={step.id} className={styles.item} data-current={isCurrent || undefined} role="presentation">
              {button}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <nav className={styles.root} aria-label={label}>
      <ol className={styles.list}>
        {items.map(({ step, isCurrent, button }) => (
          <li key={step.id} className={styles.item} data-current={isCurrent || undefined}>
            {button}
          </li>
        ))}
      </ol>
    </nav>
  );
}
