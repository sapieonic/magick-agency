// Promise to pay (decisions PT1–PT14) on the agent app: the shared rules'
// port, the controller's request (station and inbound share it), the agent's
// view of a contact's promise, and the soft phone's checks.

import 'package:agency_wire/agency_wire.dart' as wire;
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';
import 'package:magick_agency_agent/core/station/contact_context.dart';
import 'package:magick_agency_agent/core/station/disposition_rules.dart';
import 'package:magick_agency_agent/core/station/promise_rules.dart';
import 'package:magick_agency_agent/core/station/station_copy.dart';
import 'package:magick_agency_agent/core/station/station_view.dart';

import 'controller_harness.dart';
import 'fixtures.dart';

const _ptp = wire.Disposition(code: 'ptp', label: 'Promised to pay', requiresPromise: true);
const _ptpFollow = wire.Disposition(code: 'ptp_f', label: 'Promised (follow up)', requiresPromise: true, promiseFollowUpDays: 3);
const _sale = wire.Disposition(code: 'sale', label: 'Sale');

void main() {
  // 11 Aug 2026, 10:00 on the device.
  final now = DateTime(2026, 8, 11, 10);

  group('the rules (port of the domain module)', () {
    test('a real calendar date, or null', () {
      expect(parsePromiseDay('2026-11-18'), DateTime.utc(2026, 11, 18));
      for (final v in ['2026-02-30', '2026-13-01', '18/11/2026', '2026-11-18T00:00:00Z', '', null]) {
        expect(parsePromiseDay(v), isNull, reason: '$v');
      }
    });

    test('one day either side of the agent\'s today, up to the bound', () {
      expect(promiseDayAllowed(DateTime(2026, 8, 10), now), isTrue);
      expect(promiseDayAllowed(DateTime(2026, 8, 9), now), isFalse);
      // promiseMaxDaysAhead (30) after the agent's today, plus the day the customer may be ahead.
      expect(promiseDayAllowed(DateTime(2026, 9, 11), now), isTrue);
      expect(promiseDayAllowed(DateTime(2026, 9, 12), now), isFalse);
    });

    test('the amount is kept exactly, two places, never through a double', () {
      expect(normalisePromiseAmount('12500'), '12500.00');
      expect(normalisePromiseAmount('0.5'), '0.50');
      expect(normalisePromiseAmount('999999999999.99'), '999999999999.99');
      for (final v in ['-1', '1.005', '12,500', '1e3', 'abc', '', '1000000000000']) {
        expect(normalisePromiseAmount(v), isNull, reason: v);
      }
    });

    test('printed as the console prints it: en-IN grouping, no currency', () {
      expect(formatPromise('2026-11-18', '12500.00'), 'Promised 18 Nov 2026 · 12,500');
      expect(formatPromise('2026-11-18', '125000.50'), 'Promised 18 Nov 2026 · 1,25,000.50');
      expect(formatPromise('2026-11-18', null), 'Promised 18 Nov 2026');
      expect(formatPromiseAmount('999999999999.99'), '9,99,99,99,99,999.99');
    });
  });

  group('the request', () {
    test('needs the date; sends the promise only with the outcome that asks', () {
      expect(
        dispositionBlock(const [_ptp], code: 'ptp', notes: '', callbackAt: null, now: now),
        DispositionBlock.promiseRequired,
      );
      expect(
        dispositionBlock(const [_ptp], code: 'ptp', notes: '', callbackAt: null, now: now, promiseDate: '2026-08-09'),
        DispositionBlock.promiseDateInvalid,
      );
      expect(
        dispositionBlock(
          const [_ptp],
          code: 'ptp',
          notes: '',
          callbackAt: null,
          now: now,
          promiseDate: '2026-08-18',
          promiseAmount: '12,500',
        ),
        DispositionBlock.promiseAmountInvalid,
      );
      expect(
        buildDispositionRequest(
          const [_ptp, _sale],
          code: 'ptp',
          notes: '',
          callbackAt: null,
          now: now,
          promiseDate: '2026-08-18',
          promiseAmount: '700',
        )!.toJson(),
        {'disposition_code': 'ptp', 'promise_date': '2026-08-18', 'promise_amount': '700.00'},
      );
      expect(
        buildDispositionRequest(
          const [_ptp, _sale],
          code: 'sale',
          notes: '',
          callbackAt: null,
          now: now,
          promiseDate: '2026-08-18',
          promiseAmount: '700',
        )!.toJson(),
        {'disposition_code': 'sale'},
      );
      expect(dispositionBlockCopy[DispositionBlock.promiseRequired], 'This outcome needs the date the customer promised to pay.');
    });

    test('the station sends the promise with the outcome', () {
      fakeAsync((async) {
        final app = App(async);
        app.routes['POST /proxy/agency/sessions'] = (_) => json(200, bootstrapJson(dispositions: [
              {'code': 'interested', 'label': 'Interested'},
              {'code': 'ptp', 'label': 'Promised to pay', 'requires_promise': true, 'promise_follow_up_days': 2},
            ]));
        app.start();
        app.inWrapup('att-1');
        app.run(app.controller.submitDisposition('ptp'));
        expect(app.view!.actionError, 'This outcome needs the date the customer promised to pay.');
        expect(app.sent.where((s) => s.path.endsWith('/disposition')), isEmpty);
        app.routes['POST /proxy/agency/attempts/att-1/disposition'] = (_) => json(200, {
              'campaign_id': 'camp-1',
              'attempt_id': 'att-1',
              'contact_id': 'c-att-1',
              'disposition_code': 'ptp',
              'contact_state': 'pending',
              'agent_state': 'wrapup',
              'promise_date': '2026-11-18',
              'promise_amount': '12500.00',
            });
        final day = promiseDayString(app.now().add(const Duration(days: 3)));
        app.run(app.controller.submitDisposition('ptp', promiseDate: day, promiseAmount: '12500'));
        expect(app.requests('POST', '/proxy/agency/attempts/att-1/disposition').single.body, {
          'disposition_code': 'ptp',
          'promise_date': day,
          'promise_amount': '12500.00',
        });
        expect(app.view!.dispositionSaved, 'ptp');
        expect(app.view!.dispositions.last.requiresPromise, isTrue);
        expect(app.view!.dispositions.last.promiseFollowUpDays, 2);
        app.dispose();
      });
    });
  });

  group('the agent\'s view (PT9)', () {
    test('the contact\'s promise and the attempt that recorded it', () {
      final view = promiseViewFor(wire.ContactPromise(date: '2026-11-18', amount: '12500.00', state: wire.PromiseState.missed));
      expect(view, const PromiseView(text: 'Promised 18 Nov 2026 · 12,500', state: PromiseStanding.missed));
      expect(promiseViewFor(null), isNull);
      final prior = priorAttemptsFor(
        [
          wire.PriorAttempt(
            attemptNumber: 1,
            dispositionCode: 'ptp',
            endedAt: DateTime.utc(2026, 11, 10, 9),
            campaignId: 'camp-1',
            campaignName: 'Renewals',
            promiseDate: '2026-11-18',
            promiseAmount: '700.00',
          ),
        ],
        campaignId: 'camp-1',
        catalog: const [_ptp],
        offsetMs: 0,
      );
      expect(prior.single.promise, 'Promised 18 Nov 2026 · 700');
      expect(prior.single.outcomeLabel, 'Promised to pay');
    });
  });

  group('the soft phone (PT1 on a tagged call)', () {
    SoftphoneView viewWith({DateTime? date, String amount = ''}) => SoftphoneView(
      phase: SoftphonePhase.outcome,
      outcomes: const [
        DispositionOption(code: 'ptp', label: 'Promised to pay', requiresPromise: true),
        DispositionOption(code: 'sale', label: 'Sale'),
      ],
      outcomeCode: 'ptp',
      promiseDate: date,
      promiseAmount: amount,
    );

    test('blocks until a date is picked, refuses a far date or a bad amount', () {
      expect(viewWith().saveBlockAt(now), SoftphoneSaveBlock.promiseRequired);
      expect(viewWith(date: DateTime(2028, 1, 1)).saveBlockAt(now), SoftphoneSaveBlock.promiseDateInvalid);
      expect(viewWith(date: DateTime(2026, 8, 18), amount: 'lots').saveBlockAt(now), SoftphoneSaveBlock.promiseAmountInvalid);
      expect(viewWith(date: DateTime(2026, 8, 18), amount: '99.5').saveBlockAt(now), isNull);
      expect(softphoneSaveBlockCopy[SoftphoneSaveBlock.promiseRequired], 'This outcome needs the date the customer promised to pay.');
    });
  });

  test('a Disposition wire entry\'s promise reaches the station\'s options', () {
    expect(_ptpFollow.promiseRequired, isTrue);
    expect(_ptpFollow.promiseFollowUpDays, 3);
    expect(_sale.promiseRequired, isFalse);
  });
}
