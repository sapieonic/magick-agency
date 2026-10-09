import { useMemo } from 'react';
import { usePhoneNumbers } from '../../hooks/usePhoneNumbers';
import { telephonyProviderAlias } from '../../config/telephonyProviders';
import styles from './CallerIdPicker.module.css';

/**
 * The provider every agency campaign dials through.
 *
 * A constant rather than a choice: agency campaigns are VoiceLink-only by
 * product decision. The API still accepts other providers — `telephony_provider`
 * defaults to `'vobiz'` in its schema — so this restriction lives here and
 * nowhere else. If it ever needs to be guaranteed rather than merely offered, it
 * has to be enforced in the API; a UI that is the only gate is a preference, not a
 * constraint, and this comment exists so nobody mistakes one for the other.
 */
export const AGENCY_TELEPHONY_PROVIDER = 'voicelink';
const AGENCY_PROVIDER_ALIAS = telephonyProviderAlias(AGENCY_TELEPHONY_PROVIDER);

export interface CallerIdPickerProps {
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

/**
 * Which numbers a campaign dials FROM.
 *
 * Required, not optional. The API rejects a campaign with an empty `caller_ids`
 * (`agency-campaigns.routes.ts`), and the pacing engine throws outright when it
 * has no pool to rotate — so a campaign without one cannot be created and could
 * not dial if it were. Every campaign created through the UI failed this
 * validation until this control existed.
 *
 * Filtered to VoiceLink because the column comment in the schema is a real
 * constraint: *"all entries must belong to `telephony_provider`"*. Mixing
 * providers in one pool produces a campaign that dials fine on some rotations
 * and fails on others, which is the worst shape of bug to diagnose from a
 * customer report.
 */
export function CallerIdPicker({ selected, onChange, disabled = false }: CallerIdPickerProps) {
  const { phoneNumbers, loading, error } = usePhoneNumbers();

  const { voicelink, otherCount } = useMemo(() => {
    const all = phoneNumbers ?? [];
    const vl = all.filter(
      (pn) => pn.provider_name?.toLowerCase() === AGENCY_TELEPHONY_PROVIDER,
    );
    return { voicelink: vl, otherCount: all.length - vl.length };
  }, [phoneNumbers]);

  const toggle = (phone: string) => {
    onChange(
      selected.includes(phone) ? selected.filter((p) => p !== phone) : [...selected, phone],
    );
  };

  if (loading) return <p className={styles.status}>Loading your numbers…</p>;
  if (error) return <p className={styles.error}>{error}</p>;

  if (voicelink.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>No {AGENCY_PROVIDER_ALIAS} numbers are assigned to this account.</p>
        <p className={styles.emptyBody}>
          Agency campaigns dial through {AGENCY_PROVIDER_ALIAS}, so at least one {AGENCY_PROVIDER_ALIAS} number has to be
          assigned before a campaign can be created.
          {otherCount > 0 && (
            <>
              {' '}
              This account has {otherCount} number{otherCount === 1 ? '' : 's'} on other providers —
              those cannot be used for agency campaigns.
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
        {voicelink.map((pn) => {
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
                {/* No own-carrier (BYOC) badge: bring-your-own-carrier numbers are not offered. */}
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
        number on another provider and cannot find it here would otherwise have
        no way to tell an absent number from a broken picker.
      */}
      {otherCount > 0 && (
        <p className={styles.excluded}>
          {otherCount} number{otherCount === 1 ? '' : 's'} on other providers{' '}
          {otherCount === 1 ? 'is' : 'are'} not shown — agency campaigns dial through{' '}
          {AGENCY_PROVIDER_ALIAS} only.
        </p>
      )}
    </div>
  );
}
