import 'package:agency_wire/agency_wire.dart';

import '../../features/performance/logic/en_in_format.dart';
import '../../features/performance/logic/stats_windows.dart' show DeviceCalendar, LocalCalendar;
import '../station/server_clock.dart' show correctedInstant;
import 'call_labels.dart' show formatDialNumber;
import 'softphone_view.dart';

/// The two refusals an agent may dial through with a note (SP1 DNC, SP2
/// calling hours), and what the override prompt says about each (a port of
/// the console's `utils/softphone/overrides.ts`).
///
/// The prompt's job is to say **exactly what matched** before the agent
/// decides (which DNC entry, how far it reaches, why and since when; which
/// window, in whose timezone, and when it next opens) and that the call will be
/// logged with their name and their reason. A prompt that says only "this
/// number is blocked, call anyway?" trains a reflex tap; one that names the
/// entry gives the agent something to weigh.
///
/// ── Time zones on the phone ─────────────────────────────────────────────────
/// The app has no IANA time-zone database, so the window is shown as the
/// server states it (its hours, its days, its zone's name), and the next
/// opening as how long until it plus this phone's own clock time, rather than
/// the window's wall clock the console prints.

/// Why an override note cannot be sent yet.
enum OverrideNoteBlock { tooShort, tooLong }

/// A note's length as the server and the database count it: characters (code
/// points) after trimming, so an emoji is one, not the two UTF-16 units
/// `String.length` reports.
int overrideNoteLength(String note) => SoftphoneOverridePrompt.noteLength(note);

/// The note's length is checked after trimming, as the server does (`override_note_invalid`).
OverrideNoteBlock? overrideNoteBlock(String note) {
  final length = overrideNoteLength(note);
  if (length < softphoneOverrideNoteMin) return OverrideNoteBlock.tooShort;
  if (length > softphoneOverrideNoteMax) return OverrideNoteBlock.tooLong;
  return null;
}

const Map<OverrideNoteBlock, String> overrideNoteBlockCopy = {
  OverrideNoteBlock.tooShort: 'Write at least $softphoneOverrideNoteMin characters — say why this call has to go ahead.',
  OverrideNoteBlock.tooLong: 'Keep the note to $softphoneOverrideNoteMax characters.',
};

/// The overrides to redial with: what was already given, plus this note under
/// its kind's key. A second refusal of the other kind therefore keeps the first note.
ManualCallOverridesRequest withOverride(ManualCallOverridesRequest current, SoftphoneOverrideKind kind, String note) =>
    switch (kind) {
      SoftphoneOverrideKind.dnc => current.withDncNote(note.trim()),
      SoftphoneOverrideKind.hours => current.withHoursNote(note.trim()),
    };

// ─── Days and times, as the campaign screens print them ─────────────────────

const _isoWeekdayShort = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const _monthShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// ISO days (1 = Monday … 7 = Sunday) as the shortest honest phrase: "Every
/// day", "Mon–Fri", "Mon, Wed, Fri". Duplicates collapse, out-of-range values
/// are dropped rather than printed, and nothing valid left is null. Three or
/// more contiguous days read as a range; two adjacent days stay a list.
String? describeIsoDays(List<int>? days) {
  if (days == null || days.isEmpty) return null;
  final valid = days.where((d) => d >= 1 && d <= 7).toSet().toList()..sort();
  if (valid.isEmpty) return null;
  if (valid.length == 7) return 'Every day';
  var contiguous = true;
  for (var i = 1; i < valid.length; i++) {
    if (valid[i] != valid[i - 1] + 1) contiguous = false;
  }
  if (contiguous && valid.length >= 3) {
    return '${_isoWeekdayShort[valid.first - 1]}–${_isoWeekdayShort[valid.last - 1]}';
  }
  return valid.map((d) => _isoWeekdayShort[d - 1]).join(', ');
}

final _hhmm = RegExp(r'^\d{2}:\d{2}');

/// `09:00:00` → `09:00`; anything not shaped like a time is returned as sent.
String hhmm(String value) => _hhmm.hasMatch(value) ? value.substring(0, 5) : value;

// ─── DNC (SP1) ──────────────────────────────────────────────────────────────

/// How far a DNC entry reaches, in words. [campaignName] is the campaign the
/// entry is for when the caller knows it (a call logged to that campaign); a
/// campaign entry an UNTAGGED call met is one of the account's campaigns,
/// which is all this copy claims.
String dncEntryReach(DncEntryScope scope, String? campaignName) => switch (scope) {
  DncEntryScope.tenant => 'Every campaign and account in this workspace',
  DncEntryScope.account => 'This account',
  DncEntryScope.campaign || DncEntryScope.unknown =>
    campaignName != null ? 'The campaign $campaignName' : 'One of this account’s campaigns',
};

/// An entry's reason and the date it was added, as the prompt and the call detail show them.
List<SoftphoneFact> dncEntryFacts(DncEntry entry, {LocalCalendar calendar = const DeviceCalendar()}) {
  final reason = entry.reason?.trim() ?? '';
  return [
    SoftphoneFact(label: 'Reason', value: reason.isNotEmpty ? reason : 'No reason was recorded'),
    SoftphoneFact(label: 'Added', value: EnIn.dayMonthYear(calendar.wall(entry.createdAt))),
  ];
}

/// The prompt for `dnc_listed`. [number] is as dialled: a number typed without
/// a country code is read in the account's, so the caller says it with it.
SoftphoneOverridePrompt describeDncRefusal(
  SoftphoneDncListedRefusal refusal, {
  required String number,
  String? campaignName,
  LocalCalendar calendar = const DeviceCalendar(),
}) {
  final shown = formatDialNumber(number);
  return SoftphoneOverridePrompt(
    kind: SoftphoneOverrideKind.dnc,
    title: 'This number is on the Do Not Call list',
    facts: [
      SoftphoneFact(label: 'Number', value: shown.isNotEmpty ? shown : number),
      SoftphoneFact(label: 'Listed for', value: dncEntryReach(refusal.entry.scope, campaignName)),
      ...dncEntryFacts(refusal.entry, calendar: calendar),
    ],
    consequence:
        'If you call anyway, the call is logged with your name, this entry and your note, and your supervisor can see it. The number stays on the list.',
    noteLabel: 'Why does this call have to go ahead?',
    confirmLabel: 'Call anyway',
  );
}

// ─── Calling hours (SP2) ────────────────────────────────────────────────────

/// How long until [at] from [now], in words: "in 25 min", "in 3 h 20 min",
/// "in 1 day 6 h".
String timeUntil(DateTime at, DateTime now) {
  final d = at.difference(now);
  if (d.inSeconds <= 0) return 'any moment now';
  if (d.inMinutes < 1) return 'in under a minute';
  if (d.inMinutes < 60) return 'in ${d.inMinutes} min';
  if (d.inHours < 24) {
    final m = d.inMinutes % 60;
    return m == 0 ? 'in ${d.inHours} h' : 'in ${d.inHours} h $m min';
  }
  final h = d.inHours % 24;
  final days = d.inDays == 1 ? '1 day' : '${d.inDays} days';
  return h == 0 ? 'in $days' : 'in $days $h h';
}

/// When the window next opens: how long from [now], then the moment on this
/// phone's clock ("In 11 h 30 min — Mon 2 Nov, 09:00 your time"). Null when it
/// never opens.
String? formatNextOpening(DateTime? nextOpenAt, {required DateTime now, LocalCalendar calendar = const DeviceCalendar()}) {
  if (nextOpenAt == null) return null;
  final w = calendar.wall(nextOpenAt);
  String two(int v) => v.toString().padLeft(2, '0');
  final clock = '${_isoWeekdayShort[w.weekday - 1]} ${w.day} ${_monthShort[w.month - 1]}, ${two(w.hour)}:${two(w.minute)}';
  final until = timeUntil(nextOpenAt, now);
  return '${until[0].toUpperCase()}${until.substring(1)} — $clock your time';
}

/// The prompt for `outside_calling_hours`. [now] is this phone's clock;
/// [offsetMs] (the session's server-clock offset) puts the server's
/// `next_open_at` on it, so "Opens again — in N min" counts down truly on a
/// phone whose clock is off.
SoftphoneOverridePrompt describeHoursRefusal(
  SoftphoneOutsideHoursRefusal refusal, {
  String? campaignName,
  required DateTime now,
  int offsetMs = 0,
  LocalCalendar calendar = const DeviceCalendar(),
}) {
  final window = refusal.window;
  final days = describeIsoDays(window.days);
  final campaign = campaignName ?? 'This campaign';
  return SoftphoneOverridePrompt(
    kind: SoftphoneOverrideKind.hours,
    title: '$campaign is outside its calling hours',
    facts: [
      SoftphoneFact(
        label: 'Calling hours',
        value: '${hhmm(window.start)}–${hhmm(window.end)}${days != null ? ', $days' : ''}',
      ),
      SoftphoneFact(
        label: 'Timezone',
        value: refusal.timezoneSource == HoursTimezoneSource.contact
            ? '${window.timezone} — the customer’s, from the roster'
            : '${window.timezone} — the campaign’s default; this number isn’t on the roster',
      ),
      SoftphoneFact(
        label: 'Opens again',
        value:
            formatNextOpening(correctedInstant(refusal.nextOpenAt, offsetMs), now: now, calendar: calendar) ??
            'Never — the campaign has no calling days set',
      ),
    ],
    consequence: 'If you call anyway, the call is logged with your name and your note, and your supervisor can see it.',
    noteLabel: 'Why does this call have to go ahead now?',
    confirmLabel: 'Call anyway',
  );
}
