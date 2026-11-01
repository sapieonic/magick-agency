import 'package:agency_wire/agency_wire.dart';

import '../../features/performance/logic/en_in_format.dart';
import 'softphone_view.dart' show SoftphoneFieldType;

/// Call details: the values an agent types into the account's call fields, and
/// the client half of the rules the server applies to them (`fields_invalid`).
/// A port of the console's `utils/softphone/callFields.ts`.
///
/// The server validates values against the field set in force when they are
/// saved and refuses an unknown key or a wrong type rather than dropping it, so
/// the app only ever sends keys of the set it rendered, typed as the set says.
/// A required field may be empty while the call is live: it is the OUTCOME that
/// cannot be saved without it.
///
/// A value is a `String` (text, choice, and a date as `YYYY-MM-DD`), a `num`, a
/// `bool`, or null (empty).

/// Whether [value] counts as not filled in.
bool isEmptyFieldValue(Object? value) => value == null || (value is String && value.trim().isEmpty);

final _date = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$');

/// A real calendar day written `YYYY-MM-DD` (`2026-02-30` is not one).
bool isCalendarDate(String value) {
  final m = _date.firstMatch(value);
  if (m == null) return false;
  final y = int.parse(m[1]!);
  final mo = int.parse(m[2]!);
  final d = int.parse(m[3]!);
  final date = DateTime.utc(y, mo, d);
  return date.year == y && date.month == mo && date.day == d;
}

/// The field's input kind; a type this build does not know is shown read-only.
SoftphoneFieldType fieldTypeOf(CallField field) => switch (field.type) {
  CallFieldType.text => SoftphoneFieldType.text,
  CallFieldType.number => SoftphoneFieldType.number,
  CallFieldType.choice => SoftphoneFieldType.choice,
  CallFieldType.boolean => SoftphoneFieldType.boolean,
  CallFieldType.date => SoftphoneFieldType.date,
  CallFieldType.unknown => SoftphoneFieldType.unsupported,
};

/// What one input produced, typed for its field. Empty text is null (absent).
/// An unparseable number stays as text, so the field can say what is wrong with
/// it rather than silently becoming empty under the agent's cursor.
Object? fieldValueFromInput(CallField field, Object raw) {
  if (field.type == CallFieldType.boolean) return raw is bool ? raw : raw == 'true';
  final text = raw is String ? raw : '$raw';
  if (text.trim().isEmpty) return null;
  if (field.type == CallFieldType.number) {
    final n = num.tryParse(text.trim());
    return n != null && n.isFinite ? n : text;
  }
  return text;
}

/// The value as an input's text.
String fieldInputValue(Object? value) => value == null ? '' : '$value';

const fieldRequiredCopy = 'Fill this in before you save the outcome.';

/// One message per field that is wrong, keyed by the field's `key`.
///
/// [requireFilled] is the outcome's rule: required fields must be filled.
/// Without it (live edits) only a value that cannot be the field's type is an
/// error. A field of a type this build does not know is never judged.
Map<String, String> validateCallFieldValues(
  List<CallField> fields,
  Map<String, Object?> values, {
  required bool requireFilled,
}) {
  final errors = <String, String>{};
  for (final field in fields) {
    final value = values[field.key];
    if (isEmptyFieldValue(value)) {
      if (requireFilled && field.required) errors[field.key] = fieldRequiredCopy;
      continue;
    }
    switch (field.type) {
      case CallFieldType.number:
        if (value is! num || !value.isFinite) errors[field.key] = 'Enter a number.';
      case CallFieldType.choice:
        if (value is! String || !(field.options ?? const <String>[]).contains(value)) {
          errors[field.key] = 'Pick one of the options.';
        }
      case CallFieldType.date:
        if (value is! String || !isCalendarDate(value)) errors[field.key] = 'Enter a date.';
      case CallFieldType.boolean:
        if (value is! bool) errors[field.key] = 'Choose yes or no.';
      case CallFieldType.text:
        if (value is! String) {
          errors[field.key] = 'Enter text.';
        } else if (value.length > 2000) {
          errors[field.key] = 'Keep this under 2,000 characters.';
        }
      case CallFieldType.unknown:
        break;
    }
  }
  return errors;
}

/// The values to send: only keys of this field set, strings trimmed, empties
/// left out (null or absent is empty, and `fields` replaces the stored values
/// wholesale, so leaving a key out clears it).
Map<String, Object?> cleanFieldValues(List<CallField> fields, Map<String, Object?> values) {
  final out = <String, Object?>{};
  for (final field in fields) {
    final value = values[field.key];
    if (isEmptyFieldValue(value)) continue;
    out[field.key] = value is String ? value.trim() : value;
  }
  return out;
}

/// Whether two value sets would save as the same thing.
bool sameFieldValues(List<CallField> fields, Map<String, Object?> a, Map<String, Object?> b) {
  final ca = cleanFieldValues(fields, a);
  final cb = cleanFieldValues(fields, b);
  for (final key in {...ca.keys, ...cb.keys}) {
    if (ca[key] != cb[key]) return false;
  }
  return true;
}

/// A saved value for reading (the call detail, the recent list); null for empty.
String? formatFieldValue(CallField? field, Object? value) {
  if (isEmptyFieldValue(value)) return null;
  if (value is bool) return value ? 'Yes' : 'No';
  if (field?.type == CallFieldType.date && value is String && isCalendarDate(value)) {
    final parts = value.split('-').map(int.parse).toList();
    // Built at local noon from the parts, so the calendar day cannot shift with the reader's zone.
    return EnIn.dayMonthYear(DateTime(parts[0], parts[1], parts[2], 12));
  }
  return '$value';
}

/// The field's label in a sentence, falling back to the key for a field since
/// removed from the set.
String fieldLabel(List<CallField> fields, String key) {
  for (final f in fields) {
    if (f.key == key) return f.label;
  }
  return key.replaceAll('_', ' ');
}

final _fieldsPrefix = RegExp(r'^fields[.[]');
final _closingBracket = RegExp(r'\]$');

/// A `fields_invalid` refusal's details (`fields.<key>` or `<key>`) as errors
/// by field key, so the fields typed before Call are marked rather than left
/// for the agent to hunt.
Map<String, String> fieldErrorsFromDetails(List<FieldIssue> details) => {
  for (final d in details) d.path.replaceFirst(_fieldsPrefix, '').replaceFirst(_closingBracket, ''): d.message,
};
