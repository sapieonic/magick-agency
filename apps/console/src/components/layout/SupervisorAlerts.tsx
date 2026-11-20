import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { BellRing, Coffee, Hand, Volume2, VolumeX, WifiOff, type LucideIcon } from 'lucide-react';
import type { AgencyFloorAlertKind } from '@magick-agency/contracts/api/agency/floor';
import { useTenant } from '../../contexts/TenantContext';
import { useFloorAlerts } from '../../hooks/useFloorAlerts';
import { useHelpChime } from '../../hooks/useHelpChime';
import { useNavGate } from '../../hooks/useNavGate';
import { HOME_GATE, HOME_PATH, passesGate, pathWithin } from '../../utils/consoleNav';
import {
  FLOOR_ALERTS_SHOWN_MAX,
  floorAlertItems,
  type FloorAlertItem,
} from '../../utils/agency/floorAlerts';
import { formatCount } from '../../utils/format/number';
import styles from './SupervisorAlerts.module.css';

const KIND_ICONS: Readonly<Record<AgencyFloorAlertKind, LucideIcon>> = {
  help: Hand,
  break_over: Coffee,
  disconnected: WifiOff,
};

/**
 * Supervisor alerts on every page of the console's shell (agent station AS16): one light read of
 * the account's open alerts (`useFloorAlerts`, every 5 s while the tab is visible), a banner that
 * lists them in plain words ("Ravi needs help", "Ravi’s break is over by 6 min", "Ravi is
 * disconnected for 2 min"), each a link to Live floor, and the help chime once per new alert, which
 * the reader mutes for this browser from the banner (the same setting as Live floor's).
 *
 * Only for a reader Live floor is for (`HOME_GATE`: `agency.supervise`, the `agency` capability and
 * the dialer flag); anyone else never asks, and a 403 or a failing read shows nothing.
 *
 * On Live floor itself the banner is not shown: Needs you now has a row for each kind, each with
 * its action (Need help, an agent disconnected past 20 s, a break over its limit), and the cards
 * say the same. The alerts are still read there, and chimed, into the one set of heard alerts the
 * page's own chime shares (`useHelpChime`): whichever read hears an alert first chimes it, once,
 * so leaving or opening Live floor never chimes one again.
 *
 * Light: it is its own component, so a poll re-renders it alone, never the shell or the page; the
 * rows re-render only when their words change (`AlertRows` is memoised on a signature).
 */
export function SupervisorAlerts() {
  const { tenantId, accountId, role } = useTenant();
  const gate = useNavGate();
  const enabled = Boolean(accountId) && passesGate(HOME_GATE, gate);
  const response = useFloorAlerts(tenantId, accountId, enabled, role);
  const { pathname } = useLocation();
  const onLiveFloor = pathWithin(pathname, HOME_PATH);

  const items = useMemo(
    () => (response ? floorAlertItems(response.alerts, response.as_of) : null),
    [response],
  );
  // One string per state of the banner: a poll that says the same keeps every memo below.
  const signature = items === null ? '' : items.map((item) => `${item.id}\t${item.text}`).join('\n');
  // Keyed on the signature on purpose: a new response with the same words is the same rows.
  const stableItems = useMemo(() => items ?? [], [signature]);
  const ready = items !== null;
  const ids = useMemo(() => (ready ? stableItems.map((item) => item.id) : null), [ready, stableItems]);
  // Heard once on the page, whichever read sees an alert first: Live floor's own chime shares the set.
  const chimeKeys = useMemo(
    () => (ready ? stableItems.map((item) => ({ kind: item.kind, key: item.chimeKey })) : null),
    [ready, stableItems],
  );
  const chime = useHelpChime(chimeKeys);

  // Said once to a screen reader when a new alert comes in (not on the first read, not every poll).
  const announced = useRef<Set<string> | null>(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (ids === null) return;
    if (announced.current === null) {
      announced.current = new Set(ids);
      return;
    }
    const fresh = stableItems.filter((item) => !announced.current!.has(item.id));
    for (const item of fresh) announced.current.add(item.id);
    if (fresh.length > 0) setAnnouncement(fresh.map((item) => item.text).join('. '));
  }, [ids, stableItems]);

  if (!enabled || onLiveFloor) return null;
  return (
    <>
      <p className="sr-only" aria-live="polite" data-testid="supervisor-alerts-announcement">{announcement}</p>
      {stableItems.length > 0 ? (
        <section className={styles.banner} aria-label="Alerts" data-testid="supervisor-alerts">
          <BellRing size={16} aria-hidden="true" className={styles.bell} />
          <AlertRows items={stableItems} />
          <button
            type="button"
            className={styles.sound}
            onClick={chime.toggle}
            aria-pressed={chime.on}
            aria-label="Alert sound"
            title={chime.on ? 'Sound is on. Press to turn it off in this browser.' : 'Sound is off. Press to turn it on in this browser.'}
            data-testid="supervisor-alerts-sound"
          >
            {chime.on ? <Volume2 size={16} aria-hidden="true" /> : <VolumeX size={16} aria-hidden="true" />}
          </button>
        </section>
      ) : null}
    </>
  );
}

/** The rows, each a link to Live floor; past {@link FLOOR_ALERTS_SHOWN_MAX}, the rest counted. */
const AlertRows = memo(function AlertRows({ items }: { items: readonly FloorAlertItem[] }) {
  const shown = items.slice(0, FLOOR_ALERTS_SHOWN_MAX);
  const more = items.length - shown.length;
  return (
    <ul className={styles.rows}>
      {shown.map((item) => {
        const Icon = KIND_ICONS[item.kind];
        return (
          <li key={item.id} className={styles.row} data-kind={item.kind}>
            <Link to={HOME_PATH} className={styles.link} data-testid={`supervisor-alert-${item.kind}`}>
              <Icon size={14} aria-hidden="true" />
              {item.text}
            </Link>
          </li>
        );
      })}
      {more > 0 ? (
        <li className={styles.row}>
          <Link to={HOME_PATH} className={styles.link} data-testid="supervisor-alerts-more">
            {`and ${formatCount(more)} more on Live floor`}
          </Link>
        </li>
      ) : null}
    </ul>
  );
});
