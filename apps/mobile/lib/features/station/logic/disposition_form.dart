import 'package:collection/collection.dart';
import 'package:flutter/foundation.dart';

import '../../../core/station/promise_rules.dart';
import '../../../core/station/station_view.dart';

/// The wrap-up form's rules (mirrors the console's `agencyDispositionForm`).
///
/// Pure: every rule is unit-tested without a widget, and the screen re-checks
/// on every keystroke so "Save outcome" never stays disabled until a blur.

/// Which callback choice the agent made, so the chip stays selected.
enum CallbackChoice { inOneHour, tomorrowMorning, tomorrowEvening, picked }

@immutable
class DispositionForm {
  const DispositionForm({this.code, this.callbackAt, this.callbackChoice, this.promiseDate, this.promiseAmount = ''});

  final String? code;
  final DateTime? callbackAt;
  final CallbackChoice? callbackChoice;

  /// Promise to pay (PT1): the promised day (only its date is read) and the
  /// amount as typed.
  final DateTime? promiseDate;
  final String promiseAmount;

  /// Selecting a code keeps the callback the agent already chose: switching
  /// between two callback-type codes must not throw the time away. The
  /// promise is kept the same way; it is sent only with an outcome that asks.
  DispositionForm select(String code) => DispositionForm(
    code: code,
    callbackAt: callbackAt,
    callbackChoice: callbackChoice,
    promiseDate: promiseDate,
    promiseAmount: promiseAmount,
  );

  DispositionForm withCallback(DateTime at, CallbackChoice choice) => DispositionForm(
    code: code,
    callbackAt: at,
    callbackChoice: choice,
    promiseDate: promiseDate,
    promiseAmount: promiseAmount,
  );

  DispositionForm withPromiseDate(DateTime day) => DispositionForm(
    code: code,
    callbackAt: callbackAt,
    callbackChoice: callbackChoice,
    promiseDate: DateTime(day.year, day.month, day.day),
    promiseAmount: promiseAmount,
  );

  DispositionForm withPromiseAmount(String amount) => DispositionForm(
    code: code,
    callbackAt: callbackAt,
    callbackChoice: callbackChoice,
    promiseDate: promiseDate,
    promiseAmount: amount,
  );

  /// `YYYY-MM-DD`, or null when no date is chosen.
  String? get promiseDay => promiseDate == null ? null : promiseDayString(promiseDate!);

  @override
  bool operator ==(Object other) =>
      other is DispositionForm &&
      other.code == code &&
      other.callbackAt == callbackAt &&
      other.callbackChoice == callbackChoice &&
      other.promiseDate == promiseDate &&
      other.promiseAmount == promiseAmount;
  @override
  int get hashCode => Object.hash(code, callbackAt, callbackChoice, promiseDate, promiseAmount);
}

/// Why "Save outcome" is disabled. Null means it is enabled.
enum DispositionBlock {
  noSelection,
  noteRequired,
  callbackRequired,
  callbackInPast,
  promiseRequired,
  promiseDateInvalid,
  promiseAmountInvalid,
}

DispositionOption? findDisposition(List<DispositionOption> options, String? code) =>
    code == null ? null : options.firstWhereOrNull((o) => o.code == code);

/// The first reason the form cannot be saved, or null.
///
/// Whitespace is not a note: three spaces satisfying a required note is the
/// exact thing an agent under time pressure types. There is no minimum length
/// beyond that, because a floor produces `asdfasdf`, not better notes.
DispositionBlock? dispositionBlock(List<DispositionOption> options, DispositionForm form, String notes, DateTime now) {
  final option = findDisposition(options, form.code);
  if (option == null) return DispositionBlock.noSelection;
  if (option.requiresNote && notes.trim().isEmpty) return DispositionBlock.noteRequired;
  if (option.requiresCallbackTime) {
    final at = form.callbackAt;
    if (at == null) return DispositionBlock.callbackRequired;
    if (!at.isAfter(now)) return DispositionBlock.callbackInPast;
  }
  // Promise to pay (PT4, PT5): the server judges the customer's today; the
  // app allows a day either side of the agent's own.
  if (option.requiresPromise) {
    final day = form.promiseDate;
    if (day == null) return DispositionBlock.promiseRequired;
    if (!promiseDayAllowed(day, now)) return DispositionBlock.promiseDateInvalid;
    final amount = form.promiseAmount.trim();
    if (amount.isNotEmpty && normalisePromiseAmount(amount) == null) return DispositionBlock.promiseAmountInvalid;
  }
  return null;
}

/// What the save sends: the trimmed note when there is one (an agent who typed
/// something meant it, required or not), the callback only for a code that
/// takes one.
@immutable
class DispositionSubmit {
  const DispositionSubmit({required this.code, this.notes, this.callbackAt, this.promiseDate, this.promiseAmount});
  final String code;
  final String? notes;
  final DateTime? callbackAt;

  /// `YYYY-MM-DD` and the amount's two-place string, for a promise outcome only.
  final String? promiseDate;
  final String? promiseAmount;

  @override
  bool operator ==(Object other) =>
      other is DispositionSubmit &&
      other.code == code &&
      other.notes == notes &&
      other.callbackAt == callbackAt &&
      other.promiseDate == promiseDate &&
      other.promiseAmount == promiseAmount;
  @override
  int get hashCode => Object.hash(code, notes, callbackAt, promiseDate, promiseAmount);
}

DispositionSubmit? buildSubmit(List<DispositionOption> options, DispositionForm form, String notes, DateTime now) {
  if (dispositionBlock(options, form, notes, now) != null) return null;
  final option = findDisposition(options, form.code)!;
  final trimmed = notes.trim();
  return DispositionSubmit(
    code: option.code,
    notes: trimmed.isEmpty ? null : trimmed,
    callbackAt: option.requiresCallbackTime ? form.callbackAt : null,
    promiseDate: option.requiresPromise ? form.promiseDay : null,
    promiseAmount: option.requiresPromise ? normalisePromiseAmount(form.promiseAmount) : null,
  );
}

/// One preset callback time.
@immutable
class CallbackPreset {
  const CallbackPreset(this.choice, this.at);
  final CallbackChoice choice;
  final DateTime at;

  @override
  bool operator ==(Object other) => other is CallbackPreset && other.choice == choice && other.at == at;
  @override
  int get hashCode => Object.hash(choice, at);
}

/// "In 1 hour", "Tomorrow 10 am", "Tomorrow 6 pm", in the device's zone.
///
/// "In 1 hour" is rounded up to the next whole minute so it reads as a time
/// someone can say out loud, and is always at least an hour away.
List<CallbackPreset> callbackPresets(DateTime now) {
  final local = now.toLocal();
  final hourOn = local.add(const Duration(hours: 1));
  final roundedUp = (hourOn.second == 0 && hourOn.millisecond == 0 && hourOn.microsecond == 0)
      ? hourOn
      : DateTime(hourOn.year, hourOn.month, hourOn.day, hourOn.hour, hourOn.minute + 1);
  // DateTime's constructor normalises day 32 into the next month, and building
  // from fields (not adding 24 h) keeps "tomorrow 10 am" right across a DST change.
  final tomorrow10 = DateTime(local.year, local.month, local.day + 1, 10);
  final tomorrow18 = DateTime(local.year, local.month, local.day + 1, 18);
  return [
    CallbackPreset(CallbackChoice.inOneHour, roundedUp),
    CallbackPreset(CallbackChoice.tomorrowMorning, tomorrow10),
    CallbackPreset(CallbackChoice.tomorrowEvening, tomorrow18),
  ];
}

/// Combines the date and time pickers' answers into one local instant.
DateTime combinePicked(DateTime date, int hour, int minute) => DateTime(date.year, date.month, date.day, hour, minute);
