import { PhoneIncoming } from 'lucide-react';
import { CUSTOMER_WAITING_HINT, customerWaitingLine } from '../../../utils/inbound/inboundCall';
import type { AgencyStationCustomerWaitingFrame } from '../../../types/inbound';
import styles from './CustomerWaitingPill.module.css';

/**
 * "Your customer is waiting" (P2, `docs/inbound.md` §4.3): a caller who usually speaks to this
 * agent has rung in while the agent is on a call or writing one up, and will be put through
 * to them first when they free.
 *
 * In the action bar's flexible slot beside the queued-break pill, which gives way before a
 * control does, so its arrival moves nothing the agent reaches for. Not a live region: the
 * station has exactly two, both spent on the call in front of the agent; the sentence is the
 * pill's text and its explanation its title.
 */
export function CustomerWaitingPill({ waiting }: { waiting: AgencyStationCustomerWaitingFrame }) {
  const line = customerWaitingLine(waiting);
  return (
    <span className={styles.wrap}>
      <span className={styles.chip} title={`${line}. ${CUSTOMER_WAITING_HINT}`} data-testid="customer-waiting">
        <PhoneIncoming size={13} aria-hidden="true" />
        <span className={styles.chipText}>{line}</span>
      </span>
    </span>
  );
}
