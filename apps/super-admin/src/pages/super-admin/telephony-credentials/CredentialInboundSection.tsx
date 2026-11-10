import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, PhoneIncoming, PhoneOff, Route } from 'lucide-react';
import type {
  TelephonyCredentialInboundHealthCheck,
  TelephonyCredentialInboundResponse,
  TelephonyCredentialInboundUrl,
} from '@magick-agency/contracts/api/platform/super-admin-inbound';
import type { TelephonyCredential } from '@magick-agency/contracts/api/platform/super-admin-telephony-credentials';
import {
  checkCredentialInboundHealth,
  disableCredentialInbound,
  enableCredentialInbound,
  getCredentialInbound,
  repointCredentialInbound,
} from '../../../api/super-admin';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { operatorCarrierName } from '../../../utils/carrierName';
import { CARRIER_REFUSAL, formatDateTime as fmt, refusalCopy } from '../../../utils/operatorCopy';
import styles from '../SATelephonyCredentialsPage.module.css';

/**
 * A credential's inbound calls (docs/inbound.md §8.1, IB6): the carrier Application on the
 * tenant's account that its linked numbers send calls to. Enable makes it, Check health compares
 * its URLs with the stored ones, Re-point gives it this server's URLs and a new token, Disable
 * deletes it (refused while numbers are linked). Numbers are linked one by one on the Phone
 * Numbers page; this lists them with their links.
 */

type InboundAction = 'enable' | 'disable' | 'repoint';

const RUN: Record<InboundAction, (id: string) => Promise<TelephonyCredentialInboundResponse>> = {
  enable: enableCredentialInbound,
  disable: disableCredentialInbound,
  repoint: repointCredentialInbound,
};

function confirmCopy(carrier: string): Record<InboundAction, { title: string; message: string; label: string; danger: boolean }> {
  return {
    enable: {
      title: 'Enable inbound calls?',
      message: `This creates an Application on the tenant’s ${carrier} account that answers calls with this service. `
        + 'No number changes yet: link each number on the Phone Numbers page.',
      label: 'Enable inbound',
      danger: false,
    },
    repoint: {
      title: 'Re-point the Application?',
      message: 'The Application gets this server’s callback URLs and a new token. Calls already answered keep working: '
        + 'the old token is accepted for 24 hours more.',
      label: 'Re-point',
      danger: false,
    },
    disable: {
      title: 'Disable inbound calls?',
      message: `The Application is deleted from the tenant’s ${carrier} account. Calls to this account’s numbers are no longer `
        + 'answered by this service.',
      label: 'Disable inbound',
      danger: true,
    },
  };
}

const URL_NAME: Record<TelephonyCredentialInboundUrl, string> = {
  answer_url: 'answer URL',
  hangup_url: 'hangup URL',
  fallback_answer_url: 'fallback answer URL',
};

/** The refusals an operator can act on, by code; anything else shows the server's message. */
const REFUSAL: Record<string, string> = {
  inbound_unconfigured: 'This server has no public callback address for the carrier (docs/operations.md). Set it, then try again.',
  inbound_numbers_linked: 'Numbers are still linked to inbound on this credential. Unlink them on the Phone Numbers page first.',
  inbound_previous_token_in_use: 'A call answered before the last re-point is still in progress, and its hangup still needs the address that re-point replaced. Try again once it has ended (within about four hours of that re-point).',
  credential_not_active: 'Only an active credential can enable inbound. Enable or verify it first.',
  ...CARRIER_REFUSAL,
};

function healthText(h: TelephonyCredentialInboundHealthCheck, carrier: string): string {
  const main = (() => {
    switch (h.health) {
      case 'ok': return 'Healthy: the Application’s URLs are the ones this service gave it.';
      case 'url_mismatch': return `The Application’s ${h.mismatched.map((u) => URL_NAME[u]).join(', ')} ${h.mismatched.length === 1 ? 'was' : 'were'} changed in ${carrier}. Re-point to put ${h.mismatched.length === 1 ? 'it' : 'them'} back.`;
      case 'app_missing': return `${carrier} no longer has this Application (deleted in its console?). Re-point to create it again and move the linked numbers onto it.`;
      case 'unreachable': return `${carrier} could not be reached, so the Application could not be checked. Try again shortly.`;
    }
  })();
  return h.stored_urls_current ? main : `${main} This server’s callback URLs have changed since the Application was set up: Re-point to move it onto them.`;
}

export function CredentialInboundSection({ credential }: { credential: TelephonyCredential }) {
  const [state, setState] = useState<TelephonyCredentialInboundResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<TelephonyCredentialInboundHealthCheck | null>(null);
  const [busy, setBusy] = useState<InboundAction | 'health' | null>(null);
  const [confirm, setConfirm] = useState<InboundAction | null>(null);
  const carrier = operatorCarrierName(credential.provider);
  const CONFIRM = confirmCopy(carrier);

  // A slow answer for a credential the section no longer shows must not land.
  const shownFor = useRef(credential.id);
  shownFor.current = credential.id;
  const load = useCallback(async () => {
    const id = credential.id;
    setLoadError(null);
    try {
      const s = await getCredentialInbound(id);
      if (shownFor.current === id) setState(s);
    } catch (err) {
      if (shownFor.current === id) setLoadError(err instanceof Error ? err.message : 'Failed to load inbound');
    }
  }, [credential.id]);

  useEffect(() => { setState(null); setHealth(null); setError(null); void load(); }, [load]);

  const run = async (action: InboundAction) => {
    setBusy(action);
    setError(null);
    try {
      setState(await RUN[action](credential.id));
      setHealth(null);
    } catch (err) {
      setError(refusalCopy(err, REFUSAL, `Failed to ${action === 'repoint' ? 're-point' : action} inbound`));
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const check = async () => {
    setBusy('health');
    setError(null);
    try {
      setHealth((await checkCredentialInboundHealth(credential.id)).health);
    } catch (err) {
      setError(refusalCopy(err, REFUSAL, 'Failed to check the Application'));
    } finally {
      setBusy(null);
    }
  };

  const inbound = state?.inbound;
  const linked = inbound?.linked_numbers ?? 0;
  const revoked = credential.status === 'revoked';

  return (
    <section className={styles.inboundSection} aria-label="Inbound calls" data-testid="credential-inbound">
      <h4 className={styles.inboundTitle}><PhoneIncoming size={14} /> Inbound calls</h4>
      {loadError && <div className={styles.error} role="alert">{loadError}</div>}
      {!state && !loadError && <LoadingSpinner size="sm" />}
      {state && inbound && (
        <>
          {!state.webhook_base_configured && (
            <div className={styles.error} role="alert">
              This server has no public callback address for the carrier (docs/operations.md), so inbound cannot be enabled or re-pointed.
            </div>
          )}
          {inbound.enabled && state.connects_agents === false && (
            <div className={styles.error} role="alert" data-testid="inbound-no-connect">
              Calls can’t be put through to agents: media workers are on (MEDIA_WORKERS above 0) on this deployment.
              Calls are still answered, but every caller hears the call-back message. Run with MEDIA_WORKERS=0 while inbound is on.
            </div>
          )}
          <dl className={styles.detailGrid}>
            <div className={styles.detailItem}>
              <dt>Status</dt>
              <dd>
                <span className={inbound.enabled ? styles.inboundOn : styles.inboundOff}>{inbound.enabled ? 'Enabled' : 'Not enabled'}</span>
              </dd>
            </div>
            {inbound.enabled && (
              <>
                <div className={styles.detailItem}><dt>{carrier} Application</dt><dd className={styles.mono}>{inbound.app_id}</dd></div>
                <div className={styles.detailItem}><dt>Enabled on</dt><dd>{fmt(inbound.enabled_at)}</dd></div>
                <div className={styles.detailItem}><dt>Linked numbers</dt><dd>{linked}</dd></div>
                {inbound.previous_token_expires_at && new Date(inbound.previous_token_expires_at).getTime() > Date.now() && (
                  <div className={styles.detailItem}><dt>Previous token accepted until</dt><dd>{fmt(inbound.previous_token_expires_at)}</dd></div>
                )}
              </>
            )}
          </dl>

          {state.numbers.length > 0 && (
            <ul className={styles.inboundNumbers} aria-label="Numbers on this credential">
              {state.numbers.map((n) => (
                <li key={n.phone_number_id}>
                  <span className={styles.mono}>{n.phone_number}</span>
                  {n.link.linked ? <span className={styles.inboundOn}>Linked</span> : <span className={styles.inboundOff}>Not linked</span>}
                  {n.status !== 'active' && <span className={styles.muted}>{n.status}</span>}
                  {!n.assigned && <span className={styles.muted}>not assigned to the tenant</span>}
                  {n.link.route && <span className={styles.muted}><Route size={12} /> {n.link.route.name}</span>}
                  {n.link.linked && !n.link.route && <span className={styles.muted}>no route: callers hear the closed message</span>}
                </li>
              ))}
            </ul>
          )}
          {inbound.enabled && (
            <p className={styles.help}>
              Link or unlink each number on the Phone Numbers page. A linked number no route answers gives its callers the closed message.
              The Application is checked every 15 minutes as well; Check health checks it now.
            </p>
          )}

          {!revoked && (
            <div className={styles.detailActions}>
              {!inbound.enabled ? (
                <button
                  className="btn-secondary"
                  disabled={busy !== null || credential.status !== 'active' || !state.webhook_base_configured}
                  title={credential.status !== 'active' ? 'Only an active credential can enable inbound' : undefined}
                  onClick={() => setConfirm('enable')}
                >
                  <PhoneIncoming size={14} /> {busy === 'enable' ? 'Enabling…' : 'Enable inbound'}
                </button>
              ) : (
                <>
                  <button className="btn-secondary" disabled={busy !== null} onClick={() => void check()}>
                    <Activity size={14} /> {busy === 'health' ? 'Checking…' : 'Check health'}
                  </button>
                  <button className="btn-secondary" disabled={busy !== null || !state.webhook_base_configured} onClick={() => setConfirm('repoint')}>
                    <Route size={14} /> {busy === 'repoint' ? 'Re-pointing…' : 'Re-point'}
                  </button>
                  <button
                    className={`btn-secondary ${styles.dangerBtn}`}
                    disabled={busy !== null || linked > 0}
                    title={linked > 0 ? 'Unlink every number first' : undefined}
                    onClick={() => setConfirm('disable')}
                  >
                    <PhoneOff size={14} /> {busy === 'disable' ? 'Disabling…' : 'Disable inbound'}
                  </button>
                </>
              )}
            </div>
          )}
          {health && (
            <div className={styles.syncResult} role="status" data-testid="inbound-health">
              <p className={styles.syncHeadline}>{healthText(health, carrier)}</p>
              <p className={styles.muted}>Checked {fmt(health.checked_at)}</p>
            </div>
          )}
        </>
      )}
      {error && <div className={`${styles.error} ${styles.syncResult}`} role="alert" data-testid="inbound-error">{error}</div>}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm ? CONFIRM[confirm].title : ''}
        message={confirm ? CONFIRM[confirm].message : ''}
        confirmLabel={confirm ? CONFIRM[confirm].label : ''}
        danger={confirm ? CONFIRM[confirm].danger : false}
        disabled={busy !== null}
        onConfirm={() => { if (confirm) void run(confirm); }}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}
