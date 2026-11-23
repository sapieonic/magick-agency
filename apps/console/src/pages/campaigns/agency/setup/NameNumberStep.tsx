import { useId, type Ref } from 'react';
import { SetupCard } from '../../../../components/campaign-setup';
import type { CarrierChoice, CarrierOption } from '../../../../utils/agencyCarriers';
import { CallerNumbersBlock } from './CallerNumbersBlock';
import type { SetupSectionSources } from './sectionSources';
import styles from './NameNumberStep.module.css';

export interface NameNumberStepProps {
  /** `create`: New campaign (the name field takes focus). `edit`: campaign Settings. */
  mode: 'create' | 'edit';
  name: string;
  onName: (next: string) => void;
  /** Said under the name field (a refusal from the server, or the page's own finding). */
  nameError?: string | null;
  /**
   * Every carrier account the campaign could dial on (`carrierOptions`). The field shows only
   * when there is more than one; with one, the campaign simply takes it.
   */
  carrierChoices: readonly CarrierOption[];
  carrier: CarrierChoice;
  onCarrier: (next: CarrierChoice) => void;
  /** True once the carrier cannot change here (New campaign's draft exists). */
  carrierLocked?: boolean;
  /** Said under the carrier, e.g. why it is locked. */
  carrierNotice?: string | null;
  carrierError?: string;
  /** The carrier account's label, for the numbers' empty states (`AgencyCarrier.label`). */
  carrierLabel?: string | null;
  /** False when the carriers list no longer offers this account (`carrierActive`). */
  carrierActive?: boolean;
  callerIds: string[];
  onCallerIds: (next: string[]) => void;
  /** Said under the numbers. */
  callerIdsError?: string | null;
  /** The card's heading, so the page can move focus to it on a step change. */
  headingRef?: Ref<HTMLHeadingElement>;
  /**
   * The viewer cannot write campaigns (Settings): the name and the numbers are locked, and the
   * carrier, when there is a choice, is said in words rather than offered.
   */
  readOnly?: boolean;
  /** Element ids for links into the step (Settings' `…/settings#<id>`): the card, and the numbers. */
  anchors?: { card?: string; numbers?: string };
  /** Shown at the head of the numbers block: `numbers` (New campaign's template source, CS18). */
  sectionSources?: SetupSectionSources;
}

/**
 * Step 1 of the campaign setup, "Name & number" (CS1): the campaign's name, then the carrier when
 * there is a choice and the caller IDs as large cards (`CallerNumbersBlock`). Controlled: the page owns the values, the
 * carrier default and the saves.
 */
export function NameNumberStep({
  mode,
  name,
  onName,
  nameError = null,
  carrierChoices,
  carrier,
  onCarrier,
  carrierLocked = false,
  carrierNotice = null,
  carrierError,
  carrierLabel = null,
  carrierActive = true,
  callerIds,
  onCallerIds,
  callerIdsError = null,
  headingRef,
  readOnly = false,
  anchors,
  sectionSources,
}: NameNumberStepProps) {
  const uid = useId();
  const nameId = `${uid}-name`;
  const nameHintId = `${uid}-name-hint`;
  const nameErrorId = `${uid}-name-error`;

  return (
    <SetupCard
      title="Name & number"
      helper="Give it a name your team will recognise, and pick the number customers will see."
      headingRef={headingRef}
      testId="name-number-step"
      id={anchors?.card}
    >
      <div className={`form-group ${styles.field}`}>
        <label htmlFor={nameId}>
          Campaign name<span className="required-star">*</span>
        </label>
        <input
          id={nameId}
          value={name}
          onChange={(event) => onName(event.target.value)}
          placeholder="e.g. Collections, November"
          autoFocus={mode === 'create'}
          disabled={readOnly}
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `${nameHintId} ${nameErrorId}` : nameHintId}
        />
        <p id={nameHintId} className={styles.hint}>
          Your team sees this in the campaign list. Customers never see it.
        </p>
        {nameError ? (
          <p id={nameErrorId} className="error-text" role="alert">
            {nameError}
          </p>
        ) : null}
      </div>

      <CallerNumbersBlock
        carrierChoices={carrierChoices}
        carrier={carrier}
        onCarrier={onCarrier}
        carrierLocked={carrierLocked}
        carrierNotice={carrierNotice}
        carrierError={carrierError}
        carrierLabel={carrierLabel}
        carrierActive={carrierActive}
        callerIds={callerIds}
        onCallerIds={onCallerIds}
        callerIdsError={callerIdsError}
        readOnly={readOnly}
        numbersId={anchors?.numbers}
        source={sectionSources?.numbers}
      />
    </SetupCard>
  );
}
