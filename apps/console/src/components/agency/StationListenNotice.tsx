import { useEffect, useId, useRef, useState } from 'react';
import { Headphones, Info } from 'lucide-react';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { browserStorage } from '../../utils/browserStorage';
import { LIVE_LISTEN_FLAG } from '../../utils/listen/liveListenFlag';
import { LISTEN_AGENT_FIRST_NOTICE, LISTEN_AGENT_INFO_LABEL, LISTEN_AGENT_NOTICE } from '../../utils/listen/listenCopy';
import styles from './StationListenNotice.module.css';

/**
 * The agent's standing line (`docs/listening.md` LS2), in the station's and the soft phone's
 * header behind the "Monitoring and recording" info button:
 * "Calls may be listened to by a supervisor for quality and training." Shown while the account
 * allows listening (`agency_live_listen_enabled`, the consent gate), on every call or none: there
 * is deliberately no live "Supervisor listening" indicator in this build.
 *
 * A disclosure, not a menu: one button that opens a note under it. Escape closes it and returns
 * focus to the button; a click outside closes it. Nothing here acts on a call, which is why it
 * sits in the header and not the action bar.
 */
export function StationListenNotice() {
  const on = useFeatureFlagEnabled(LIVE_LISTEN_FLAG);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent | MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  if (!on) return null;

  return (
    <div
      ref={wrapRef}
      className={styles.wrap}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          setOpen(false);
          buttonRef.current?.focus();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={LISTEN_AGENT_INFO_LABEL}
        title={LISTEN_AGENT_INFO_LABEL}
        onClick={() => setOpen((was) => !was)}
        data-testid="station-info"
      >
        <Info size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      {open ? (
        <div id={panelId} className={styles.popover} role="note" data-testid="station-info-popover">
          <p className={styles.line}>{LISTEN_AGENT_NOTICE}</p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Where this browser remembers that an agent read the one-time notice, suffixed with
 * {@link agentListenScope}: one agent, one account.
 */
export const LISTEN_AGENT_NOTICE_SEEN_KEY = 'magick-agency.listen.agent-notice-seen';

/**
 * Whose notice it is: `user:tenant:account`, or null when any is not known yet (then nothing is
 * shown rather than remembered against nobody). Per account, because the flag is: an agent told in
 * one account is told again in another that turns listening on.
 */
export function agentListenScope(
  userId: string | null | undefined,
  tenantId: string | null | undefined,
  accountId: string | null | undefined,
): string | null {
  return userId && tenantId && accountId ? `${userId}:${tenantId}:${accountId}` : null;
}

function seenHere(scope: string): boolean {
  try {
    return browserStorage()?.getItem(`${LISTEN_AGENT_NOTICE_SEEN_KEY}:${scope}`) === '1';
  } catch {
    return false;
  }
}

function rememberSeen(scope: string): void {
  try {
    browserStorage()?.setItem(`${LISTEN_AGENT_NOTICE_SEEN_KEY}:${scope}`, '1');
  } catch {
    /* blocked site data: shown again next time, which errs the right way */
  }
}

/**
 * The standing line said once, out loud, rather than left behind the info button (LS2): a strip
 * under the station's or the soft phone's header the first time this agent opens either in this
 * browser and account while listening is on, until they press Got it. An agent with one campaign
 * goes straight to the station and never sees the join screen's line, so this is what tells them.
 * Copy only: it says nothing about any call, and there is no live indicator.
 */
export function StationListenFirstNotice({ scope }: { scope: string | null | undefined }) {
  const on = useFeatureFlagEnabled(LIVE_LISTEN_FLAG);
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!on || !scope || dismissed === scope || seenHere(scope)) return null;
  return (
    <section className={styles.firstNotice} aria-label={LISTEN_AGENT_FIRST_NOTICE.region} data-testid="listen-first-notice">
      <Headphones size={16} aria-hidden="true" className={styles.firstNoticeIcon} />
      <p className={styles.firstNoticeText}>
        <strong>{LISTEN_AGENT_NOTICE}</strong> {LISTEN_AGENT_FIRST_NOTICE.detail}
      </p>
      <button
        type="button"
        className="btn-secondary"
        onClick={() => {
          rememberSeen(scope);
          setDismissed(scope);
        }}
      >
        {LISTEN_AGENT_FIRST_NOTICE.dismiss}
      </button>
    </section>
  );
}
