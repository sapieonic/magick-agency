import 'dart:convert';
import 'dart:io';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/features/calls/logic/attempt_copy.dart';
import 'package:magick_agency_agent/features/calls/widgets/attempt_detail_sheet.dart';
import 'package:magick_agency_agent/ui/primitives.dart';

import 'support.dart';

/// A label map from `packages/contracts/fixtures/agent/labels.json`, which
/// `tooling/contracts-literals.mjs` extracts from the contract's own maps
/// (`ATTEMPT_STATE_LABELS`, `ATTEMPT_OUTCOME_LABELS`), found by walking up from
/// the working directory.
Map<String, String> contractLabels(String map) {
  var dir = Directory.current.absolute;
  while (!File('${dir.path}/packages/contracts/fixtures/agent/labels.json').existsSync()) {
    if (dir.parent.path == dir.path) throw StateError('packages/contracts/fixtures/agent/labels.json not found');
    dir = dir.parent;
  }
  final doc = jsonDecode(File('${dir.path}/packages/contracts/fixtures/agent/labels.json').readAsStringSync())
      as Map<String, Object?>;
  return ((doc[map]! as Map<String, Object?>)['labels']! as Map<String, Object?>).cast<String, String>();
}

void main() {
  test('state and outcome labels are word for word the contract\'s (British: "Dialling")', () {
    expect({for (final e in attemptStateLabels.entries) e.key.wire: e.value}, contractLabels('attempt_state_labels'));
    expect({for (final e in attemptOutcomeLabels.entries) e.key.wire: e.value}, contractLabels('attempt_outcome_labels'));
    expect(attemptStateLabels[AttemptState.dialing], 'Dialling');
  });

  test('outcome labels are the contract\'s, null is "Not classified", unknown is shown as sent', () {
    expect(attemptOutcomeLabels.length, AttemptOutcome.values.length - 1); // every member but `unknown`
    expect(attemptOutcomeLabel(attempt(1, outcome: AttemptOutcome.abandoned)), 'Abandoned (no agent free)');
    expect(attemptOutcomeLabel(attempt(1, outcome: null)), 'Not classified');
    final future = AttemptRow.fromJson({
      ..._json(attempt(1)),
      'outcome': 'voicemail_left',
    });
    expect(attemptOutcomeLabel(future), 'voicemail_left');
  });

  test('tones: green for a conversation, never red for an ordinary miss', () {
    expect(outcomeTone(AttemptOutcome.connected), Tone.ok);
    expect(outcomeTone(AttemptOutcome.noAnswer), Tone.neutral);
    expect(outcomeTone(AttemptOutcome.abandoned), Tone.warn);
    expect(outcomeTone(AttemptOutcome.failed), Tone.danger);
    expect(outcomeTone(null), Tone.neutral);
  });

  test('a row: number, time, campaign, try, talk and the write-up preview', () {
    final today = DateTime(2026, 10, 14);
    final r = attempt(1, notes: 'Wants a call\nafter 6 pm', created: DateTime(2026, 10, 14, 11, 24));
    final v = AttemptRowView.of(r);
    expect(v.phone, '+91 98400 10001');
    expect(v.meta('Q4 Card Renewals', r, today), '11:24 am · Q4 Card Renewals · try 2 · 3:41');
    expect(v.writeUp, 'Callback · Wants a call after 6 pm');
    expect(identical(AttemptRowView.of(r), v), isTrue); // formatted once per row

    final yesterday = attempt(2, talk: null, code: null, created: DateTime(2026, 10, 13, 9, 5));
    final y = AttemptRowView.of(yesterday);
    expect(y.meta('Q4', yesterday, today), '13 Oct, 09:05 am · Q4 · try 2');
    expect(y.writeUp, 'Not written up');
    expect(y.talk, '—');
  });

  test('the detail sheet carries every field the row has, and nothing supervisor-only', () {
    final r = attempt(3, notes: 'Asked for email', onBehalf: true);
    final fields = attemptDetailFields(r, 'Q4 Card Renewals');
    final labels = fields.map((f) => f.$1).toList();
    expect(labels, containsAll(['When', 'Number', 'Campaign', 'Try', 'Where it got to', 'Outcome', 'Write-up',
        'Filed by', 'Notes', 'Talk time', 'Wrap-up', 'Dialled', 'Answered', 'Joined to you', 'Ended', 'Written up', 'Called from']));
    expect(labels.any((l) => l.contains('Record') || l.contains('Transcript')), isFalse);
    expect(fields.firstWhere((f) => f.$1 == 'Where it got to').$2, 'Ended');
    expect(fields.firstWhere((f) => f.$1 == 'Dialled').$2, '—');
  });

  test('count line and empty copy', () {
    expect(attemptsCountLine(1, more: false), 'Showing 1 call');
    expect(attemptsCountLine(150, more: true), 'Showing 150 calls — there are more');
    expect(attemptsEmptyCopy(filtered: true).title, 'No calls match those filters');
    expect(attemptsEmptyCopy(filtered: false).title, 'You haven’t taken any calls yet');
  });
}

Map<String, Object?> _json(AttemptRow r) => {
      'id': r.id,
      'campaign_id': r.campaignId,
      'contact_id': r.contactId,
      'attempt_number': r.attemptNumber,
      'phone_e164': r.phoneE164,
      'caller_id': r.callerId,
      'agent_user_id': null,
      'reserved_agent_id': null,
      'state': r.stateRaw,
      'outcome': r.outcomeRaw,
      'disposition_code': r.dispositionCode,
      'notes': r.notes,
      'callback_at': null,
      'dispositioned_by_user_id': null,
      'dispositioned_at': null,
      'dispositioned_on_behalf': r.dispositionedOnBehalf,
      'webrtc_call_id': null,
      'dialed_at': null,
      'answered_at': null,
      'bridged_at': null,
      'ended_at': null,
      'talk_seconds': r.talkSeconds,
      'wrapup_seconds': null,
      'created_at': r.createdAt.toIso8601String(),
    };
