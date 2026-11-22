import { useEffect, useRef } from 'react';
import { Settings2, Trash2 } from 'lucide-react';
import { Sentence, SentenceSelect, type SentenceSelectOption } from '../../../../components/campaign-setup';
import { TileIconPicker } from '../../../../components/agency/TileIconPicker';
import type { AgencyDispositionEntry } from '../../../../types/agency-campaign';
import type { TileIconKey } from '@magick-agency/web-ui/components/TileIcon';
import {
  NO_FOLLOW_UP,
  OUTCOME_ACTIONS,
  OUTCOME_ACTION_LABELS,
  attemptOptions,
  delayOptions,
  lockedAction,
  outcomeFate,
  ruleOf,
  type OutcomeAction,
  type OutcomeRule,
} from '../../../../utils/campaignSetup/outcomeRule';
import type { ConfigFieldErrors } from '../configFieldErrors';
import styles from './PurposeButtonsStep.module.css';

const YES_NO: readonly SentenceSelectOption<'yes' | 'no'>[] = [
  { value: 'no', label: 'No' },
  { value: 'yes', label: 'Yes' },
];

/** Why a built-in button's first choice is fixed, in its own words. */
const BUILT_IN_NOTE: Readonly<Partial<Record<OutcomeAction, string>>> = {
  retry: 'This button is built in, so it always tries again.',
  callback: 'This button is built in, so it always calls back at a time the agent picks.',
  dnc: 'This button is built in, so it always puts the number on the Do Not Call list.',
};

/** The row's own findings: what this editor's fields can fix. The rest are under Advanced. */
export function rowEditorFields(index: number): string[] {
  const at = `disposition_catalog[${index}]`;
  return [
    at,
    `${at}.label`,
    `${at}.icon`,
    `${at}.retry`,
    `${at}.retry.delay_minutes`,
    `${at}.retry.max_attempts`,
    `${at}.requires_datetime`,
    `${at}.requires_promise`,
    `${at}.suppress`,
    `${at}.terminal`,
    `${at}.is_success`,
    `${at}.requires_note`,
  ];
}

/**
 * One button opened for editing (CS3): its name and picture, then its rule as one sentence
 * ("When the agent picks *No one spoke* → *try again* after *4 hours* up to *2 times*. Then stop
 * calling. Counts as success: *No*."). The sentence's choices are `outcomeRule`'s; what it does not
 * cover (the code, overrides, the promise follow-up) is behind "More options", in the full editor.
 */
export function OutcomeRuleEditor({
  entry,
  index,
  onRename,
  onIcon,
  onRule,
  onRemove,
  onMoreOptions,
  errors,
  focusName,
}: {
  entry: AgencyDispositionEntry;
  index: number;
  onRename: (label: string) => void;
  onIcon: (icon: TileIconKey | undefined) => void;
  onRule: (rule: OutcomeRule) => void;
  onRemove: () => void;
  onMoreOptions: () => void;
  errors: ConfigFieldErrors;
  /** Put focus on the name as the editor opens (a button just added). */
  focusName: boolean;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusName) nameRef.current?.focus();
  }, [focusName]);

  const rule = ruleOf(entry);
  const locked = lockedAction(entry.code);
  const name = entry.label.trim() || `Button ${index + 1}`;
  const at = `disposition_catalog[${index}]`;
  const set = (patch: Partial<OutcomeRule>) => onRule({ ...rule, ...patch });

  const actions: SentenceSelectOption<OutcomeAction>[] = OUTCOME_ACTIONS.map((action) => ({
    value: action,
    label: OUTCOME_ACTION_LABELS[action],
    disabled: locked !== null && action !== locked && action !== rule.action,
  }));

  return (
    <div className={styles.editor} data-testid={`button-editor-${index}`}>
      <div className={styles.nameRow}>
        <label className={styles.field}>
          Button name
          <input
            ref={nameRef}
            type="text"
            value={entry.label}
            maxLength={100}
            placeholder="What the agent sees on the button"
            onChange={(event) => onRename(event.target.value)}
            aria-invalid={errors.message(`${at}.label`) !== null || undefined}
            aria-describedby={errors.describedBy(`${at}.label`)}
          />
        </label>
        <span className={styles.pictureField}>
          Picture
          <TileIconPicker
            value={entry.icon}
            name={name}
            onChange={onIcon}
            describedBy={errors.describedBy(`${at}.icon`)}
            testId={`button-icon-${index}`}
          />
        </span>
      </div>

      <Sentence testId={`button-sentence-${index}`}>
        When the agent picks <b>{name}</b> →{' '}
        <SentenceSelect
          value={rule.action}
          options={actions}
          onChange={(action) => set({ action })}
          ariaLabel={`What happens when the agent picks ${name}`}
          describedBy={errors.describedBy(`${at}.requires_promise`, `${at}.requires_datetime`, `${at}.suppress`, `${at}.retry`)}
          testId={`button-action-${index}`}
        />
        {rule.action === 'retry' ? (
          <>
            {' '}after{' '}
            <SentenceSelect
              value={String(rule.retryDelayMinutes)}
              options={delayOptions(rule.retryDelayMinutes)}
              onChange={(v) => set({ retryDelayMinutes: Number(v) })}
              ariaLabel={`How long to wait before trying ${name} again`}
              invalid={errors.message(`${at}.retry.delay_minutes`) !== null}
              describedBy={errors.describedBy(`${at}.retry.delay_minutes`)}
              testId={`button-delay-${index}`}
            />{' '}
            up to{' '}
            <SentenceSelect
              value={String(rule.retryMaxAttempts)}
              options={attemptOptions(rule.retryMaxAttempts)}
              onChange={(v) => set({ retryMaxAttempts: Number(v) })}
              ariaLabel={`How many times to try ${name} again`}
              invalid={errors.message(`${at}.retry.max_attempts`) !== null}
              describedBy={errors.describedBy(`${at}.retry.max_attempts`)}
              testId={`button-attempts-${index}`}
            />
            . Then stop calling.
          </>
        ) : rule.action === 'promise' ? (
          outcomeFate(entry) === NO_FOLLOW_UP ? '. No call is booked by itself.' : `. Then ${outcomeFate(entry)}.`
        ) : rule.action === 'nothing' ? (
          '. No follow-up call.'
        ) : (
          '.'
        )}{' '}
        Counts as success:{' '}
        <SentenceSelect
          value={rule.success ? 'yes' : 'no'}
          options={YES_NO}
          onChange={(v) => set({ success: v === 'yes' })}
          ariaLabel={`${name} counts as success`}
          testId={`button-success-${index}`}
        />
        . Agent must write a note:{' '}
        <SentenceSelect
          value={rule.note ? 'yes' : 'no'}
          options={YES_NO}
          onChange={(v) => set({ note: v === 'yes' })}
          ariaLabel={`Agent must write a note for ${name}`}
          testId={`button-note-${index}`}
        />
        .
      </Sentence>

      {locked !== null ? (
        <p className={styles.lockNote} data-testid={`button-locked-${index}`}>
          {BUILT_IN_NOTE[locked]} You can rename it, but it cannot be removed.
        </p>
      ) : null}

      <div className={styles.editorActions}>
        <button type="button" className="btn-secondary" onClick={onMoreOptions} data-testid={`button-more-${index}`}>
          <Settings2 size={14} aria-hidden="true" /> More options
        </button>
        <button
          type="button"
          className="btn-danger"
          onClick={onRemove}
          disabled={locked !== null}
          title={locked !== null ? 'Built in. It cannot be removed.' : undefined}
          data-testid={`button-remove-${index}`}
        >
          <Trash2 size={14} aria-hidden="true" /> Remove button
        </button>
      </div>
    </div>
  );
}
