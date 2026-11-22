import { useId, useState } from 'react';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { useTenant } from '../../../contexts/TenantContext';
import { getAgencyCampaign } from '../../../api/agencyCampaigns';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import { useAccountCampaigns } from './useAccountCampaigns';
import styles from './CampaignTemplates.module.css';

/**
 * "Copy from a campaign…": pick one of the account's campaigns; its settings are read whole (the
 * campaign itself, not its list row) and handed back for `sectionsFromCampaign`.
 */
export function CopyFromCampaignDialog({
  open,
  onClose,
  onCopy,
  note,
}: {
  open: boolean;
  onClose: () => void;
  onCopy: (campaign: AgencyCampaign) => void;
  /** What copying does here, said under the picker. */
  note: string;
}) {
  const { tenantId, accountId } = useTenant();
  const campaigns = useAccountCampaigns(open);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const copy = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const campaign = await getAgencyCampaign(chosen, tenantId ?? undefined, accountId ?? undefined);
      onCopy(campaign);
      setChosen('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that campaign.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Copy from a campaign"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={() => void copy()} disabled={!chosen || busy}>
            {busy ? 'Copying…' : 'Copy settings'}
          </button>
        </>
      }
    >
      <div className="form-group">
        <label htmlFor={`${id}-campaign`}>Campaign</label>
        <select
          id={`${id}-campaign`}
          value={chosen}
          onChange={(e) => setChosen(e.target.value)}
          disabled={campaigns.loading}
          data-autofocus="true"
        >
          <option value="">{campaigns.loading ? 'Loading campaigns…' : 'Choose a campaign'}</option>
          {campaigns.data.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <p className={styles.muted}>{note}</p>
        {campaigns.error ? <p className={styles.fieldError}>{campaigns.error}</p> : null}
        {error ? (
          <p className={styles.fieldError} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
