import { useState } from 'react';
import type { TelephonyCredential } from '@magick-agency/contracts/api/platform/super-admin-telephony-credentials';
import { createPhoneNumber } from '../../../api/super-admin';
import type { TelephonyProvider } from '../../../api/super-admin';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { HelpTooltip } from '@magick-agency/web-ui/components/HelpTooltip';
import { ErrorText } from '@magick-agency/web-ui/components/ErrorText';
import { operatorCarrierName } from '../../../utils/carrierName';
import {
  carrierModes,
  credentialAccountName,
  numbersAddedByHand,
  takesTenantNumbersByHand,
} from '../../../utils/carrierModes';
import { refusalCopy } from '../../../utils/operatorCopy';
import { AdvancedSection } from '../../../components/common';
import styles from '../SAPhoneNumbersPage.module.css';

const CAPABILITY_OPTIONS = ['voice', 'sms'] as const;

/** The Account picker's value for the service's own account; '' is "not chosen yet". */
const SERVICE_ACCOUNT = 'service';

const EMPTY_FORM = {
  phone_number: '',
  provider_id: '',
  /** `SERVICE_ACCOUNT`, a credential id, or '' while a tenant-only carrier's account is not chosen. */
  account: SERVICE_ACCOUNT,
  label: '',
  region: '',
  max_concurrent_calls: 1,
  capabilities: ['voice'] as string[],
};

/**
 * The refusals of adding a number to a tenant's own account (docs/carriers.md CR6), by code.
 * The rest (a carrier that does not take this account, a number already in the inventory) show
 * the server's message.
 */
const CREATE_REFUSAL: Record<string, string> = {
  telephony_credential_not_found: 'That carrier account no longer exists on this carrier. Pick another account.',
  telephony_credential_not_active:
    'That carrier account is not active, so a number cannot be added to it. Enable or verify it under Telephony credentials, then try again.',
};

/**
 * "Add phone number". Stays mounted while closed, so a half-filled form and
 * its last error survive closing and reopening; a successful add resets it.
 *
 * Offers each ACTIVE carrier that has the service's own account, or whose tenant accounts'
 * numbers are added by hand (CR6, VoiceLink). A carrier whose numbers sync from the tenant's
 * account (Plivo) is never offered: the server refuses it, and the form points to "Sync
 * numbers" instead. On a carrier that takes numbers by hand on tenants' accounts, an Account
 * picker chooses the service's own account (when the carrier has one) or a tenant's active
 * credential; a number on a tenant's account is assigned to that tenant by the server.
 */
export function PhoneNumberCreateModal({ open, providers, credentials, tenantName, onClose, onCreated, onAccountsStale }: {
  open: boolean;
  providers: TelephonyProvider[];
  /** Every tenant carrier account (any status): only the chosen carrier's active ones are offered. Null: not readable. */
  credentials: TelephonyCredential[] | null;
  /** Tenant names by id, for naming an account "Tenant · label". */
  tenantName: ReadonlyMap<string, string>;
  onClose: () => void;
  /** Called after a successful add; the parent closes the modal and refetches. */
  onCreated: () => void;
  /** Called when the server said the chosen account is gone or not active: the parent reloads the accounts. */
  onAccountsStale?: () => void;
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const active = providers.filter(p => p.status === 'active');
  const offered = active.filter(numbersAddedByHand);
  const synced = active.filter(p => {
    const modes = carrierModes(p);
    return !modes.service && modes.tenant && modes.numberSource === 'sync';
  });

  const chosen = offered.find(p => p.id === form.provider_id);
  const asksAccount = chosen !== undefined && takesTenantNumbersByHand(chosen);
  const hasService = chosen !== undefined && carrierModes(chosen).service;
  const accounts = asksAccount
    ? (credentials ?? [])
      .filter(c => c.status === 'active' && c.provider.toLowerCase() === chosen.name.toLowerCase())
      .map(c => ({ id: c.id, name: credentialAccountName(c, tenantName) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  const chooseProvider = (providerId: string) => {
    const next = offered.find(p => p.id === providerId);
    // The service's own account where the carrier has one; otherwise the operator must pick.
    const account = next === undefined || carrierModes(next).service ? SERVICE_ACCOUNT : '';
    setForm(f => ({ ...f, provider_id: providerId, account }));
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await createPhoneNumber({
        phone_number: form.phone_number,
        provider_id: form.provider_id,
        // Null: the service's own account. A credential only where the Account picker offered one.
        telephony_credential_id: asksAccount && form.account !== SERVICE_ACCOUNT ? form.account : null,
        label: form.label || undefined,
        region: form.region || undefined,
        max_concurrent_calls: form.max_concurrent_calls,
        capabilities: form.capabilities.length > 0 ? form.capabilities : undefined,
      });
      setForm(EMPTY_FORM);
      onCreated();
    } catch (err) {
      setCreateError(refusalCopy(err, CREATE_REFUSAL, 'Failed to add phone number'));
      const code = (err as { details?: { code?: unknown } } | null)?.details?.code;
      if (typeof code === 'string' && Object.hasOwn(CREATE_REFUSAL, code)) onAccountsStale?.();
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add phone number"
      subtitle="Register a number to the inventory"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" form="create-phone-form" className="btn-primary" disabled={creating}>
            {creating ? 'Adding…' : 'Add number'}
          </button>
        </>
      }
    >
      <form id="create-phone-form" onSubmit={handleCreate} className={styles.form}>
        <div className={styles.field}>
          <label>Phone number</label>
          <input
            value={form.phone_number}
            onChange={e => setForm(f => ({ ...f, phone_number: e.target.value }))}
            placeholder="+919876543210"
            required
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="create-phone-provider">Provider</label>
          <select
            id="create-phone-provider"
            value={form.provider_id}
            onChange={e => chooseProvider(e.target.value)}
            required
          >
            <option value="">Select provider…</option>
            {offered.map(p => (
              <option key={p.id} value={p.id}>{operatorCarrierName(p.name, p.display_name)}</option>
            ))}
          </select>
          {synced.length > 0 && (
            <p className={styles.fieldHint} data-testid="synced-carriers-hint">
              {`Numbers on ${synced.map(p => operatorCarrierName(p.name, p.display_name)).join(', ')} come from a tenant’s own carrier account: use Sync numbers on its credential under Telephony credentials.`}
            </p>
          )}
        </div>
        {asksAccount && (
          <div className={styles.field}>
            <label htmlFor="create-phone-account">Account</label>
            <select
              id="create-phone-account"
              value={form.account}
              onChange={e => setForm(f => ({ ...f, account: e.target.value }))}
              required
            >
              {hasService
                ? <option value={SERVICE_ACCOUNT}>The service’s own account</option>
                : <option value="">Select a tenant’s account…</option>}
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <p className={styles.fieldHint} data-testid="account-hint">
              A number on a tenant’s own account is assigned to that tenant automatically.
            </p>
            {credentials === null && (
              <p className={styles.fieldHint} data-testid="accounts-unreadable">
                The tenants’ carrier accounts could not be loaded. Close this form and open it again to retry.
              </p>
            )}
            {credentials !== null && accounts.length === 0 && !hasService && (
              <p className={styles.fieldHint} data-testid="accounts-none">
                {`No tenant has an active ${operatorCarrierName(chosen.name, chosen.display_name)} account. Add one under Telephony credentials first.`}
              </p>
            )}
          </div>
        )}
        <div className={styles.field}>
          <label>Label (optional)</label>
          <input
            value={form.label}
            onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
            placeholder="e.g. Primary, Collections"
          />
        </div>

        <AdvancedSection label="Advanced settings" summary="Region, capabilities and concurrency">
          <div className={styles.field}>
            <label>Region (optional)</label>
            <input
              value={form.region}
              onChange={e => setForm(f => ({ ...f, region: e.target.value }))}
              placeholder="e.g. IN, US"
            />
          </div>
          <div className={styles.field}>
            <label>
              Per-number routing cap
              <HelpTooltip text="Optional capacity associated with this telephone number. It is not purchased provider concurrency and is not added to the account provider allocation." />
            </label>
            <input
              type="number"
              min={1}
              value={form.max_concurrent_calls}
              onChange={e => setForm(f => ({ ...f, max_concurrent_calls: parseInt(e.target.value) || 1 }))}
              required
            />
          </div>
          <div className={styles.field}>
            <label>Capabilities</label>
            <div className={styles.capCheckboxes}>
              {CAPABILITY_OPTIONS.map(cap => (
                <label key={cap} className={styles.capCheckbox}>
                  <input
                    type="checkbox"
                    checked={form.capabilities.includes(cap)}
                    onChange={e => {
                      setForm(f => ({
                        ...f,
                        capabilities: e.target.checked
                          ? [...f.capabilities, cap]
                          : f.capabilities.filter(c => c !== cap),
                      }));
                    }}
                  />
                  {cap.toUpperCase()}
                </label>
              ))}
            </div>
          </div>
        </AdvancedSection>

        {createError && <div className={styles.error}><ErrorText message={createError} /></div>}
      </form>
    </Modal>
  );
}
