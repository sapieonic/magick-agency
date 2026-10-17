import { useState } from 'react';
import { Send } from 'lucide-react';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { useTenant } from '../../contexts/TenantContext';
import { resendInvite } from '../../api/invites';
import { CopyableField } from '../../components/common/CopyableField';
import type { ResendInviteResult, TenantMember } from '../../types/team';
import styles from './TeamPage.module.css';

/**
 * The resend itself: one confirmation, then the same hand-off the invite modal
 * gives.
 *
 * A confirmation rather than a bare menu item that fires, because a resend is not
 * idempotent from the recipient's side — the server revokes the outstanding token
 * first, so pressing this INVALIDATES a link that may be sitting unread in the
 * agent's inbox. A supervisor who meant to press "Change Role" must not discover
 * that by having broken the link they were about to be asked about.
 *
 * The outcome reads `invite_email.sent` exactly as {@link InviteModal} does, and
 * for the same reason: whether anybody was told is the server's answer, per
 * deployment, and the panel must not claim either way on its own.
 */
export function ResendInviteModal({
  member,
  onClose,
  onResent,
}: {
  member: TenantMember;
  onClose: () => void;
  /** Refresh the list — the membership itself is untouched, but its invite is not. */
  onResent: () => void;
}) {
  const { tenantId } = useTenant();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResendInviteResult | null>(null);

  const handleResend = async () => {
    if (!tenantId) return;
    setSubmitting(true);
    setError(null);
    try {
      const answer = await resendInvite(tenantId, member.membership.id);
      setResult(answer ?? {});
      onResent();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send that invitation');
    } finally {
      setSubmitting(false);
    }
  };

  const emailed = result?.invite_email?.sent === true;

  return (
    <Modal
      open
      size="sm"
      onClose={onClose}
      title={result ? (emailed ? 'Invitation sent' : 'Now send them the link') : 'Resend invitation'}
    >
      {result ? (
        <>
          {emailed ? (
            <p className={styles.handoffLead} data-testid="resend-emailed">
              We’ve emailed <strong>{member.user.email}</strong> a new link. Any
              earlier one has stopped working.
            </p>
          ) : (
            <p className={styles.handoffLead} data-testid="resend-handoff">
              <strong>{member.user.email}</strong> has a new invitation, but we didn’t
              email them — send them the link yourself. Any earlier one has stopped
              working.
            </p>
          )}
          <CopyableField label="Their email" value={member.user.email} mono />
          {/*
            The server's link, and only the server's. There is no client-side
            derivation for this one: the useful link carries the freshly
            minted TOKEN, which only the server has ever seen. Where it answers
            `null` (no `CONSOLE_BASE_URL` configured) the honest thing is to say
            so rather than to substitute the sign-in page, which is a URL that
            looks like the invitation and claims nothing.
          */}
          {result.sign_in_url ? (
            <CopyableField label="Invitation link" value={result.sign_in_url} mono />
          ) : (
            <p className={styles.handoffNote} data-testid="resend-no-link">
              We could not build the link to send. Ask your administrator to set the
              app’s public address, then resend.
            </p>
          )}
        </>
      ) : (
        <>
          <p className={styles.handoffLead}>
            Send <strong>{member.user.email}</strong> a new invitation. Any earlier link
            stops working straight away, so only do this if they still need one.
          </p>
          {error && <p className="error-text">{error}</p>}
        </>
      )}
      <div className={styles.modalFooter}>
        {result ? (
          <button type="button" className="btn-primary" onClick={onClose} data-autofocus="true">
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={handleResend}
              disabled={submitting}
              data-autofocus="true"
            >
              <Send size={14} />
              {submitting ? 'Sending...' : 'Send invitation'}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
