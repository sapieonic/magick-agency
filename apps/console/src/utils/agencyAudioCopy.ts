import type { AudioCaptureError, AudioCaptureFailureKind } from '../hooks/useAudioCapture';

/**
 * What the agent is told when their microphone does not work.
 *
 * ── Why this is a module and not four inline strings ────────────────────────
 * Silence is the one failure on this screen that does not announce itself. Every
 * other thing that can go wrong — a dropped socket, a refused disposition, a
 * failed hang-up — produces *something* the agent can see. A microphone that
 * never opened produces a call that looks perfect: the panel populates, the talk
 * timer runs, the customer is on the line, and the agent talks into nothing for
 * two minutes before working out that the problem is at their end and not the
 * customer's. So the message must state **what is broken** and **what to do**,
 * in that order, and it must be reviewable as copy rather than buried in a hook.
 *
 * ── The rule the strings follow ─────────────────────────────────────────────
 * Say what the customer is experiencing, not what the API returned. "Your
 * microphone is blocked" is actionable; "NotAllowedError" is not, and neither is
 * "audio capture failed". The remedy is a separate sentence so the two can be
 * rendered with different weight.
 */

export interface AgencyAudioNotice {
  /** One short sentence naming the failure in the agent's terms. */
  headline: string;
  /** One short sentence naming the next action. Never "contact support". */
  remedy: string;
  /**
   * Label for an in-banner button that **fixes this from the click itself**, or
   * `null` when the remedy is something only the agent can do elsewhere.
   *
   * Exactly one kind has this. A browser's autoplay policy is lifted by any user
   * gesture, so the banner announcing it can also be the gesture that clears it
   * — and it has to be, because on a mid-call reload there is no other control
   * the agent has any reason to press. A denied permission or an unplugged
   * headset cannot be fixed by a click, and offering a button there would be a
   * promise the console cannot keep.
   */
  action: string | null;
}

const NOTICES: Record<AudioCaptureFailureKind, AgencyAudioNotice> = {
  permission_denied: {
    headline: 'Your microphone is blocked — the customer cannot hear you.',
    remedy: 'Allow microphone access for this site in your browser, then reload.',
    action: null,
  },
  no_device: {
    headline: 'No microphone was found — the customer cannot hear you.',
    remedy: 'Plug in your headset, then reload.',
    action: null,
  },
  device_busy: {
    headline: 'Your microphone is in use by another app — the customer cannot hear you.',
    remedy: 'Close the other app using it, then reload.',
    action: null,
  },
  device_lost: {
    headline: 'Your microphone disconnected — the customer cannot hear you.',
    remedy: 'Reconnect your headset, then reload.',
    action: null,
  },
  /**
   * The reload case, and the only notice whose headline has to claim **both**
   * directions: a suspended context stops the capture worklet *and* silences
   * every scheduled playback buffer, so the agent can neither hear nor be heard
   * while everything else on the screen — talk timer, connection pill, mute
   * button — reports a healthy call.
   *
   * "Reload" is deliberately NOT the remedy here; reloading is what caused it.
   */
  audio_blocked: {
    headline: 'Audio is paused by your browser — you cannot hear or be heard.',
    remedy: 'This happens after a reload. Turn it back on to rejoin the call:',
    action: 'Turn audio back on',
  },
  unsupported: {
    headline: 'This browser cannot open your microphone here.',
    remedy: 'Open the console over https in Chrome, Edge or Firefox.',
    action: null,
  },
  unknown: {
    headline: 'Your microphone could not be opened — the customer cannot hear you.',
    remedy: 'Reload the console. If it happens again, tell your supervisor.',
    action: null,
  },
};

export function agencyAudioNotice(error: AudioCaptureError | null): AgencyAudioNotice | null {
  if (error === null) return null;
  /**
   * Falls back through `unknown` rather than returning `null` for a kind this
   * map has not heard of. A `null` here would be read as "no problem", and the
   * whole point of this module is that an unreported microphone problem is
   * indistinguishable from a working one.
   */
  return NOTICES[error.kind] ?? NOTICES.unknown;
}
