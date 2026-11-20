import type { AgencyFloorAlert, AgencyFloorAlertKind } from '@magick-agency/contracts/api/agency/floor';
import { agentDisplayName } from '../agencyAgentFloor';
import { formatCount } from '../format/number';
import { helpChimeKey } from './floorAssist';

/**
 * Supervisor alerts on every console page (agent station AS16): the account's open alerts from
 * `GET /proxy/agency/floor/alerts` in plain words, for the shell's banner. Pure, so each rule is
 * tested where it is made.
 *
 *  - **Words** (AS15): "Ravi needs help", "Ravi’s break is over by 6 min", "Ravi is disconnected
 *    for 2 min".
 *    An agent the server could not name is the floor's fallback (`agentDisplayName`).
 *  - **Clock**: minutes over (and disconnected) are counted from the alert's `since` to the read's `as_of`, the
 *    server's own clock, so a viewer's wrong clock never says a break is over by an hour.
 *  - **Kinds**: a kind this console does not know is left out (the contract says a client ignores
 *    one), so a newer server never shows a blank row.
 */

const KNOWN_KINDS: ReadonlySet<AgencyFloorAlertKind> = new Set<AgencyFloorAlertKind>(['help', 'break_over', 'disconnected']);

/** One banner row. */
export interface FloorAlertItem {
  /** The alert's `id`, stable for the alert's life: the row's key and the screen reader's. */
  id: string;
  kind: AgencyFloorAlertKind;
  text: string;
  /**
   * The chime's key (`useHelpChime`): Need help's is built from its session and when it was raised
   * (`helpChimeKey`), as Live floor's floor read builds it, so the two reads hear one request once;
   * the other kinds' is the alert's `id`.
   */
  chimeKey: string;
}

/** Minutes from `since` to `asOf`, whole and never negative; null when either cannot be read. */
function minutesBetween(since: string, asOf: string): number | null {
  const from = Date.parse(since);
  const to = Date.parse(asOf);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.floor(Math.max(0, to - from) / 60_000);
}

/** One alert in plain words. */
export function floorAlertText(alert: AgencyFloorAlert, asOf: string): string {
  const name = agentDisplayName(alert);
  switch (alert.kind) {
    case 'help':
      return `${name} needs help`;
    case 'break_over': {
      const over = minutesBetween(alert.since, asOf);
      return over !== null && over >= 1
        ? `${name}’s break is over by ${formatCount(over)} min`
        : `${name}’s break is over time`;
    }
    case 'disconnected': {
      // How long, from the station's `disconnected_since` (the alert's `since`) to the read's `as_of`.
      const down = minutesBetween(alert.since, asOf);
      if (down === null) return `${name} is disconnected`;
      return down < 1 ? `${name} is disconnected for under a minute` : `${name} is disconnected for ${formatCount(down)} min`;
    }
  }
}

/** The banner's rows, in the server's order (oldest first), unknown kinds left out. */
export function floorAlertItems(alerts: readonly AgencyFloorAlert[], asOf: string): FloorAlertItem[] {
  return alerts
    .filter((alert) => KNOWN_KINDS.has(alert.kind))
    .map((alert) => ({
      id: alert.id,
      kind: alert.kind,
      text: floorAlertText(alert, asOf),
      chimeKey: alert.kind === 'help' ? helpChimeKey(alert.session_id, alert.help?.raised_at ?? alert.since) : alert.id,
    }));
}

/** The most rows the banner lists; the rest are counted ("and 3 more"). */
export const FLOOR_ALERTS_SHOWN_MAX = 3;
