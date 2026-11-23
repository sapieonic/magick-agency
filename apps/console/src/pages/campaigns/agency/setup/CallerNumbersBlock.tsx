import type { ReactNode } from 'react';
import { CampaignCarrierField } from '../../../../components/agency/CampaignCarrierField';
import { CallerIdPicker } from '../../../agency/CallerIdPicker';
import { carrierName, sameCarrier, type CarrierChoice, type CarrierOption } from '../../../../utils/agencyCarriers';
import styles from './NameNumberStep.module.css';

export interface CallerNumbersBlockProps {
  /**
   * Every carrier account the numbers could be on (`carrierOptions`). The field shows only when
   * there is more than one; with one, it is simply taken.
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
  /** The carrier is said in words rather than offered, and the numbers are locked. */
  readOnly?: boolean;
  /** The numbers block's element id (a link target). */
  numbersId?: string;
  /** At the head of the numbers block: where they came from (a template's chip and Reset, CS18). */
  source?: ReactNode;
}

/**
 * Name & number's numbers (CS1): the carrier account when there is a choice, then the caller IDs
 * as large cards. Step 1's block below the name, and a campaign template's "Numbers to call from"
 * section (CS21), which holds exactly these.
 */
export function CallerNumbersBlock({
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
  readOnly = false,
  numbersId,
  source,
}: CallerNumbersBlockProps) {
  return (
    <>
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

      <div className={styles.numbers} data-testid="caller-id-field" id={numbersId}>
        {source ? <div className={styles.sectionSource}>{source}</div> : null}
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
    </>
  );
}
