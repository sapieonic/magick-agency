import { useEffect, useMemo, useRef } from 'react';
import { usePhoneNumbers } from '../../hooks/usePhoneNumbers';
import { carrierKey, carrierName, numberOnCarrier, type CarrierChoice } from '../../utils/agencyCarriers';
import styles from './CallerIdPicker.module.css';

export interface CallerIdPickerProps {
  selected: string[];
  onChange: (next: string[]) => void;
  /**
   * The carrier account the campaign dials on. Only its numbers are offered: same carrier
   * AND same credential (null for the service's own account).
   */
  carrier: CarrierChoice;
  /** The carrier account's label, for a tenant's own account (`AgencyCarrier.label`). */
  carrierLabel?: string | null;
  disabled?: boolean;
}

/**
 * Which numbers a campaign dials FROM.
 *
 * Required, not optional. The API rejects a campaign with an empty `caller_ids`
 * (`agency-campaigns.routes.ts`), and the pacing engine throws outright when it
 * has no pool to rotate — so a campaign without one cannot be created and could
 * not dial if it were.
 *
 * Filtered to the campaign's carrier account because a caller ID is dialled on the
 * account it belongs to: the server refuses a tenant-account campaign whose caller IDs
 * are not that account's synced numbers, and a service-account campaign dialling a
 * tenant's number would place the call on the wrong account.
 *
 * When the carrier changes (the page's carrier choice), selected numbers that are not on
 * the new carrier account are dropped, once the account's numbers are known: they would
 * be hidden here and still sent.
 */
export function CallerIdPicker({
  selected,
  onChange,
  carrier,
  carrierLabel = null,
  disabled = false,
}: CallerIdPickerProps) {
  const { phoneNumbers, loading, error } = usePhoneNumbers();
  const key = carrierKey(carrier);
  const name = carrierName({ ...carrier, label: carrierLabel });

  // Keyed on the two fields, not the object: a new object naming the same account must
  // not refilter (and so must not re-run the pruning effect below).
  const { telephony_provider: provider, telephony_credential_id: credentialId } = carrier;
  const { onCarrier, otherCount } = useMemo(() => {
    const all = phoneNumbers ?? [];
    const fit = all.filter((pn) =>
      numberOnCarrier(pn, { telephony_provider: provider, telephony_credential_id: credentialId }));
    return { onCarrier: fit, otherCount: all.length - fit.length };
  }, [phoneNumbers, provider, credentialId]);

  // The carrier the selection was last checked against. Seeded with the first one, so a
  // campaign's stored pool is never pruned on load, only on a change of carrier.
  const checkedKey = useRef(key);
  useEffect(() => {
    if (checkedKey.current === key || loading || error) return;
    checkedKey.current = key;
    const kept = selected.filter((phone) => onCarrier.some((pn) => pn.phone_number === phone));
    if (kept.length !== selected.length) onChange(kept);
  }, [key, loading, error, onCarrier, selected, onChange]);

  const toggle = (phone: string) => {
    onChange(
      selected.includes(phone) ? selected.filter((p) => p !== phone) : [...selected, phone],
    );
  };

  if (loading) return <p className={styles.status}>Loading your numbers…</p>;
  if (error) return <p className={styles.error}>{error}</p>;

  if (onCarrier.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>No numbers on {name} are assigned to this account.</p>
        <p className={styles.emptyBody}>
          This campaign dials through {name}, so at least one of its numbers has to be assigned
          before the campaign can dial.
          {otherCount > 0 && (
            <>
              {' '}
              This account has {otherCount} number{otherCount === 1 ? '' : 's'} on other carriers —
              those cannot be used with {name}.
            </>
          )}{' '}
          Ask an administrator to assign one.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.picker}>
      <ul className={styles.list}>
        {onCarrier.map((pn) => {
          const checked = selected.includes(pn.phone_number);
          return (
            <li key={pn.phone_number_id ?? pn.phone_number}>
              <label className={styles.row}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggle(pn.phone_number)}
                />
                <span className={styles.number}>{pn.phone_number}</span>
                {pn.label && <span className={styles.label}>{pn.label}</span>}
                {pn.is_default && <span className={styles.default}>Default</span>}
              </label>
            </li>
          );
        })}
      </ul>

      <p className={styles.hint}>
        {selected.length === 0
          ? 'Pick at least one number. Calls will show it as the caller ID.'
          : `${selected.length} selected. Calls rotate through them evenly.`}
      </p>

      {/*
        Named rather than silently filtered. An operator who has just assigned a
        number on another carrier and cannot find it here would otherwise have
        no way to tell an absent number from a broken picker.
      */}
      {otherCount > 0 && (
        <p className={styles.excluded}>
          {`${otherCount} number${otherCount === 1 ? '' : 's'} on other carriers ${otherCount === 1 ? 'is' : 'are'} not shown — this campaign dials through ${name} only.`}
        </p>
      )}
    </div>
  );
}
