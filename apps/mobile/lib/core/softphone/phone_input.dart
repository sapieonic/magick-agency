export 'call_labels.dart' show formatDialNumber;

/// The soft phone's number field: what a key press, a keystroke and a paste do
/// to it, and when it is worth pressing Call (a port of the console's
/// `utils/softphone/phoneInput.ts`).
///
/// ── The phone does not decide what the number IS ─────────────────────────────
/// `POST /calls` takes the number **as typed** and the server normalises it to
/// E.164 in the account's default region (`+91` by default). So nothing here
/// guesses a country for a bare national number: "98204 61733" goes to the
/// server as `9820461733` and the server, which knows the account's country,
/// reads it. What this file does is the part only the app can: strip what a
/// paste drags in (spaces, dashes, brackets, a `tel:` prefix, the trunk `0`, an
/// international `00`) so the field shows the number the agent meant, and
/// refuse a Call that cannot be a number. Typing gets the two prefix rules too
/// ([normaliseTypedNumber]): the field sits beside the account's country-code
/// chip, so whatever it holds is read after it.
///
/// The display layout ([formatDialNumber]) lives in `call_labels.dart` and is
/// re-exported here, so the pad and the lists space a number alike.

/// The pad's keys, in the order a phone draws them.
const dialKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

/// The letters under each key, as a phone prints them. `0` carries the `+`
/// (a long press).
const Map<String, String> dialKeyLetters = {
  '1': '',
  '2': 'ABC',
  '3': 'DEF',
  '4': 'GHI',
  '5': 'JKL',
  '6': 'MNO',
  '7': 'PQRS',
  '8': 'TUV',
  '9': 'WXYZ',
  '*': '',
  '0': '+',
  '#': '',
};

/// E.164 allows 15 digits; a few more leave room for a `+` and a stray key
/// without truncating silently.
const maxDialLength = 20;

/// The shortest number worth sending: below this it is a keypress, not a phone number.
const minDialDigits = 6;

/// E.164's ceiling.
const maxDialDigits = 15;

final _dialChar = RegExp(r'^[0-9*#+]$');
final _keepChar = RegExp(r'[0-9*#]');

/// Whether one typed character belongs in the field at all.
bool isDialChar(String ch) => _dialChar.hasMatch(ch);

/// Keeps what a number can hold: digits, `*`, `#`, and a `+` only in first
/// place. Used for every keystroke into the field, so a letter typed by
/// accident never lands in it.
String sanitiseDialInput(String raw) {
  final out = StringBuffer();
  for (final rune in raw.runes) {
    final ch = String.fromCharCode(rune);
    if (ch == '+') {
      if (out.isEmpty) out.write('+');
      continue;
    }
    if (_keepChar.hasMatch(ch)) out.write(ch);
  }
  final s = out.toString();
  return s.length > maxDialLength ? s.substring(0, maxDialLength) : s;
}

final _typedTrunk = RegExp(r'^0[1-9]');

/// What a typed number means, beside the country-code chip.
///
/// A number without a `+` is shown after the chip ("+91"), so a typed trunk
/// `0` would read "+91 098204 61733", a number nobody has. The server strips
/// the trunk `0` from a national number anyway, so dropping it here changes
/// nothing that is dialled and makes the field read as the call will. A typed
/// `00` is the international prefix, as on paste: it becomes the `+`.
///
/// A lone `0` is kept: until the next key it could be either.
String normaliseTypedNumber(String value) {
  if (value.startsWith('00')) return sanitiseDialInput('+${value.substring(2)}');
  if (_typedTrunk.hasMatch(value)) return value.substring(1);
  return value;
}

/// One pad key (or typed character) onto the end of the number.
String appendDialKey(String value, String key) {
  if (key == '+') return value.isEmpty ? '+' : value;
  if (!isDialChar(key)) return value;
  return normaliseTypedNumber(sanitiseDialInput(value + key));
}

/// Backspace: the last character, whatever it was.
String deleteLastDialChar(String value) => value.isEmpty ? value : value.substring(0, value.length - 1);

final _scheme = RegExp(r'^tel:', caseSensitive: false);

// `+44 (0)20…`, `(+91) (0) 98204…`, `0044 (0)20…`: the "(0)" is dropped while
// it is still bracketed; once the brackets go it is indistinguishable from a digit.
final _bracketedTrunk = RegExp(r'^(\(?\s*(?:\+|00)\s*\d{1,3}\s*\)?)[\s.-]*\(\s*0\s*\)');
final _notDigitOrPlus = RegExp(r'[^\d+]');
final _notDigit = RegExp(r'[^\d]');
final _leadingZeros = RegExp(r'^0+');

/// A pasted number, cleaned the way the agent meant it.
///
///  - `+91 98204 61733`, `+91-98204-61733`, `(+91) 98204 61733` → `+919820461733`
///  - `0091 98204 61733` → `+919820461733` (the international `00`)
///  - `+44 (0)20 7946 0018` → `+442079460018`: the bracketed trunk `0` written
///    after a country code is for dialling inside the country, never after it
///  - `098204 61733`, `022 2659 4410` → `+919820461733`, `+912226594410`: a
///    leading trunk `0` is the national format, so the account's country code
///    replaces it
///  - `tel:+919820461733` → `+919820461733`
///  - `98204 61733` → `9820461733`: a bare national number is left for the
///    server, which normalises it in the account's region
///
/// [defaultCountryCode] is the bootstrap's `default_country_code` (`+91` unless
/// the account says otherwise), accepted with or without its `+`.
String normalisePastedNumber(String raw, String defaultCountryCode) {
  final withoutScheme =
      raw.trim().replaceFirst(_scheme, '').replaceFirstMapped(_bracketedTrunk, (m) => '${m[1]} ');
  // Digits and a plus; everything else a paste drags in is formatting.
  var compact = withoutScheme.replaceAll(_notDigitOrPlus, '');
  final leadingPlus = compact.startsWith('+');
  compact = compact.replaceAll('+', '');
  if (leadingPlus) return sanitiseDialInput('+$compact');
  if (compact.startsWith('00')) return sanitiseDialInput('+${compact.substring(2)}');
  if (compact.startsWith('0')) {
    final cc = defaultCountryCode.replaceAll(_notDigit, '');
    final national = compact.replaceFirst(_leadingZeros, '');
    return sanitiseDialInput(cc.isNotEmpty ? '+$cc$national' : national);
  }
  return sanitiseDialInput(compact);
}

/// How many digits the field holds (the `+`, `*` and `#` are not digits).
int dialDigitCount(String value) => value.replaceAll(_notDigit, '').length;

/// Why Call is refused for a value before it is sent.
enum DialBlockReason { empty, tooShort, tooLong, notANumber }

final _tones = RegExp(r'[*#]');

/// Why Call is refused for [value], or null when it may be sent.
DialBlockReason? dialBlockReason(String value) {
  if (value.isEmpty) return DialBlockReason.empty;
  // `*` and `#` are tones, not part of a phone number; they belong to a keypad
  // during a call, which the soft phone does not have.
  if (_tones.hasMatch(value)) return DialBlockReason.notANumber;
  final digits = dialDigitCount(value);
  if (digits < minDialDigits) return DialBlockReason.tooShort;
  if (digits > maxDialDigits) return DialBlockReason.tooLong;
  return null;
}

/// The console's `DIAL_BLOCK_COPY`, with "paste" kept (a long press pastes on a phone too).
const Map<DialBlockReason, String> dialBlockCopy = {
  DialBlockReason.empty: 'Type or paste a number to call.',
  DialBlockReason.tooShort: 'That number is too short to call.',
  DialBlockReason.tooLong: 'That number is too long — a phone number has at most 15 digits.',
  DialBlockReason.notANumber: '* and # are tones, not part of a number. Remove them to call.',
};
