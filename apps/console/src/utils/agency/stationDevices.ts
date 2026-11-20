import { classifyCaptureError } from '../../hooks/useAudioCapture';
import type { DeviceChecks } from './stationView';

/**
 * Start of day's device checks (spec 01, §5.1), the pure half. The hook that runs them is
 * `pages/agency/station/useDeviceChecks`.
 *
 * The internet check is the station socket itself (open or not), so it is not here.
 */

/** A capture failure, as 01b names it. */
export function microphoneCheckFrom(err: unknown): DeviceChecks['microphone'] {
  switch (classifyCaptureError(err).kind) {
    case 'permission_denied':
      return 'blocked';
    case 'no_device':
      return 'not_found';
    case 'device_busy':
      return 'in_use';
    default:
      return 'problem';
  }
}

/**
 * Words in a device's label that mean a headset. A guess (spec §5.1: the browser cannot tell a
 * headset from a desk microphone), so it never blocks Start work: a miss only says "No headset.
 * Calls will use the computer speaker." in amber.
 */
const HEADSET = /head ?set|head ?phone|earphone|earbud|ear ?piece|airpods|buds|bluetooth|hands-?free|jabra|plantronics|\bpoly\b|sennheiser|\bepos\b|logitech h|\bh\d{3}\b|usb audio|wired/i;

/**
 * The headset check from the browser's device list. `unknown` (not shown) where the browser
 * gives no labels, which it does until the microphone has been allowed once, or has no list.
 */
export function headsetCheckFrom(devices: readonly Pick<MediaDeviceInfo, 'kind' | 'label'>[] | null): DeviceChecks['headset'] {
  if (!devices) return 'unknown';
  const audio = devices.filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput');
  const labelled = audio.filter((d) => d.label.trim() !== '');
  if (labelled.length === 0) return 'unknown';
  return labelled.some((d) => HEADSET.test(d.label)) ? 'ok' : 'missing';
}
