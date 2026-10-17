import { useState } from 'react';
import { createPhoneNumber } from '../../../api/super-admin';
import type { TelephonyProvider } from '../../../api/super-admin';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { HelpTooltip } from '@magick-agency/web-ui/components/HelpTooltip';
import { ErrorText } from '@magick-agency/web-ui/components/ErrorText';
import { telephonyProviderAlias } from '@magick-agency/web-ui/telephonyProviders';
import { AdvancedSection } from '../../../components/common';
import styles from '../SAPhoneNumbersPage.module.css';

const CAPABILITY_OPTIONS = ['voice', 'sms'] as const;

const EMPTY_FORM = {
  phone_number: '',
  provider_id: '',
  label: '',
  region: '',
  max_concurrent_calls: 1,
  capabilities: ['voice'] as string[],
};

/**
 * "Add phone number". Stays mounted while closed, so a half-filled form and
 * its last error survive closing and reopening; a successful add resets it.
 * Only ACTIVE providers are offered.
 */
export function PhoneNumberCreateModal({ open, providers, onClose, onCreated }: {
  open: boolean;
  providers: TelephonyProvider[];
  onClose: () => void;
  /** Called after a successful add; the parent closes the modal and refetches. */
  onCreated: () => void;
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      await createPhoneNumber({
        phone_number: form.phone_number,
        provider_id: form.provider_id,
        label: form.label || undefined,
        region: form.region || undefined,
        max_concurrent_calls: form.max_concurrent_calls,
        capabilities: form.capabilities.length > 0 ? form.capabilities : undefined,
      });
      setForm(EMPTY_FORM);
      onCreated();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to add phone number');
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
          <label>Provider</label>
          <select
            value={form.provider_id}
            onChange={e => setForm(f => ({ ...f, provider_id: e.target.value }))}
            required
          >
            <option value="">Select provider…</option>
            {providers.filter(p => p.status === 'active').map(p => (
              <option key={p.id} value={p.id}>{telephonyProviderAlias(p.name, p.display_name)}</option>
            ))}
          </select>
        </div>
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
