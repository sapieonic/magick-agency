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

    test('ringOffReasonOnReturn: the ring_off for this absence, else two misses, the device status, the maximum age; '
        'else nothing (a normal return is not news)', () {
      final ringing = _status('device_status_ringing');
      RingOffReason? on({RingOffRecord? off, int misses = 0, PushDeviceStatus? status, Duration? away = const Duration(minutes: 5)}) =>
          ringOffReasonOnReturn(ringOff: off, missesWhileAway: misses, status: status, awayFor: away);
      expect(on(status: ringing), isNull, reason: 'nothing says it stopped');
      expect(on(), isNull);
      expect(on(off: const RingOffRecord(reason: RingOffReason.takenOver), status: ringing), RingOffReason.takenOver);
      expect(on(off: const RingOffRecord(reason: RingOffReason.unknown)), RingOffReason.unknown, reason: 'told it stopped, not a guess why');
      expect(on(misses: 2), RingOffReason.ringMissed);
      expect(on(misses: 1, status: ringing), isNull);
      expect(on(status: _status('device_status_unregistered')), RingOffReason.revoked);
      expect(on(status: _status('device_status_failed_opted_out')), RingOffReason.optedOut);
      expect(on(status: _status('device_status_ringing', top: {'account_allows_ring': false})), RingOffReason.flagOff);
      expect(on(status: _status('device_status_ringing', top: {'push_configured': false})), RingOffReason.unknown);
      expect(
        on(status: _status('device_status_ringing', device: {'last_failure_reason': 'unregistered', 'last_failure_at': '2026-11-02T08:00:00.000Z'})),
        RingOffReason.revoked,
      );
      expect(
        on(status: _status('device_status_ringing', device: {'last_failure_reason': 'invalid', 'last_failure_at': '2026-11-02T08:00:00.000Z'})),
        RingOffReason.revoked,
        reason: 'the server revokes on invalid too',
      );
      expect(
        on(status: _status('device_status_ringing', device: {'last_failure_reason': 'unavailable', 'last_failure_at': '2026-11-02T08:00:00.000Z'})),
        isNull,
        reason: 'a service failure does not revoke',
      );
      expect(on(status: ringing, away: const Duration(hours: 4)), RingOffReason.maxAge);
      expect(on(status: ringing, away: const Duration(hours: 3, minutes: 59)), isNull);
    });

    test('ringOffEndsAbsence: this session, and an absence starting no more than 2 s before this one', () {
      final start = DateTime.utc(2026, 11, 2, 7, 58, 41, 120);
      RingOffRecord off({String? session = 'sess-1', DateTime? since}) => RingOffRecord(sessionId: session, awaySince: since, reason: RingOffReason.ringMissed);
      expect(ringOffEndsAbsence(off(since: start), sessionId: 'sess-1', absenceStart: start), isTrue);
      expect(ringOffEndsAbsence(off(since: start.subtract(const Duration(milliseconds: 1500))), sessionId: 'sess-1', absenceStart: start), isTrue);
      expect(ringOffEndsAbsence(off(since: start.subtract(const Duration(hours: 1))), sessionId: 'sess-1', absenceStart: start), isFalse);
      expect(ringOffEndsAbsence(off(session: 'sess-0', since: start), sessionId: 'sess-1', absenceStart: start), isFalse);
      expect(ringOffEndsAbsence(off(session: null), sessionId: 'sess-1', absenceStart: start), isTrue, reason: 'an older server says less');
    });

    test('a ring_off record reads as native sends it (the contract\'s ring_off)', () {
      final push = pushSample('push_ring_off');
      final record = RingOffRecord.tryRead({'session_id': push['session_id'], 'away_since': push['away_since'], 'reason': push['reason']})!;
      expect(record, RingOffRecord(sessionId: '6c1f0d3e-8a4b-4f7e-9d21-3b5a7c9e0f12', awaySince: DateTime.utc(2026, 11, 2, 7, 58, 41, 120), reason: RingOffReason.ringMissed));
      expect(RingOffRecord.tryRead({'reason': 'something_new'}), const RingOffRecord(reason: RingOffReason.unknown));
      expect(RingOffRecord.tryRead(null), isNull);
    });

    test('ringBlockerOf: the first thing in the way, in order; none when ringAvailable', () {
      final ok = _status('device_status_ringing');
      const all = RingChecklist({
        RingChecklistItem.notifications: true,
        RingChecklistItem.fullScreen: false,
        RingChecklistItem.batteryExempt: false,
        RingChecklistItem.microphone: true,
        RingChecklistItem.phoneAccount: true,
        RingChecklistItem.dndAllowsCalls: false,
      });
      RingBlocker? b({PushDeviceStatus? status, bool optIn = true, String? token = 't', RingChecklist? list = all, bool noStatus = false}) =>
          ringBlockerOf(status: noStatus ? null : (status ?? ok), optIn: optIn, token: token, checklist: list);
      expect(b(), isNull, reason: 'advice items (full screen, battery, DND) never block');
      expect(b(noStatus: true), RingBlocker.statusUnknown);
      expect(b(status: _status('device_status_ringing', top: {'account_allows_ring': false})), RingBlocker.notAllowed);
      expect(b(status: _status('device_status_ringing', top: {'push_configured': false})), RingBlocker.notConfigured);
      expect(b(optIn: false), RingBlocker.optedOut);
      expect(b(token: null), RingBlocker.noPush);
      expect(b(status: _status('device_status_unregistered')), RingBlocker.notRegistered);
      expect(b(list: null), RingBlocker.checklistUnknown);
      expect(b(list: RingChecklist({...all.items, RingChecklistItem.notifications: false, RingChecklistItem.microphone: false})), RingBlocker.notifications);
      expect(b(list: RingChecklist({...all.items, RingChecklistItem.phoneAccount: false})), RingBlocker.phoneAccount);
      expect(b(list: RingChecklist({...all.items, RingChecklistItem.microphone: false})), RingBlocker.microphone);
      expect(ringAvailable(status: ok, optIn: true, token: 't', checklist: all), isTrue);
    });

    test('a 409 refusal reads as a blocker; only what goes wrong on an opted-in phone is news', () {
      expect(ringBlockerOfRefusal(AwayRingRefusalCode.noPushDevice), RingBlocker.notRegistered);
      expect(ringBlockerOfRefusal(AwayRingRefusalCode.pushUnavailable), RingBlocker.notConfigured);
      expect(ringBlockerIsNews(RingBlocker.notRegistered), isTrue);
      expect(ringBlockerIsNews(RingBlocker.notifications), isTrue);
      for (final quiet in [RingBlocker.optedOut, RingBlocker.notAllowed, RingBlocker.statusUnknown, null]) {
        expect(ringBlockerIsNews(quiet), isFalse, reason: '$quiet');
      }
      for (final b in RingBlocker.values) {
        expect(RingCopy.headlineBlocked(b), startsWith('Won’t ring: '));
        expect(RingCopy.blockerWhy(b), isNot(contains('_')), reason: 'words, never a code');
      }
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
      expect(ringEventOf('stopRingingTapped', null), isNull, reason: 'Dart reads "Stop ringing" (peekStopRinging)');
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
      expect(read.ok(RingChecklistItem.fullScreen), isFalse, reason: 'a key native did not send reads false');
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
