import { useId, type Ref } from 'react';
import { SetupCard } from '../../../../components/campaign-setup';
import { CampaignCarrierField } from '../../../../components/agency/CampaignCarrierField';
import { CallerIdPicker } from '../../../agency/CallerIdPicker';
import { carrierName, sameCarrier, type CarrierChoice, type CarrierOption } from '../../../../utils/agencyCarriers';
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
}

/**
 * Step 1 of the campaign setup, "Name & number" (CS1): the campaign's name, the carrier when
 * there is a choice, and the caller IDs as large cards. Controlled: the page owns the values, the
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

      {carrierChoices.length > 1 && readOnly ? (
        <p className={styles.hint} data-testid="campaign-carrier-readonly">
          {`Carrier: ${carrierChoices.find((o) => sameCarrier(o, carrier))?.name ?? carrierName(carrier)}`}
        </p>
      ) : carrierChoices.length > 1 ? (
        <div className={styles.carrier}>
          <CampaignCarrierField
            options={carrierChoices}
            value={carrier}
            onChange={onCarrier}
            disabled={carrierLocked}
            notice={carrierNotice}
            error={carrierError}
          />
        </div>
      ) : null}

      <div className={styles.numbers} data-testid="caller-id-field" id={anchors?.numbers}>
        <CallerIdPicker
          layout="cards"
          legend={
            <>
              Customers will see this number<span className="required-star">*</span>
            </>
          }
          selected={callerIds}
          onChange={onCallerIds}
          carrier={carrier}
          carrierLabel={carrierLabel}
          carrierActive={carrierActive}
          disabled={readOnly}
        />
        {callerIdsError ? (
          // `data-field-error`: the picker marks no control invalid, so this is what "Show me" finds.
          <p className="error-text" role="alert" data-field-error>
            {callerIdsError}
          </p>
        ) : null}
      </div>
    </SetupCard>
  );
}
