import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/lifecycle/lifecycle_policy.dart';
import 'package:magick_agency_agent/core/ring/ring_channel.dart';
import 'package:magick_agency_agent/core/ring/ring_copy.dart';
import 'package:magick_agency_agent/core/ring/ring_rules.dart';

import '../inbound/inbound_fixtures.dart';

PushDeviceStatus _status(String sample, {Map<String, Object?> device = const {}, Map<String, Object?> top = const {}}) {
  final body = pushSample(sample);
  final d = body['device'];
  if (d is Map<String, Object?>) d.addAll(device);
  body.addAll(top);
  return PushDeviceStatus.fromJson(body);
}

RingChecklist _checklist({Set<RingChecklistItem> off = const {}}) =>
    RingChecklist({for (final i in RingChecklistItem.values) i: !off.contains(i)});

void main() {
  group('ringAvailable', () {
    final ringing = _status('device_status_ringing');

    test('everything in place: away_ring', () {
      expect(ringAvailable(status: ringing, optIn: true, token: 't', checklist: _checklist()), isTrue);
    });

    test('any doubt: device_away', () {
      expect(ringAvailable(status: null, optIn: true, token: 't', checklist: _checklist()), isFalse, reason: 'not read yet');
      expect(ringAvailable(status: ringing, optIn: false, token: 't', checklist: _checklist()), isFalse, reason: 'not opted in');
      expect(ringAvailable(status: ringing, optIn: true, token: null, checklist: _checklist()), isFalse, reason: 'no push');
      expect(ringAvailable(status: ringing, optIn: true, token: '', checklist: _checklist()), isFalse);
      expect(ringAvailable(status: ringing, optIn: true, token: 't', checklist: null), isFalse, reason: 'checklist unknown');
      expect(
        ringAvailable(status: _status('device_status_ringing', top: {'account_allows_ring': false}), optIn: true, token: 't', checklist: _checklist()),
        isFalse,
        reason: 'the account does not allow it',
      );
      expect(
        ringAvailable(status: _status('device_status_ringing', top: {'push_configured': false}), optIn: true, token: 't', checklist: _checklist()),
        isFalse,
        reason: 'the server cannot push',
      );
      expect(
        ringAvailable(status: _status('device_status_unregistered'), optIn: true, token: 't', checklist: _checklist()),
        isFalse,
        reason: 'no device row',
      );
      expect(
        ringAvailable(
          status: _status('device_status_ringing', device: {'revoked_at': '2026-11-02T08:00:00.000Z'}),
          optIn: true,
          token: 't',
          checklist: _checklist(),
        ),
        isFalse,
        reason: 'revoked',
      );
    });

    test('the essentials stop it; full-screen, battery and Do Not Disturb are advice', () {
      for (final item in [RingChecklistItem.notifications, RingChecklistItem.phoneAccount, RingChecklistItem.microphone]) {
        expect(ringAvailable(status: ringing, optIn: true, token: 't', checklist: _checklist(off: {item})), isFalse, reason: item.wire);
      }
      for (final item in [RingChecklistItem.fullScreen, RingChecklistItem.batteryExempt, RingChecklistItem.dndAllowsCalls]) {
        expect(ringAvailable(status: ringing, optIn: true, token: 't', checklist: _checklist(off: {item})), isTrue, reason: item.wire);
      }
    });
  });

  group('the lifecycle rules', () {
    test('awayBreakFor: away_ring when the phone can ring, else device_away', () {
      expect(awayBreakFor(ringOn: true), 'away_ring');
      expect(awayBreakFor(ringOn: false), 'device_away');
      expect(isAwayBreak('away_ring'), isTrue);
      expect(isAwayBreak('device_away'), isTrue);
      expect(isAwayBreak('phone_call'), isFalse);
      expect(isAwayBreak(null), isFalse);
    });

    test('notices: away_ring has its own (native\'s), so no "You\'re paused"; a refusal\'s device_away has it', () {
      AwayNotice notice(AgentState s, {String? code, bool asked = false, bool ring = false}) => awayNoticeFor(
            s,
            foreground: false,
            breakCode: code,
            pauseRequested: asked,
            wrapupDeadline: null,
            awayRing: ring,
          );
      expect(notice(AgentState.onBreak, code: 'away_ring'), AwayNotice.none);
      expect(notice(AgentState.available, asked: true, ring: true), AwayNotice.none);
      expect(notice(AgentState.available, asked: true), AwayNotice.paused);
      expect(notice(AgentState.onBreak, code: 'device_away', ring: true), AwayNotice.paused);
    });
  });

  group('misses and why ringing stopped', () {
    test('a miss is an expiry or an accept lapse; a decline or busy_on_phone is not (IQ62)', () {
      expect(isMissedRing(InboundRingResult.expired), isTrue);
      expect(isMissedRing(InboundRingResult.acceptLapsed), isTrue);
      for (final r in [
        InboundRingResult.declined,
        InboundRingResult.busyOnPhone,
        InboundRingResult.callerLeft,
        InboundRingResult.answeredElsewhere,
        InboundRingResult.cancelled,
      ]) {
        expect(isMissedRing(r), isFalse, reason: r.wire);
      }
      expect(isDeclinedRing(InboundRingResult.busyOnPhone), isTrue);
    });

    test('inferRingOffReason: two misses, else what the device status says, else nothing', () {
      final ringing = _status('device_status_ringing');
      expect(inferRingOffReason(missesWhileAway: 2, status: null), RingOffReason.ringMissed);
      expect(inferRingOffReason(missesWhileAway: 1, status: ringing), isNull);
      expect(inferRingOffReason(missesWhileAway: 0, status: null), isNull);
      expect(inferRingOffReason(missesWhileAway: 0, status: _status('device_status_unregistered')), RingOffReason.revoked);
      expect(inferRingOffReason(missesWhileAway: 0, status: _status('device_status_failed_opted_out')), RingOffReason.optedOut);
      expect(
        inferRingOffReason(missesWhileAway: 0, status: _status('device_status_ringing', top: {'account_allows_ring': false})),
        RingOffReason.flagOff,
      );
      expect(
        inferRingOffReason(
          missesWhileAway: 0,
          status: _status('device_status_ringing', device: {'last_failure_reason': 'unregistered', 'last_failure_at': '2026-11-02T08:00:00.000Z'}),
        ),
        RingOffReason.revoked,
      );
    });

    test('every reason is said in words, never as a code', () {
      for (final r in [...RingOffReason.values, null]) {
        final text = RingCopy.stopped(r);
        expect(text, startsWith('Your phone stopped ringing for inbound calls'));
        expect(text, isNot(contains('_')));
      }
      expect(RingCopy.stopped(RingOffReason.ringMissed), 'Your phone stopped ringing for inbound calls: you missed two inbound calls.');
    });
  });

  group('the channel (frozen: docs/mobile.md "The ring channel (Mode B)")', () {
    test('native → Dart events read as the contract says', () {
      expect((ringEventOf('token', {'token': 'abc'})! as RingTokenChanged).token, 'abc');
      expect(ringEventOf('token', {'token': ''}), isNull);
      final answered = ringEventOf('ringAnswered', {'call_id': 'c1', 'offer_token': 'secret', 'session_id': 's1'})! as RingAnswered;
      expect(answered.answer, const RingAnswer(callId: 'c1', offerToken: 'secret', sessionId: 's1'));
      expect(answered.answer.toString(), isNot(contains('secret')), reason: 'the offer token is never logged');
      expect(ringEventOf('ringAnswered', {'call_id': 'c1'}), isNull);
      final ended = ringEventOf('ringEnded', {'call_id': 'c1', 'reason': 'expired'})! as RingEnded;
      expect(ended.reason, InboundRingResult.expired);
      expect((ringEventOf('ringEnded', {'call_id': 'c1', 'reason': 'something_new'})! as RingEnded).reason, InboundRingResult.unknown);
      expect((ringEventOf('testRingReceived', null)! as RingTestReceived).shown, isTrue, reason: 'an older native side');
      expect((ringEventOf('testRingReceived', {'shown': false})! as RingTestReceived).shown, isFalse);
      expect(ringEventOf('stopRingingTapped', null), isA<RingStopTapped>());
      expect(ringEventOf('ringOff', {'reason': 'ring_missed'}), isNull, reason: 'not in the frozen channel');
    });

    test('the checklist keys and the end reasons are the contract\'s', () {
      expect(RingChecklistItem.values.map((i) => i.wire), [
        'notifications',
        'full_screen',
        'battery_exempt',
        'microphone',
        'phone_account',
        'dnd_allows_calls',
      ]);
      expect(RingEndReason.values.map((r) => r.wire), ['ended', 'accept_failed', 'cancelled']);
      final read = RingChecklist.tryRead({'notifications': true, 'microphone': true, 'phone_account': true})!;
      expect(read.essentialsOk, isTrue);
      expect(read.allOk, isFalse, reason: 'a key native did not send reads false');
      expect(RingChecklist.tryRead('nope'), isNull);
    });

    test('a platform with no native side answers nothing, never throws', () async {
      TestWidgetsFlutterBinding.ensureInitialized();
      final channel = MethodRingChannel();
      expect(await channel.getToken(), isNull);
      expect(await channel.pendingAnswer(), isNull);
      expect(await channel.checklist(), isNull);
      await channel.reportEnded('c1', RingEndReason.cancelled);
    });
  });
}
