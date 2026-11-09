import { useCallback, useEffect, useRef, useState } from 'react';
import { Link2, Unlink } from 'lucide-react';
import type {
  PhoneNumberInboundBlocker,
  PhoneNumberInboundResponse,
} from '@magick-agency/contracts/api/platform/super-admin-inbound';
import { getPhoneNumberInbound, linkPhoneNumberInbound, unlinkPhoneNumberInbound } from '../../../api/super-admin';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { operatorCarrierName } from '../../../utils/carrierName';
import styles from '../SAPhoneNumbersPage.module.css';

/**
 * A synced number's inbound link (docs/inbound.md §8.1, IB6): Link puts it on its credential's
 * carrier Application (the app it was on is kept), Unlink puts it back. Only super-admins do this,
 * one number at a time, never on sync. An account's inbound route can answer a number only
 * while it is linked.
 */

const BLOCKER: Record<PhoneNumberInboundBlocker, string> = {
  not_synced: 'Only a number synced from a tenant’s own carrier account can take inbound calls.',
  not_active: 'The number is not active.',
  not_assigned: 'The number is not assigned to its carrier account’s tenant.',
  credential_not_active: 'Its carrier credential is not active.',
  inbound_not_enabled: 'Inbound calls are not enabled on its carrier credential yet: enable them on the Telephony Credentials page first.',
};

/** The refusals an operator can act on, by code; anything else shows the server's message. */
const REFUSAL: Record<string, string> = {
  carrier_number_missing: 'The carrier no longer has this number on the tenant’s account. Nothing was changed. Sync the credential’s numbers.',
  carrier_rejected: 'The carrier refused the stored credentials. Nothing was changed. Verify or rotate the secret, then try again.',
  carrier_unreachable: 'The carrier could not be reached. Nothing was changed. Try again shortly.',
};

function refusal(err: unknown, fallback: string): string {
  const details = (err as { details?: unknown } | null)?.details;
  const code = details && typeof details === 'object' ? (details as { error?: unknown }).error : undefined;
  if (typeof code === 'string' && Object.hasOwn(REFUSAL, code)) return REFUSAL[code]!;
  return err instanceof Error && err.message ? err.message : fallback;
}

export function PhoneNumberInboundPanel({ phoneNumberId, provider, onChanged }: {
  phoneNumberId: string;
  /** The number's carrier (its API slug), for naming it ("Alias (Vendor)", PL16). */
  provider: string;
  onChanged: () => void;
}) {
  const carrier = operatorCarrierName(provider);
  const [state, setState] = useState<PhoneNumberInboundResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'link' | 'unlink' | null>(null);

  const shownFor = useRef(phoneNumberId);
  shownFor.current = phoneNumberId;
  const load = useCallback(async () => {
    const id = phoneNumberId;
    setError(null);
    try {
      const s = await getPhoneNumberInbound(id);
      if (shownFor.current === id) setState(s);
    } catch (err) {
      if (shownFor.current === id) setError(err instanceof Error ? err.message : 'Failed to load inbound');
    }
  }, [phoneNumberId]);

  useEffect(() => { setState(null); void load(); }, [load]);

  const run = async (action: 'link' | 'unlink') => {
    setBusy(true);
    setError(null);
    try {
      setState(await (action === 'link' ? linkPhoneNumberInbound : unlinkPhoneNumberInbound)(phoneNumberId));
      onChanged();
    } catch (err) {
      setError(refusal(err, `Failed to ${action} the number`));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  // A number on the service's own carrier account never takes inbound calls: say nothing.
  if (state && !state.credential) return null;

  return (
    <div className={styles.assignmentsSection} data-testid="number-inbound">
      <h4>Inbound calls</h4>
      {!state && !error && <LoadingSpinner size="sm" />}
      {state && (
        <>
          <p className={styles.inboundLine}>
            {state.link.linked ? <span className={styles.inboundBadge}>Linked</span> : <span className={styles.capBadge}>Not linked</span>}
            <span>
              {state.link.linked
                ? `Calls to this number are answered by this service (since ${new Date(state.link.linked_at!).toLocaleString('en-IN')}).`
                : `Calls to this number get whatever its ${carrier} app does.`}
            </span>
          </p>
          {state.link.linked && (
            <p className={styles.inboundLine}>
              {state.link.route
                ? <span>Answered by the route <strong>{state.link.route.name}</strong>.</span>
                : <span className={styles.noAssignments}>No account route answers it yet: an account admin adds it to one.</span>}
              <span className={styles.noAssignments}>
                {state.link.previous_app_id ? `Unlink puts it back on ${carrier} app ${state.link.previous_app_id}.` : `Unlink leaves it on no ${carrier} app.`}
              </span>
            </p>
          )}
          {!state.link.linked && state.link_blocker && <p className={styles.noAssignments}>{BLOCKER[state.link_blocker]}</p>}
          <div className={styles.detailActions}>
            {state.link.linked ? (
              <button className={`btn-secondary ${styles.dangerBtn}`} disabled={busy} onClick={(e) => { e.stopPropagation(); setConfirm('unlink'); }}>
                <Unlink size={14} /> {busy ? 'Unlinking…' : 'Unlink from inbound'}
              </button>
            ) : (
              <button className="btn-secondary" disabled={busy || state.link_blocker !== null} onClick={(e) => { e.stopPropagation(); setConfirm('link'); }}>
                <Link2 size={14} /> {busy ? 'Linking…' : 'Link to inbound'}
              </button>
            )}
          </div>
        </>
      )}
      {error && <p className={styles.inboundError} role="alert" data-testid="number-inbound-error">{error}</p>}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'unlink' ? 'Unlink from inbound?' : 'Link to inbound?'}
        message={confirm === 'unlink'
          ? `${state?.phone_number ?? 'The number'} goes back to the ${carrier} app it was on, and its account route stops answering it.`
          : `Calls to ${state?.phone_number ?? 'the number'} will be answered by this service, on ${state?.credential?.label ?? 'its credential'}’s inbound Application. `
            + 'The app it is on now is remembered, so Unlink can put it back.'}
        confirmLabel={confirm === 'unlink' ? 'Unlink' : 'Link'}
        danger={confirm === 'unlink'}
        disabled={busy}
        onConfirm={() => { if (confirm) void run(confirm); }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
