import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/foundation.dart';

import '../../ui/primitives.dart';

/// How a campaign row reads: its status pill, what to say about it, and
/// whether "Enter station" is offered.
///
/// Advisory, as in the console (`utils/agencyAssignmentEntry.ts`): the server
/// decides whether a join succeeds. Only the terminal statuses (`stopped`,
/// `completed`) hide the way in, because no call will ever arrive there.
/// An unknown or missing status never blocks: a status the server added
/// after this build, or a lookup that failed, must not lock a floor out of
/// a running campaign.
@immutable
class AssignmentEntry {
  const AssignmentEntry({required this.canEnter, required this.note, required this.label, required this.tone});

  final bool canEnter;

  /// Beside the button when [canEnter], or the reason there is none.
  final String? note;

  /// The status pill, or null when the status is unknown (lookup failed).
  final String? label;
  final Tone tone;

  @override
  bool operator ==(Object other) =>
      other is AssignmentEntry && other.canEnter == canEnter && other.note == note && other.label == label && other.tone == tone;
  @override
  int get hashCode => Object.hash(canEnter, note, label, tone);
}

/// What a list is doing, in the console's words (`agentHome.ts`'s `workStatus`): one line, as the
/// pill. An unknown status says nothing it cannot stand behind (AS1) and keeps the way in.
AssignmentEntry assignmentEntry(Assignment a) {
  final raw = a.campaignStatusRaw;
  if (raw == null || raw.isEmpty) return const AssignmentEntry(canEnter: true, note: null, label: null, tone: Tone.neutral);
  return switch (a.campaignStatus ?? CampaignStatus.unknown) {
    CampaignStatus.running => const AssignmentEntry(canEnter: true, note: null, label: 'Calling is on', tone: Tone.ok),
    CampaignStatus.paused => const AssignmentEntry(canEnter: true, note: null, label: 'Paused by your supervisor', tone: Tone.warn),
    CampaignStatus.draft => const AssignmentEntry(canEnter: true, note: null, label: 'Not started yet', tone: Tone.neutral),
    CampaignStatus.stopping => const AssignmentEntry(canEnter: true, note: null, label: 'Ending now. No new calls.', tone: Tone.warn),
    CampaignStatus.stopped =>
      const AssignmentEntry(canEnter: false, note: null, label: 'Ended by your supervisor. No more calls.', tone: Tone.neutral),
    CampaignStatus.completed =>
      const AssignmentEntry(canEnter: false, note: null, label: 'Finished. Every customer was called.', tone: Tone.accent),
    CampaignStatus.unknown => const AssignmentEntry(canEnter: true, note: null, label: null, tone: Tone.neutral),
  };
}

String campaignDisplayName(Assignment a) {
  final name = a.campaignName?.trim() ?? '';
  return name.isEmpty ? 'Unnamed campaign' : name;
}
