import 'package:agency_wire/agency_wire.dart';

import 'ring_channel.dart';
import 'ring_rules.dart' show RingBlocker;

/// Mode B's words on the phone, British English. Wire codes are never shown.
abstract final class RingCopy {
  // ── Why the phone stopped ringing (`away_ring` ended by the server, IQ67) ──
  static const stoppedPrefix = 'Your phone stopped ringing for inbound calls';

  static String stopped(RingOffReason? reason) => switch (reason) {
        RingOffReason.ringMissed => '$stoppedPrefix: you missed two inbound calls.',
        RingOffReason.revoked => '$stoppedPrefix: this phone is no longer registered. Open Me to set it up again.',
        RingOffReason.optedOut => '$stoppedPrefix: ringing is turned off on this phone.',
        RingOffReason.flagOff => '$stoppedPrefix: ringing was switched off for this account.',
        RingOffReason.maxAge => '$stoppedPrefix: it stops after 4 hours away.',
        RingOffReason.takenOver => '$stoppedPrefix: your station moved to another device.',
        RingOffReason.unknown || null => '$stoppedPrefix.',
      };

  /// The away notification's "Stop ringing" (this absence only).
  static const ringingStopped = 'Ringing stopped. You’re paused.';

  /// "Stop ringing" whose pause never applied: the phone may still ring for this absence.
  static const stopRingingFailed = 'Couldn’t stop ringing. Open your station to pause.';

  // ── Answering from a ring ──
  static const acceptFailed = 'This call stopped ringing or someone else took it.';
  static const dismiss = 'Dismiss';

  // ── Whether this phone rings (the card's headline, the paused notification) ──
  static const headlineReady = 'Ready: this phone rings when you leave the app';
  static String headlineBlocked(RingBlocker blocker) => 'Won’t ring: ${blockerWhy(blocker)}';
  static const loading = 'Loading this phone’s ringing settings…';

  /// Why the phone won't ring, as the end of a sentence.
  static String blockerWhy(RingBlocker blocker) => switch (blocker) {
        RingBlocker.statusUnknown => 'this phone’s ringing settings couldn’t be read',
        RingBlocker.notAllowed => 'ringing isn’t switched on for your account',
        RingBlocker.notConfigured => 'ringing phones isn’t set up on the server',
        RingBlocker.optedOut => 'ringing is turned off on this phone',
        RingBlocker.noPush => 'push messages aren’t available on this phone',
        RingBlocker.notRegistered => 'this phone isn’t registered for ringing',
        RingBlocker.checklistUnknown => 'this phone couldn’t say whether it can ring',
        RingBlocker.notifications => 'notifications are off',
        RingBlocker.phoneAccount => 'phone calling permission is off',
        RingBlocker.microphone => 'the microphone isn’t allowed',
      };

  // ── The settings card (Me) ──
  static const section = 'Inbound calls';
  static const toggle = 'Ring this phone for inbound calls';
  static const explain =
      'When you leave the app while available, inbound callers ring this phone like a normal call. Answer to take '
      'the call in the app. You won’t get campaign calls while you’re away.';
  static const missRule =
      'If you miss two inbound calls, this phone stops ringing until you open the app again, so callers aren’t '
      'kept waiting for you.';
  static const checklistTitle = 'What this phone needs';
  static const fix = 'Fix';
  static const ready = 'Ready';
  static const needsAttention = 'Needs attention';
  static const checklistUnknown = 'This phone couldn’t say whether it can ring. Try again in a moment.';
  static const noPush = 'This phone can’t receive rings: push messages aren’t available on it.';
  static const notConfigured = 'Ringing phones isn’t set up on the server yet. Ask your administrator.';
  static const unsupportedPlatform = 'Ringing for inbound calls isn’t available on this phone yet.';
  static const optInFailed = 'That change didn’t go through. Try again.';
  static const loadFailed = 'Couldn’t load this phone’s ringing settings.';
  static const tryAgain = 'Try again';

  static String item(RingChecklistItem item) => switch (item) {
        RingChecklistItem.notifications => 'Notifications',
        RingChecklistItem.fullScreen => 'Full-screen calls',
        RingChecklistItem.batteryExempt => 'Battery optimisation',
        RingChecklistItem.microphone => 'Microphone',
        RingChecklistItem.phoneAccount => 'Phone calling permission',
        RingChecklistItem.dndAllowsCalls => 'Do Not Disturb',
      };

  static String itemHint(RingChecklistItem item) => switch (item) {
        RingChecklistItem.notifications => 'Allowed, so the phone can ring',
        RingChecklistItem.fullScreen => 'A ring fills the screen, even when locked',
        RingChecklistItem.batteryExempt => 'Off for this app, so a ring isn’t held back',
        RingChecklistItem.microphone => 'Allowed, so the caller can hear you',
        RingChecklistItem.phoneAccount => 'Turned on, so the phone can ring like a call',
        RingChecklistItem.dndAllowsCalls => 'Lets calls through',
      };

  // ── The test ring ──
  static const testRing = 'Send a test ring';
  static const testSending = 'Sending a test ring…';
  static const testWaiting = 'Waiting for the test ring…';
  static const testReceived = 'Your phone rang. Ringing works on this phone.';
  static const testNotShown = 'The test ring reached this phone, but it couldn’t show the call. Check notifications.';
  static const testTimedOut = 'No test ring arrived. Check the list above, then try again.';
  static const testTooSoon = 'You just sent one. Wait a few seconds, then try again.';
  static const testFailed = 'The test ring couldn’t be sent. Try again.';
}
