/// A phone fact as the station shows it (AS19's one phone rule, the console's too): on the card's
/// tile, its press-and-hold sheet, what a screen reader says, the script and Details. Display only.
///
/// Core-level so the station's view mapper (which hides a phone column in Details) and the
/// station's screens (`features/station/logic/format.dart` re-exports these) read one rule.
library;

final _nonDigits = RegExp(r'\D');
final _indianMobile = RegExp(r'^[6-9]\d{9}$');

/// [digits]' national form when it is an Indian mobile: 12 digits starting `91` drop the `91`,
/// 11 starting `0` drop the `0`, 10 stay as they are; then 10 digits starting 6 to 9. Else null.
String? _mobile(String digits) {
  final national = digits.length == 12 && digits.startsWith('91')
      ? digits.substring(2)
      : digits.length == 11 && digits.startsWith('0')
          ? digits.substring(1)
          : digits;
  return _indianMobile.hasMatch(national) ? national : null;
}

/// A phone fact in full: an Indian mobile as `+91 98765 43210` however it was written
/// (`9876543210`, `919876543210`, `+919876543210`, `09876543210`); any other number as read, its
/// `+` kept, with no spacing added (`+14155550123`).
String formatFactPhone(String value) {
  final shown = value.trim();
  final mobile = _mobile(shown.replaceAll(_nonDigits, ''));
  return mobile == null ? shown : '+91 ${mobile.substring(0, 5)} ${mobile.substring(5)}';
}

/// A phone fact hidden as the customer's own number is (AS9): the first two and the last three
/// digits of an Indian mobile's national number (`98••• ••210`), else of all its digits
/// (`14••• ••123`). [value] may be written any way (a value the server could not read is hidden the
/// same way, on its digits); one with fewer than six digits shows no digit at all (`•••`).
String maskFactPhone(String value) {
  final digits = value.replaceAll(_nonDigits, '');
  final shown = _mobile(digits) ?? digits;
  if (shown.length < 6) return '•••';
  return '${shown.substring(0, 2)}••• ••${shown.substring(shown.length - 3)}';
}
