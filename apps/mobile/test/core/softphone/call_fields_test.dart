import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/softphone/call_fields.dart';
import 'package:magick_agency_agent/core/softphone/softphone_view.dart';

/// The console's `softphoneFields.test.ts` call-field tables, plus the
/// `fields_invalid` details and the input kinds.
void main() {
  CallField field(String key, String label, String type, {List<String>? options, bool required = false}) =>
      CallField.fromJson({'key': key, 'label': label, 'type': type, 'options': ?options, 'required': required});

  final fields = [
    field('customer_name', 'Customer name', 'text', required: true),
    field('amount', 'Amount', 'number'),
    field('reason', 'Reason', 'choice', options: ['Rate query', 'Documents'], required: true),
    field('follow_up', 'Follow-up', 'boolean'),
    field('due', 'Due date', 'date'),
  ];

  group('call-field values', () {
    test('lets a required field be empty while live, and not when the outcome is saved', () {
      expect(validateCallFieldValues(fields, {}, requireFilled: false), isEmpty);
      final saving = validateCallFieldValues(fields, {'customer_name': '  '}, requireFilled: true);
      expect(saving, {'customer_name': fieldRequiredCopy, 'reason': fieldRequiredCopy});
    });

    test('refuses a value of the wrong type for its field', () {
      final errors = validateCallFieldValues(
        fields,
        {'amount': 'abc', 'reason': 'Other', 'follow_up': 'yes', 'due': '2026-02-30'},
        requireFilled: false,
      );
      expect(errors.keys.toList()..sort(), ['amount', 'due', 'follow_up', 'reason']);
    });

    test('types an input for its field, and empty text is absent', () {
      expect(fieldValueFromInput(fields[1], '12.5'), 12.5);
      expect(fieldValueFromInput(fields[1], 'x'), 'x');
      expect(fieldValueFromInput(fields[0], ''), isNull);
      expect(fieldValueFromInput(fields[3], true), isTrue);
      expect(fieldValueFromInput(fields[3], 'true'), isTrue);
    });

    test('sends only this set’s keys, trimmed, with empties left out', () {
      expect(cleanFieldValues(fields, {'customer_name': ' Rahul ', 'amount': null, 'stray': 'x', 'follow_up': false}), {
        'customer_name': 'Rahul',
        'follow_up': false,
      });
    });

    test('reads a value back for a person', () {
      expect(formatFieldValue(fields[3], true), 'Yes');
      expect(formatFieldValue(fields[4], '2026-11-14'), '14 Nov 2026');
      expect(formatFieldValue(fields[0], ''), isNull);
    });

    test('two value sets that save alike are the same', () {
      expect(sameFieldValues(fields, {'customer_name': 'Rahul '}, {'customer_name': 'Rahul', 'stray': 1}), isTrue);
      expect(sameFieldValues(fields, {'amount': 1}, {'amount': 2}), isFalse);
      // Against no field set, every pair is the same: nothing could be sent.
      expect(sameFieldValues(const [], {'amount': 1}, {'amount': 2}), isTrue);
    });

    test('a calendar date is a real day', () {
      expect(isCalendarDate('2026-11-14'), isTrue);
      expect(isCalendarDate('2026-02-30'), isFalse);
      expect(isCalendarDate('14/11/2026'), isFalse);
    });
  });

  group('the field set, as the screen needs it', () {
    test('a type this build does not know is shown read-only and never judged', () {
      final odd = field('signature', 'Signature', 'drawing');
      expect(fieldTypeOf(odd), SoftphoneFieldType.unsupported);
      expect(validateCallFieldValues([odd], {'signature': 42}, requireFilled: true), isEmpty);
      expect(cleanFieldValues([odd], {'signature': 42}), {'signature': 42});
      expect(fieldTypeOf(fields[4]), SoftphoneFieldType.date);
    });

    test('labels a key the set no longer has by its words', () {
      expect(fieldLabel(fields, 'amount'), 'Amount');
      expect(fieldLabel(fields, 'loan_account'), 'loan account');
    });

    test('marks the fields a fields_invalid refusal names, by `fields.<key>` or `<key>`', () {
      expect(
        fieldErrorsFromDetails(const [
          FieldIssue(path: 'fields.amount', message: 'Enter a number.'),
          FieldIssue(path: 'fields[due]', message: 'Enter a date.'),
          FieldIssue(path: 'reason', message: 'Pick one of the options.'),
        ]),
        {'amount': 'Enter a number.', 'due': 'Enter a date.', 'reason': 'Pick one of the options.'},
      );
    });
  });
}
