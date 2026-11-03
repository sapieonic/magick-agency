import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/features/contacts/my_contacts_copy.dart';

import 'support.dart';

/// My contacts' words: one sentence per refusal code, per retry block, per
/// bucket, never a raw code on an agent's phone.
void main() {
  final now = DateTime(2026, 10, 14, 11);

  AgentRetryRefusal refused(String code, {Map<String, Object?>? details, String message = 'The server’s words'}) =>
      AgentRetryRefusal.fromBody({'error': 'Conflict', 'code': code, 'message': message, 'details': ?details});

  test('every refusal code has its own sentence, never the code and never the server’s words', () {
    final seen = <String>{};
    for (final code in AgentRetryErrorCode.values) {
      if (code.isUnknown) continue;
      final text = MyContactsCopy.refusal(refused(code.wire), now: now);
      expect(text, matches(RegExp(r'\S')), reason: code.wire);
      expect(text, isNot(contains(code.wire)), reason: code.wire);
      expect(text, isNot('The server’s words'), reason: code.wire);
      seen.add(text);
    }
    // At least one sentence per code but the two that share the soft phone's words.
    expect(seen.length, greaterThanOrEqualTo(AgentRetryErrorCode.values.length - 2));
  });

  test('a code this build does not know shows the server’s sentence, or a fallback', () {
    expect(MyContactsCopy.refusal(refused('quota_exceeded'), now: now), 'The server’s words');
    expect(MyContactsCopy.refusal(refused('quota_exceeded', message: ''), now: now), isNotEmpty);
  });

  test('a refusal’s details are read into its sentence', () {
    expect(
      MyContactsCopy.refusal(
        refused('contact_not_retryable', details: {'blocked': 'cooldown', 'available_at': DateTime(2026, 10, 14, 11, 30).toUtc().toIso8601String()}),
        now: now,
      ),
      'This contact can’t be called now. It was called too recently. It can be retried at 11:30.',
    );
    expect(
      MyContactsCopy.refusal(
        refused('outside_calling_hours', details: {'next_open_at': DateTime(2026, 10, 15, 9).toUtc().toIso8601String()}),
        now: now,
      ),
      'It’s outside this campaign’s calling hours. Calls resume at 15 Oct · 09:00.',
    );
  });

  test('every retry block has a sentence', () {
    for (final b in [...AgentRetryBlock.values, null]) {
      expect(MyContactsCopy.retryBlock(b, now: now), matches(RegExp(r'\S')), reason: '$b');
    }
  });

  test('every bucket has a label; a newer one reads as words, not a code', () {
    for (final b in MyContactBucket.values) {
      expect(MyContactsCopy.bucketLabel(b), matches(RegExp(r'\S')), reason: b.wire);
    }
    expect(MyContactsCopy.bucketLabel(MyContactBucket.suppressed), 'DNC');
    expect(MyContactsCopy.bucketLabel(MyContactBucket.unknown, raw: 'on_hold'), 'On hold');
  });

  test('an override badge names what is left of it', () {
    expect(MyContactsCopy.overrideBadge(grant(extra: 3, early: true)), '+3 tries · Call early');
    expect(MyContactsCopy.overrideBadge(grant(extra: 1, hours: true)), '+1 try · Outside hours');
  });

  test('a row says when it is next due: a callback’s booked time, a retry’s next try', () {
    final at = fixedNow.add(const Duration(hours: 2));
    expect(MyContactsCopy.whenLine(contact(1, bucket: MyContactBucket.callback, next: at), fixedNow), startsWith('Callback '));
    expect(MyContactsCopy.whenLine(contact(2, next: at), fixedNow), startsWith('Next try '));
    expect(MyContactsCopy.whenLine(contact(3, next: fixedNow), fixedNow), 'Due now');
  });

  test('any failure in words: a refusal through the table, the rest as the API layer says it', () {
    expect(
      MyContactsCopy.error(refusal('dnc_listed'), now: now),
      'This number is on the Do Not Call list. It can’t be called.',
    );
    expect(MyContactsCopy.error(const ApiNetworkError('offline'), now: now), const ApiNetworkError('offline').userMessage);
    const plain = ApiHttpError(status: 500, code: null, message: 'x', body: {'message': 'x'}, requestId: null);
    expect(MyContactsCopy.error(plain, now: now), plain.userMessage);
  });
}
