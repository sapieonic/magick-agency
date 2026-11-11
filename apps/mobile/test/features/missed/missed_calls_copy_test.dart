import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/features/missed/missed_calls_copy.dart';

import 'support.dart';

/// The words the console's `missedCopy.ts` has for how a row was handled,
/// in an agent's view.
void main() {
  test('who handled it, and how', () {
    InboundMissedCall row(String? reason, String? by, String? name) => missed('m', {
          'status': 'handled',
          'handled_reason': reason,
          'handled_by_user_id': by,
          'handled_by_name': name,
          'handled_at': '2026-10-14T04:30:00.000Z',
        });
    expect(MissedCopy.handledLabel(row('marked', 'u1', 'Meera K'), 'u1'), 'You');
    expect(MissedCopy.handledLabel(row('marked', 'u9', 'Arjun'), 'u1'), 'Arjun');
    expect(MissedCopy.handledLabel(row('marked', 'u9', null), 'u1'), 'A former member');
    expect(MissedCopy.handledLabel(row(null, null, null), 'u1'), 'Closed automatically');
    expect(MissedCopy.handledLabel(row('reached', 'u1', 'Meera K'), 'u1'), 'Customer reached by you');
    expect(MissedCopy.handledLabel(row('reached', 'u9', null), 'u1'), 'Customer reached by a former member');
    expect(MissedCopy.handledLabel(row('reached', null, null), 'u1'), 'Customer reached');
  });

  test('the caller in a sentence, and the count line', () {
    expect(MissedCopy.markedAnnouncement(missed('m')), 'Marked the call from +91 87654 32109 as handled.');
    expect(MissedCopy.reopenedAnnouncement(missed('w', {'from_e164': null})),
        'Reopened the call from a withheld number. It is back on the list to follow up.');
    expect(MissedCopy.countLine(1, more: false), 'Showing 1 call');
    expect(MissedCopy.countLine(50, more: true), 'Showing 50 calls — there are more');
  });

  test('empty states', () {
    expect(MissedCopy.emptyTitle(open: true, filtered: false), 'No missed calls to follow up');
    expect(MissedCopy.emptyTitle(open: false, filtered: false), 'No handled missed calls');
    expect(MissedCopy.emptyTitle(open: true, filtered: true), 'Nothing matches that filter');
  });

  test('the list\'s own sentences, word for word as the console has them', () {
    expect(MissedCopy.subtitle,
        'Your customers who rang when nobody could answer. Call them back. Reaching them closes the row on its own; '
        'mark it handled only if you dealt with it another way.');
    expect(MissedCopy.voicemailOnConsole, 'Listen on the web console');
    expect(MissedCopy.callBackWaits,
        'Switch to the soft phone within 5 minutes and the number will be on the pad. Nothing is dialled until you press Call.');
  });
}
