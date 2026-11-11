import type { AgencyStationDeviceFields } from '@magick-agency/contracts/agency';

/**
 * This window's station device id (OS3, `packages/contracts/src/agency/station-device.ts`).
 *
 * **One per page load**, held in memory and nowhere else. The server remembers which device holds
 * a session's station and refuses a token mint from any other one, so a window whose socket
 * dropped (a laptop asleep) cannot reconnect onto a station the agent has since opened on their
 * phone or in another window. Per page load rather than per tab (`sessionStorage`) because a
 * duplicated tab copies `sessionStorage`, and two windows sharing an id would both count as the
 * holder. A reload is a new device, which costs nothing: opening the station page is the agent's
 * own choice to work here, so the join takes the station over (`takeOver` below).
 *
 * 8–64 of `[A-Za-z0-9_-]` (`AGENCY_STATION_DEVICE_ID_PATTERN`): a UUID, with a non-crypto fallback
 * for a context without `crypto.randomUUID` (an insecure origin), which only has to be unlikely to
 * collide with the agent's other windows.
 */
let deviceId: string | null = null;

export function stationDeviceId(): string {
  if (deviceId === null) {
    deviceId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
  return deviceId;
}

/**
 * The device fields for a request. `takeOver`: the agent chose this window (opening the station
 * or the soft phone, or "Use this window instead"); never on an automatic reconnect.
 */
export function stationDeviceBody(takeOver: boolean): Required<AgencyStationDeviceFields> {
  return { device_id: stationDeviceId(), take_over: takeOver };
}

/** For tests: forget the id, so the next read makes a new one (a new page load). */
export function resetStationDeviceIdForTests(): void {
  deviceId = null;
}
