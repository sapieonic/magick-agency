import 'package:agency_wire/agency_wire.dart';

import '../../../ui/primitives.dart';

/// What happened on a call, in words, from `packages/contracts/src/api/agency/agency-spine.ts`
/// (`ATTEMPT_OUTCOME_LABELS`, `ATTEMPT_STATE_LABELS`), so an agent reads the same label on both
/// clients: My calls, customer history and the soft phone's call labels read these.

const attemptOutcomeLabels = <AttemptOutcome, String>{
  AttemptOutcome.connected: 'Connected',
  AttemptOutcome.noAnswer: 'No answer',
  AttemptOutcome.busy: 'Busy',
  AttemptOutcome.failed: 'Failed',
  AttemptOutcome.machine: 'Answering machine',
  AttemptOutcome.invalid: 'Invalid number',
  AttemptOutcome.abandoned: 'Abandoned (no agent free)',
  AttemptOutcome.agentDisconnected: 'Agent disconnected',
  AttemptOutcome.orphaned: 'Interrupted by a system fault',
  AttemptOutcome.canceled: 'Stopped by us before answer',
};

const attemptStateLabels = <AttemptState, String>{
  AttemptState.queued: 'Queued',
  AttemptState.dialing: 'Dialling',
  AttemptState.ringing: 'Ringing',
  AttemptState.answered: 'Answered',
  AttemptState.bridged: 'On the call',
  AttemptState.ended: 'Ended',
};

/// The pill's tone: green for a conversation, amber where the dialer let the
/// customer down, red where the line or the system failed, neutral for the
/// ordinary misses.
Tone outcomeTone(AttemptOutcome? outcome) => switch (outcome) {
      AttemptOutcome.connected => Tone.ok,
      AttemptOutcome.abandoned || AttemptOutcome.agentDisconnected => Tone.warn,
      AttemptOutcome.failed || AttemptOutcome.invalid || AttemptOutcome.orphaned => Tone.danger,
      _ => Tone.neutral,
    };
