import { useState } from 'react';
import type { TelephonyCredential } from '@magick-agency/contracts/api/platform/super-admin-telephony-credentials';
import type {
  PhoneNumber,
  PinPhoneNumberCampaign,
  PinPhoneNumberError,
  PinPhoneNumberErrorCode,
} from '@magick-agency/contracts/api/platform/super-admin';
import { pinPhoneNumber } from '../../../api/super-admin';
import type { TelephonyProvider } from '../../../api/super-admin';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { operatorCarrierName } from '../../../utils/carrierName';
import { activeAccountChoices } from '../../../utils/carrierModes';
import { saStatusLabel } from '../../../utils/saStatus';
import styles from '../SAPhoneNumbersPage.module.css';

/**
 * "Move to a tenant’s account" (docs/carriers.md CR6 amended): a number on the service's own
 * carrier account goes onto a tenant's own account of the same carrier, pinned to that
 * credential and assigned to its tenant. One way: nothing unpins a number. The page offers it
 * only on an active, unpinned number whose carrier takes tenant numbers by hand
 * (`number_source: 'manual'`); the server judges everything again.
 */

/** What a refusal says, by code. Two of them name what is in the way, from the error body. */
const PIN_REFUSAL: Record<PinPhoneNumberErrorCode, (body: PinPhoneNumberError) => string> = {
  phone_number_not_found: () => 'This number no longer exists. Refresh the list.',
  phone_number_not_active: () => 'Only an active number can be moved. Reactivate it first.',
  phone_number_already_pinned: () => 'This number is already on a tenant’s own carrier account, and that never changes.',
  carrier_numbers_not_pinned_by_hand: () =>
    'Numbers on this carrier cannot be moved by hand: a tenant’s numbers on it come from Sync numbers on its credential.',
  telephony_credential_not_found: () => 'That carrier account no longer exists on this carrier. Pick another account.',
  telephony_credential_not_active: () =>
    'That carrier account is not active, so a number cannot be moved onto it. Enable or verify it under Telephony credentials, then try again.',
  phone_number_assigned_elsewhere: (body) => {
    const n = body.tenant_count ?? 0;
    return n === 1
      ? 'This number is assigned to another tenant. Unassign it from that tenant first, then move it.'
      : `This number is assigned to ${n > 1 ? `${n} other tenants` : 'other tenants'}. Unassign it from them first, then move it.`;
  },
  phone_number_in_use: () =>
    'Campaigns on the service’s own account still use this number as a caller ID. Remove it from them, or stop them, then move it.',
};

/** "Collections (Acme / North, running)". */
function campaignLine(c: PinPhoneNumberCampaign): string {
  return `${c.campaign_name} (${c.tenant_name} / ${c.account_name ?? 'account removed'}, ${saStatusLabel(c.status).toLowerCase()})`;
}

type Refusal = { message: string; campaigns: PinPhoneNumberCampaign[]; more: number; code: string | null };

function refusalOf(err: unknown): Refusal {
  const details = (err as { details?: unknown } | null)?.details;
  const body = details && typeof details === 'object' ? (details as Partial<PinPhoneNumberError>) : {};
  const code = typeof body.code === 'string' && Object.hasOwn(PIN_REFUSAL, body.code) ? body.code : null;
  if (code === null) {
    return { message: err instanceof Error && err.message ? err.message : 'Failed to move the number', campaigns: [], more: 0, code: null };
  }
  const campaigns = code === 'phone_number_in_use' && Array.isArray(body.campaigns) ? body.campaigns : [];
  const total = typeof body.campaigns_total === 'number' ? body.campaigns_total : campaigns.length;
  return {
    message: PIN_REFUSAL[code](body as PinPhoneNumberError),
    campaigns,
    more: Math.max(0, total - campaigns.length),
    code,
  };
}

export function PhoneNumberPinDialog({ phone, provider, credentials, tenantName, onClose, onPinned, onAccountsStale }: {
  /** The number to move; null closes the dialog. */
  phone: PhoneNumber | null;
  provider: TelephonyProvider | undefined;
  /** Every tenant carrier account; the carrier's active ones are offered. Null: not readable. */
  credentials: TelephonyCredential[] | null;
  tenantName: ReadonlyMap<string, string>;
  onClose: () => void;
  /** Called after the move; the parent refreshes the row. */
  onPinned: () => void;
  /** The chosen account turned out gone or not active: the parent reloads the accounts. */
  onAccountsStale?: () => void;
}) {
  const [account, setAccount] = useState('');
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const providerName = provider?.name ?? phone?.provider_name ?? '';
  const carrier = operatorCarrierName(providerName, provider?.display_name ?? phone?.provider_display_name);
  const accounts = activeAccountChoices(credentials, providerName, tenantName);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone || account === '') return;
    setSaving(true);
    setRefusal(null);
    try {
      await pinPhoneNumber(phone.id, { telephony_credential_id: account });
      onPinned();
    } catch (err) {
      const r = refusalOf(err);
      setRefusal(r);
      if (r.code === 'telephony_credential_not_found' || r.code === 'telephony_credential_not_active') onAccountsStale?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={phone !== null}
      onClose={onClose}
      title="Move to a tenant’s account"
      subtitle={phone ? `${phone.phone_number} on ${carrier}` : ''}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="pin-phone-form" className="btn-primary" disabled={saving || account === ''}>
            {saving ? 'Moving…' : 'Move number'}
          </button>
        </>
      }
    >
      <form id="pin-phone-form" onSubmit={submit} className={styles.form}>
        <div className={styles.field}>
          <label htmlFor="pin-phone-account">Account</label>
          <select id="pin-phone-account" value={account} onChange={e => setAccount(e.target.value)} required>
            <option value="">Select a tenant’s account…</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          {credentials === null && (
            <p className={styles.fieldHint} data-testid="pin-accounts-unreadable">
              The tenants’ carrier accounts could not be loaded. Close this and open it again to retry.
            </p>
          )}
          {credentials !== null && accounts.length === 0 && (
            <p className={styles.fieldHint} data-testid="pin-accounts-none">
              {`No tenant has an active ${carrier} account. Add one under Telephony credentials first.`}
            </p>
          )}
        </div>
        <p className={styles.fieldHint} data-testid="pin-one-way">
          This cannot be undone: the number moves to that tenant’s own carrier account for good, and is assigned to that tenant.
        </p>
        {refusal && (
          <div className={styles.error} role="alert" data-testid="pin-error">
            <p>{refusal.message}</p>
            {refusal.campaigns.length > 0 && (
              <ul data-testid="pin-error-campaigns">
                {refusal.campaigns.map(c => <li key={c.campaign_id}>{campaignLine(c)}</li>)}
                {refusal.more > 0 && <li>{`and ${refusal.more} more`}</li>}
              </ul>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}
