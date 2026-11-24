import 'package:agency_wire/agency_wire.dart' show ScriptPlaceholder, WireEnumUnknown;
import 'package:collection/collection.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The station as the screens see it: the seam between the station core
/// (socket, reducer, audio, lifecycle) and the station UI.
///
/// The core turns wire frames into a [StationView]; the UI renders it and
/// calls [StationActions]. Nothing here depends on `agency_wire`, so the UI is
/// built and tested against plain values. Every type is immutable with value
/// equality, so `ref.watch(stationViewProvider.select(...))` rebuilds a widget
/// only when its slice actually changed.
///
/// Times are already on the SERVER clock mapped to this device (the core
/// applies the pong offset), so the UI can compare them to `DateTime.now()`.

/// The socket, from the agent's side.
enum StationLink {
  /// Joining the campaign / opening the socket for the first time.
  connecting,
  open,

  /// Lost and retrying. Mid-call the server holds the call for [StationView.reconnectDeadline].
  reconnecting,

  /// Gave up retrying; the agent can press Reconnect.
  disconnected,

  /// 4409: another device or window took this station.
  superseded,

  /// 4404 or the session was left: rejoin the campaign.
  sessionGone,
}

/// The agent's state, as the server's `agent_state` frames state it.
enum AgentPhase { offline, available, reserved, onCall, wrapup, onBreak }

enum ReleaseTone { neutral, warning, danger }

/// The picture a supervisor chose for an outcome or break tile (BE-13; the contract's
/// `AGENCY_TILE_ICONS`, same names). Null on a tile means none was chosen, or a newer one this build
/// does not know: the station then works one out from the outcome's flags or the break's name.
enum TilePicture {
  rupee,
  clock,
  calendar,
  stop,
  thumbsUp,
  thumbsDown,
  check,
  cross,
  phoneMissed,
  phoneBusy,
  voicemail,
  wrongNumber,
  language,
  question,
  tea,
  lunch,
  washroom,
  meeting,
  training,
  prayer,
  headset,
  walk,
  person,
  dot,
}

@immutable
class BreakOption {
  const BreakOption({required this.code, required this.label, this.limitMinutes, this.icon});
  final String code;
  final String label;

  /// The reason's limit in minutes ("Tea 15 min" on Which break?); null for a reason with none.
  final int? limitMinutes;

  /// The supervisor's picture for it (BE-13), or null.
  final TilePicture? icon;

  @override
  bool operator ==(Object other) =>
      other is BreakOption && other.code == code && other.label == label && other.limitMinutes == limitMinutes && other.icon == icon;
  @override
  int get hashCode => Object.hash(code, label, limitMinutes, icon);
}

/// The break the agent is on, or has queued for after this call.
@immutable
class BreakInfo {
  const BreakInfo({required this.code, required this.label, this.since, this.rang = false, this.noRing, this.limitMinutes});

  final String code;
  final String label;

  /// When the break started (null for a queued break).
  final DateTime? since;

  /// How long this break may last, in minutes (the campaign's reason, Live floor LF6, LF20): the
  /// station counts down from [since]. Null for a reason with none, and always for a reserved one.
  final int? limitMinutes;

  /// The reserved `device_away` break: the app paused the agent because it
  /// left the foreground. The UI shows "Paused · you left the app", not a break.
  /// Mode B's `away_ring` is the same pause, with this phone rung for inbound callers.
  bool get isDeviceAway => code == 'device_away' || isAwayRing;

  /// Back from the app's own `away_ring`, which the server ends as `device_away` on the return:
  /// this phone was ringing for inbound calls while the agent was away.
  final bool rang;

  /// On `device_away` though the agent turned ringing on for this phone: why it won't ring (the
  /// end of a sentence, "notifications are off"). Null otherwise.
  final String? noRing;

  /// Mode B's `away_ring`: paused because they left the app, and this phone rings for inbound
  /// callers meanwhile (or did, until they came back: [rang]).
  bool get isAwayRing => code == 'away_ring' || rang;

  @override
  bool operator ==(Object other) =>
      other is BreakInfo &&
      other.code == code &&
      other.label == label &&
      other.since == since &&
      other.rang == rang &&
      other.noRing == noRing &&
      other.limitMinutes == limitMinutes;
  @override
  int get hashCode => Object.hash(code, label, since, rang, noRing, limitMinutes);
}

/// One contact field for the screen pop.
@immutable
class ContactField {
  const ContactField({required this.key, required this.label, required this.value});
  final String key;
  final String label;

  /// Display text; empty when the roster had no value.
  final String value;

  @override
  bool operator ==(Object other) => other is ContactField && other.key == key && other.label == label && other.value == value;
  @override
  int get hashCode => Object.hash(key, label, value);
}

@immutable
class PriorAttempt {
  const PriorAttempt({
    required this.at,
    required this.outcomeLabel,
    this.notes,
    this.sameCampaign = true,
    this.campaignName,
    this.promise,
  });
  final DateTime at;
  final String outcomeLabel;
  final String? notes;
  final bool sameCampaign;
  final String? campaignName;

  /// The promise to pay that call recorded (PT9), written out:
  /// "Promised 18 Nov 2026 · 12,500"; null without one.
  final String? promise;

  @override
  bool operator ==(Object other) =>
      other is PriorAttempt &&
      other.at == at &&
      other.outcomeLabel == outcomeLabel &&
      other.notes == notes &&
      other.sameCampaign == sameCampaign &&
      other.campaignName == campaignName &&
      other.promise == promise;
  @override
  int get hashCode => Object.hash(at, outcomeLabel, notes, sameCampaign, campaignName, promise);
}

/// Where a promise stands (PT7). `missed` is "no outcome since the promised
/// day", never "unpaid": nothing knows whether anyone paid.
enum PromiseStanding { upcoming, dueToday, missed, followedUp, unknown }

/// A contact's latest promise to pay (PT9), as the station shows it when the
/// agent reaches them: "Promised 18 Nov 2026 · 12,500" and where it stands.
@immutable
class PromiseView {
  const PromiseView({required this.text, required this.state});

  final String text;
  final PromiseStanding state;

  @override
  bool operator ==(Object other) => other is PromiseView && other.text == text && other.state == state;
  @override
  int get hashCode => Object.hash(text, state);
}

/// The call on screen: from `reserved` until the agent leaves wrap-up.
@immutable
class CallView {
  const CallView({
    required this.attemptId,
    required this.phoneE164,
    required this.attemptNumber,
    required this.callerId,
    required this.campaignName,
    required this.heroFields,
    required this.heroesConfigured,
    required this.otherFields,
    required this.priorAttempts,
    this.displayName,
    this.countdownSeconds,
    this.bridgedAt,
    this.recording = false,
    this.redialNumber,
    this.redialLimit,
    this.promise,
    this.callback,
    this.facts,
    this.placeColumn,
  });

  final String attemptId;
  final String phoneE164;
  final int attemptNumber;
  final String callerId;
  final String campaignName;

  /// Best guess at the person's name for the headline (a hero field that
  /// looks like a name), else null and the UI leads with the number.
  final String? displayName;

  /// Up to four pinned fields (`context_display.hero`, else a heuristic).
  final List<ContactField> heroFields;

  /// False when the heroes were guessed: the UI says "auto-selected".
  final bool heroesConfigured;

  /// The rest, in `order` then roster order, minus hidden ones.
  final List<ContactField> otherFields;
  final List<PriorAttempt> priorAttempts;

  /// The 3-2-1 before the dial connects (early binding only), else null.
  final int? countdownSeconds;

  /// Set once the customer is on the line; the talk timer counts from it.
  final DateTime? bridgedAt;
  final bool recording;

  /// Set when this call is a wrap-up redial: which one ([redialNumber], 1 or
  /// 2) out of how many the call allows ([redialLimit]): "Redial 1 of 2".
  final int? redialNumber;
  final int? redialLimit;

  /// The contact's latest promise to pay (PT9); null without one.
  final PromiseView? promise;

  /// This call is a booked call-later coming due (BE-4, `attempt.callback`); null otherwise, or
  /// from a server that does not send it.
  final CallLaterTag? callback;

  /// The customer's facts as the server read them (BE-6, `attempt.facts`); null from a server that
  /// does not send them: the card then reads the hero fields.
  final FactsView? facts;

  /// The roster column the line under the name is read from (`wire.customerPlaceColumn` of the
  /// attempt's row and the campaign's display, the server's own reading); null when none. Details
  /// lists that column first by its name, as More details leaves it out (AS20).
  final String? placeColumn;

  bool get isBridged => bridgedAt != null;
  bool get isRedial => redialNumber != null;

  /// The campaign chose the card's facts (AS19, [FactsView.chosen]).
  bool get factsChosen => facts?.chosen ?? false;

  /// The customer's name as the station says it, trimmed; null when there is none. With chosen
  /// facts (AS19) the server's `facts.name` only (it already guessed); else the facts' name, then
  /// the guess from the hero fields ([displayName]), as before.
  String? get customerName {
    final name = (factsChosen ? facts!.name : facts?.name ?? displayName)?.trim();
    return name == null || name.isEmpty ? null : name;
  }

  static const _eq = ListEquality<Object>();

  @override
  bool operator ==(Object other) =>
      other is CallView &&
      other.attemptId == attemptId &&
      other.phoneE164 == phoneE164 &&
      other.attemptNumber == attemptNumber &&
      other.callerId == callerId &&
      other.campaignName == campaignName &&
      other.displayName == displayName &&
      other.heroesConfigured == heroesConfigured &&
      _eq.equals(other.heroFields, heroFields) &&
      _eq.equals(other.otherFields, otherFields) &&
      _eq.equals(other.priorAttempts, priorAttempts) &&
      other.countdownSeconds == countdownSeconds &&
      other.bridgedAt == bridgedAt &&
      other.recording == recording &&
      other.redialNumber == redialNumber &&
      other.redialLimit == redialLimit &&
      other.promise == promise &&
      other.callback == callback &&
      other.facts == facts &&
      other.placeColumn == placeColumn;

  @override
  int get hashCode =>
      Object.hash(attemptId, countdownSeconds, bridgedAt, recording, heroFields.length, otherFields.length, redialNumber, callback, facts);
}

/// "Call later · You said you will call at 3:00 PM": the booked time (this device's clock) and
/// whether this agent booked it (only then "You said…").
@immutable
class CallLaterTag {
  const CallLaterTag({required this.dueAt, required this.bookedByMe});

  final DateTime dueAt;
  final bool bookedByMe;

  @override
  bool operator ==(Object other) => other is CallLaterTag && other.dueAt == dueAt && other.bookedByMe == bookedByMe;
  @override
  int get hashCode => Object.hash(dueAt, bookedByMe);
}

/// How a fact's value reads (the campaign's column type, BE-6; number, phone and yes / no are
/// AS19's). A type this build does not know reads as [text].
enum FactKind { text, money, date, number, phone, yesNo }

/// One fact tile: its name, the value as uploaded, and, for a typed column the server could read,
/// the parsed value (money and number a decimal string, a date `YYYY-MM-DD`, a phone its digits,
/// yes / no `yes` or `no`).
///
/// With the campaign's chosen facts (AS19, [FactsView.chosen]) the name is the supervisor's
/// ([label]), the tile carries its script [key], and one may be the [highlight]; without them
/// (BE-6) [label] is the column's header and [column] the same.
@immutable
class FactTileView {
  const FactTileView({
    required this.label,
    required this.raw,
    required this.kind,
    this.parsed,
    this.amountDue = false,
    this.dueDate = false,
    String? column,
    this.key,
    this.highlight = false,
  }) : column = column ?? label;

  /// The tile's name: the fact's label, else its column (the wire's `label ?? column`).
  final String label;

  /// The roster column the value comes from, as in its header.
  final String column;
  final String raw;
  final FactKind kind;
  final String? parsed;

  /// The tile plays the amount-due role (the script's `{amount_due}`).
  final bool amountDue;

  /// The tile plays the due-date role (`{due_date}`).
  final bool dueDate;

  /// AS19: the fact's script key (`{key}`); null on the BE-6 path.
  final String? key;

  /// AS19: the campaign's highlighted fact: first, the full row, in the call colour.
  final bool highlight;

  @override
  bool operator ==(Object other) =>
      other is FactTileView &&
      other.label == label &&
      other.column == column &&
      other.raw == raw &&
      other.kind == kind &&
      other.parsed == parsed &&
      other.amountDue == amountDue &&
      other.dueDate == dueDate &&
      other.key == key &&
      other.highlight == highlight;
  @override
  int get hashCode => Object.hash(label, column, raw, kind, parsed, amountDue, dueDate, key, highlight);
}

/// The customer's name, place and fact tiles, as the server read them (BE-6).
@immutable
class FactsView {
  const FactsView({this.name, this.place, this.tiles = const [], this.chosen = false, this.more});

  final String? name;
  final String? place;

  /// In hero order, at most four (with chosen facts, AS19: the list's order, the highlight first).
  final List<FactTileView> tiles;

  /// AS19: the campaign chose the card's facts (the bootstrap's `context_display.facts` is a list,
  /// even an empty one): the card draws exactly [tiles] in its 2 × 2 grid (none for an empty
  /// list), its heading is [name] or "Customer", and the script says "`<name> not given`" for a
  /// missing value. False: the BE-6 card and script, as before.
  final bool chosen;

  /// AS20, More details: the row's other columns, in the server's order, each named by its column;
  /// the columns the supervisor turned off are already left out. Null from an older server (Details
  /// then lists the roster row as before); empty when there is nothing more.
  final List<FactTileView>? more;

  static const _eq = ListEquality<FactTileView>();

  @override
  bool operator ==(Object other) =>
      other is FactsView &&
      other.name == name &&
      other.place == place &&
      other.chosen == chosen &&
      _eq.equals(other.tiles, tiles) &&
      _eq.equals(other.more, more);
  @override
  int get hashCode => Object.hash(name, place, tiles.length, chosen, more?.length);
}

/// The `{placeholders}` a campaign without chosen facts may use: every known
/// `ScriptPlaceholder` (the contract's `AGENCY_SCRIPT_PLACEHOLDERS`), in its order.
final List<String> legacyScriptPlaceholders = List.unmodifiable([
  for (final p in ScriptPlaceholder.values)
    if (!p.isUnknown) p.wire,
]);

/// The campaign's script (BE-8): the opening line ("First, say this") and the numbered steps
/// ("What to say"), placeholders still in braces; the screen fills them for the call on screen.
@immutable
class ScriptView {
  const ScriptView({this.opening, this.steps = const [], this._placeholders, this.factLabels = const {}});

  final String? opening;
  final List<String> steps;

  final List<String>? _placeholders;

  /// The `{key}`s this campaign's script may use (AS19: the fixed four and the chosen facts' keys;
  /// else [legacyScriptPlaceholders]). Any other `{word}` is shown as written.
  List<String> get placeholders => _placeholders ?? legacyScriptPlaceholders;

  /// AS19: each chosen fact's name by its key, for "`<name> not given`" when the customer has no
  /// tile for it.
  final Map<String, String> factLabels;

  static const _eq = ListEquality<String>();
  static const _eqMap = MapEquality<String, String>();

  @override
  bool operator ==(Object other) =>
      other is ScriptView &&
      other.opening == opening &&
      _eq.equals(other.steps, steps) &&
      _eq.equals(other.placeholders, placeholders) &&
      _eqMap.equals(other.factLabels, factLabels);
  @override
  int get hashCode => Object.hash(opening, steps.length, placeholders.length);
}

/// Why the last call ended, in the station's words (as the console's `stationCopy.ts`).
@immutable
class ReleaseView {
  const ReleaseView({required this.headline, required this.detail, required this.tone, required this.requiresDisposition});
  final String headline;
  final String detail;
  final ReleaseTone tone;
  final bool requiresDisposition;

  @override
  bool operator ==(Object other) =>
      other is ReleaseView && other.headline == headline && other.detail == detail && other.tone == tone && other.requiresDisposition == requiresDisposition;
  @override
  int get hashCode => Object.hash(headline, detail, tone, requiresDisposition);
}

enum WrapupHold { none, dispositionRequired, supervisor }

@immutable
class WrapupView {
  const WrapupView({
    required this.endsAt,
    required this.secondsTotal,
    required this.hold,
    required this.dispositionSubmitted,
    required this.autoReturn,
    this.redialRemaining,
  });

  /// When wrap-up ends on its own; null when it has no timer (held).
  final DateTime? endsAt;
  final int secondsTotal;
  final WrapupHold hold;
  final bool dispositionSubmitted;
  final bool autoReturn;

  /// Wrap-up redial: null when it is not offered (no Redial button); 0 when
  /// the call's redials are used up (shown, disabled); more: that many left.
  final int? redialRemaining;

  /// The Redial button belongs beside the outcome pad.
  bool get offersRedial => redialRemaining != null;

  @override
  bool operator ==(Object other) =>
      other is WrapupView &&
      other.endsAt == endsAt &&
      other.secondsTotal == secondsTotal &&
      other.hold == hold &&
      other.dispositionSubmitted == dispositionSubmitted &&
      other.autoReturn == autoReturn &&
      other.redialRemaining == redialRemaining;
  @override
  int get hashCode => Object.hash(endsAt, secondsTotal, hold, dispositionSubmitted, autoReturn, redialRemaining);
}

/// One outcome on the disposition grid.
@immutable
class DispositionOption {
  const DispositionOption({
    required this.code,
    required this.label,
    this.requiresNote = false,
    this.requiresCallbackTime = false,
    this.isSuccess = false,
    this.suppresses = false,
    this.requiresPromise = false,
    this.promiseFollowUpDays,
    this.icon,
  });

  final String code;
  final String label;

  /// The supervisor's picture for it (BE-13), or null.
  final TilePicture? icon;
  final bool requiresNote;
  final bool requiresCallbackTime;
  final bool isSuccess;

  /// Saving it adds the number to Do Not Call.
  final bool suppresses;

  /// Promise to pay (PT1): the agent enters the promised date (and maybe an
  /// amount). [promiseFollowUpDays] is set when saving books a call that many
  /// days after the date (PT2); otherwise saving books none (PT3).
  final bool requiresPromise;
  final int? promiseFollowUpDays;

  @override
  bool operator ==(Object other) =>
      other is DispositionOption &&
      other.code == code &&
      other.label == label &&
      other.requiresNote == requiresNote &&
      other.requiresCallbackTime == requiresCallbackTime &&
      other.isSuccess == isSuccess &&
      other.suppresses == suppresses &&
      other.requiresPromise == requiresPromise &&
      other.promiseFollowUpDays == promiseFollowUpDays &&
      other.icon == icon;
  @override
  int get hashCode => Object.hash(
    code, label, requiresNote, requiresCallbackTime, isSuccess, suppresses, requiresPromise, promiseFollowUpDays, icon,
  );
}

enum NotesStatus { idle, saving, saved, retrying, failed, closed }

@immutable
class NotesView {
  const NotesView({this.text = '', this.status = NotesStatus.idle, this.changedElsewhere = false, this.savedAt});
  final String text;
  final NotesStatus status;

  /// When the server last accepted the notes, on this device's clock ("Saved 14:32").
  final DateTime? savedAt;

  /// A supervisor edited the notes on the server since the agent typed.
  final bool changedElsewhere;

  @override
  bool operator ==(Object other) => other is NotesView && other.text == text && other.status == status && other.changedElsewhere == changedElsewhere && other.savedAt == savedAt;
  @override
  int get hashCode => Object.hash(text, status, changedElsewhere, savedAt);
}

enum AudioRouteKind { earpiece, speaker, wired, bluetooth }

@immutable
class AudioRouteOption {
  const AudioRouteOption({required this.id, required this.kind, required this.name});
  final String id;
  final AudioRouteKind kind;

  /// "Phone", "Speaker", or the headset's name ("boAt Airdopes 141").
  final String name;

  @override
  bool operator ==(Object other) => other is AudioRouteOption && other.id == id && other.kind == kind && other.name == name;
  @override
  int get hashCode => Object.hash(id, kind, name);
}

/// [serviceStopped]: Android would not start the on-duty foreground service (the app
/// was in the background at join, or a permission is missing). The microphone works
/// while the app is on screen, but the phone may cut it the moment the agent leaves.
enum MicProblem { none, permissionDenied, noDevice, busy, lost, serviceStopped }

/// Why the phone took the audio away mid-call.
enum AudioInterruption { none, phoneCall, otherApp }

@immutable
class AudioView {
  const AudioView({
    this.muted = false,
    this.route,
    this.routes = const [],
    this.micProblem = MicProblem.none,
    this.interruption = AudioInterruption.none,
  });

  final bool muted;
  final AudioRouteOption? route;
  final List<AudioRouteOption> routes;
  final MicProblem micProblem;
  final AudioInterruption interruption;

  static const _eq = ListEquality<AudioRouteOption>();

  @override
  bool operator ==(Object other) =>
      other is AudioView &&
      other.muted == muted &&
      other.route == route &&
      _eq.equals(other.routes, routes) &&
      other.micProblem == micProblem &&
      other.interruption == interruption;
  @override
  int get hashCode => Object.hash(muted, route, routes.length, micProblem, interruption);
}

/// What happened while the station could not reach the agent, in one sentence that says so
/// ("While your internet was down, the customer hung up."), with an optional [detail] line.
@immutable
class MissedReleaseView {
  const MissedReleaseView({required this.headline, this.detail = ''});
  final String headline;
  final String detail;

  @override
  bool operator ==(Object other) => other is MissedReleaseView && other.headline == headline && other.detail == detail;
  @override
  int get hashCode => Object.hash(headline, detail);
}

/// Why the campaign is not dialling, as No calls right now (02c) says it (`campaign_state.reason`):
/// only a supervisor's pause or stop blames the supervisor; the system's own pause (`auto_paused`)
/// blames nobody; a finished list says so; no reason yet is a neutral line.
enum CallsStopped { bySupervisor, autoPaused, listFinished, notStarted }

/// Why nothing is due for the agent on a `strict` or `preferred` campaign
/// (contact assignment). [other]: a reason this build does not know.
enum QueueIdle { queueEmpty, waitingForRetry, callbacksLater, outsideCallingHours, other }

/// The agent's own queue on a `strict` or `preferred` campaign: something is
/// due now, or nothing is, why, and when the next contact falls due.
@immutable
class QueueView {
  const QueueView({required this.due, this.reason, this.nextDueAt});

  /// A contact is due for this agent now: the station waits as usual.
  final bool due;

  /// Why nothing is due; null when [due].
  final QueueIdle? reason;

  /// When the next contact falls due, on this device's clock; null when none is scheduled.
  final DateTime? nextDueAt;

  /// "Nothing due now" belongs on the waiting screen.
  bool get nothingDue => !due;

  @override
  bool operator ==(Object other) =>
      other is QueueView && other.due == due && other.reason == reason && other.nextDueAt == nextDueAt;
  @override
  int get hashCode => Object.hash(due, reason, nextDueAt);
}

/// Late binding's hidden dials, as the waiting screen shows them: the dialer
/// rings a customer for this agent and shows them nothing unless the customer
/// answers, so without this a phone ringing for them, nothing due and a stuck
/// station all look the same. Never the number, the name or anything else
/// about the contact.
///
/// Set only while the agent is available with the socket open, the campaign
/// dialling and no call on screen, and only when there is something to say
/// (dialling, or unanswered dials to count); null otherwise, and the screen
/// keeps its usual words.
@immutable
class DialActivityView {
  const DialActivityView({required this.dialling, required this.unansweredInARow});

  /// A hidden dial is ringing, or one ended unanswered moments ago and the
  /// next is likely on its way (the controller's `dialGapHold`): "Dialling a customer…".
  final bool dialling;

  /// Hidden dials in a row that ended unanswered, since the last campaign call
  /// the agent was shown (`reserved`); an inbound or soft-phone call does not
  /// reset it.
  final int unansweredInARow;

  @override
  bool operator ==(Object other) =>
      other is DialActivityView && other.dialling == dialling && other.unansweredInARow == unansweredInARow;
  @override
  int get hashCode => Object.hash(dialling, unansweredInARow);

  @override
  String toString() => 'DialActivityView(dialling: $dialling, unanswered: $unansweredInARow)';
}

/// Where an inbound call on the station is (`docs/inbound.md` §6).
enum InboundStage {
  /// Offered: the panel is up, the chime has played, and the caller's audio binds at
  /// [InboundCallView.connectsAt]. Hang up is not offered yet.
  offered,

  /// Connected: audio both ways, the talk timer runs from [InboundCallView.bridgedAt].
  connected,

  /// Ended after it was answered, owing its outcome until [InboundCallView.outcomeDueAt].
  outcome,
}

/// Why the caller is called "your customer", or whose they usually are.
enum InboundSticky { owner, lastFromNumber, lastConnected, lastDialled, other }

/// Where the outcome pad's list comes from.
enum InboundCatalogKind { campaign, route, standard }

/// An inbound caller on the station, from the offer until the outcome is saved (or the call
/// leaves without one). Times are on this device's clock.
@immutable
class InboundCallView {
  const InboundCallView({
    required this.callId,
    required this.stage,
    required this.toE164,
    required this.callerDnc,
    required this.recording,
    required this.waitedSeconds,
    required this.catalogKind,
    this.fromE164,
    this.routeName,
    this.displayName,
    this.sticky,
    this.stickyIsYou = false,
    this.campaignName,
    this.campaignId,
    this.contactState,
    this.heroFields = const [],
    this.heroesConfigured = false,
    this.otherFields = const [],
    this.priorAttempts = const [],
    this.connectsAt,
    this.bridgedAt,
    this.outcomeDueAt,
    this.hangupFailure,
    this.facts,
  });

  final String callId;
  final InboundStage stage;

  /// E.164; null when the caller withheld their number.
  final String? fromE164;

  /// The number they rang.
  final String toE164;
  final String? routeName;

  /// The matched contact's name, when the roster has one: the domain's one rule (AS19 S1, the
  /// matched campaign's name role first, else the name guess).
  final String? displayName;

  /// Null: the caller has no agent of their own.
  final InboundSticky? sticky;

  /// The caller's own agent is this one ("Your customer").
  final bool stickyIsYou;

  /// The number is on a Do Not Call list: their own call is an enquiry, taken all the same.
  final bool callerDnc;
  final bool recording;
  final int waitedSeconds;

  /// The matched contact's campaign, or null when the number matched nobody.
  final String? campaignName;

  /// The matched campaign's id (its routing decides who makes a call-later, AS8); null with no match.
  final String? campaignId;

  /// The matched contact's state, in words.
  final String? contactState;

  /// The matched contact, read as the campaign pop reads its contact.
  final List<ContactField> heroFields;
  final bool heroesConfigured;
  final List<ContactField> otherFields;
  final List<PriorAttempt> priorAttempts;
  final InboundCatalogKind catalogKind;

  /// While offered: when the caller's audio binds.
  final DateTime? connectsAt;

  /// Audio both ways from here.
  final DateTime? bridgedAt;

  /// While the outcome is owed: when the call closes without one.
  final DateTime? outcomeDueAt;

  /// A hang-up that did not go through, in words; null otherwise.
  final String? hangupFailure;

  /// AS19 S3: the matched campaign chose its card's facts (its `context_display.facts` is a list):
  /// the chosen card, built from the contact's row by the domain's rule (`wire.chosenFactTiles`):
  /// the name, the place (its role only) and the tiles, as the campaign call's card has them.
  /// Null for a campaign that did not choose (the hero fields then), or no match.
  final FactsView? facts;

  bool get withheld => fromE164 == null;
  bool get matched => campaignName != null;

  /// The matched campaign chose its card's facts (AS19).
  bool get factsChosen => facts?.chosen ?? false;

  static const _eqF = ListEquality<ContactField>();
  static const _eqP = ListEquality<PriorAttempt>();

  @override
  bool operator ==(Object other) =>
      other is InboundCallView &&
      other.callId == callId &&
      other.stage == stage &&
      other.fromE164 == fromE164 &&
      other.toE164 == toE164 &&
      other.routeName == routeName &&
      other.displayName == displayName &&
      other.sticky == sticky &&
      other.stickyIsYou == stickyIsYou &&
      other.callerDnc == callerDnc &&
      other.recording == recording &&
      other.waitedSeconds == waitedSeconds &&
      other.campaignName == campaignName &&
      other.campaignId == campaignId &&
      other.contactState == contactState &&
      _eqF.equals(other.heroFields, heroFields) &&
      other.heroesConfigured == heroesConfigured &&
      _eqF.equals(other.otherFields, otherFields) &&
      _eqP.equals(other.priorAttempts, priorAttempts) &&
      other.catalogKind == catalogKind &&
      other.connectsAt == connectsAt &&
      other.bridgedAt == bridgedAt &&
      other.outcomeDueAt == outcomeDueAt &&
      other.hangupFailure == hangupFailure &&
      other.facts == facts;

  @override
  int get hashCode => Object.hash(callId, stage, bridgedAt, outcomeDueAt, hangupFailure, heroFields.length, facts);
}

/// "Your customer is waiting": a caller who usually speaks to this agent rang in while they
/// were busy, and is put through to them next.
@immutable
class CustomerWaitingView {
  const CustomerWaitingView({required this.callId, required this.since, this.name, this.fromE164});

  final String callId;

  /// When they started waiting (this device's clock).
  final DateTime since;

  /// The matched contact's name, when known.
  final String? name;

  /// E.164; null when withheld.
  final String? fromE164;

  @override
  bool operator ==(Object other) =>
      other is CustomerWaitingView &&
      other.callId == callId &&
      other.since == since &&
      other.name == name &&
      other.fromE164 == fromE164;
  @override
  int get hashCode => Object.hash(callId, since, name, fromE164);
}

/// Where the agent's Need help stands (floor assist, LF4): nothing open, being asked for, open, or
/// being cancelled.
enum HelpStage { none, raising, open, cancelling }

/// The tone of [HelpView.notice]: answered (a supervisor is on it) or a warning (nobody answered).
enum HelpNoticeTone { success, warning }

/// The agent's Need help on the station (floor assist, LF4, LF13–LF15). The control is offered on a
/// call and in wrap-up while the account has floor assist on (the screen reads the flag); an open
/// request, and the notice of how the last one ended, show wherever the station is.
@immutable
class HelpView {
  const HelpView({this.stage = HelpStage.none, this.raisedAt, this.notice, this.noticeTone, this.error, this.onlyOnCall = false});

  final HelpStage stage;

  /// When the open request was raised (this device's clock); null with none open.
  final DateTime? raisedAt;

  /// How the last request ended, in words ("Anitha N is listening to your call."), until the agent
  /// dismisses it or asks again; null for none.
  final String? notice;
  final HelpNoticeTone? noticeTone;

  /// Why the last raise or cancel did not go through; null for none.
  final String? error;

  /// This server takes a raise only on a call or while finishing one (it refused one elsewhere
  /// `help_not_on_call`: a server older than BE-9): the button is offered there only, for the rest
  /// of the session.
  final bool onlyOnCall;

  /// A request is open (or being cancelled): the screen says so and offers Cancel.
  bool get isOpen => stage == HelpStage.open || stage == HelpStage.cancelling;

  /// Anything to show outside a call: an open request, a notice or a refusal.
  bool get hasNews => stage != HelpStage.none || notice != null || error != null;

  @override
  bool operator ==(Object other) =>
      other is HelpView &&
      other.stage == stage &&
      other.raisedAt == raisedAt &&
      other.notice == notice &&
      other.noticeTone == noticeTone &&
      other.error == error &&
      other.onlyOnCall == onlyOnCall;
  @override
  int get hashCode => Object.hash(stage, raisedAt, notice, noticeTone, error, onlyOnCall);
}

/// A supervisor's message to the agent (floor assist, LF5): plain text, who sent it ("Your
/// supervisor" when the server could not name them) and when (this device's clock).
@immutable
class SupervisorMessageView {
  const SupervisorMessageView({required this.id, required this.text, required this.from, required this.sentAt});

  final String id;
  final String text;
  final String from;
  final DateTime sentAt;

  @override
  bool operator ==(Object other) =>
      other is SupervisorMessageView && other.id == id && other.text == text && other.from == from && other.sentAt == sentAt;
  @override
  int get hashCode => Object.hash(id, text, from, sentAt);
}

/// An action in flight, so its button shows progress and cannot double-fire.
///
/// [redialing] lasts from the tap until the redial's call reaches the
/// station (or is refused), not only while the request is open: the wrap-up
/// on screen is over once the server placed the call.
enum StationBusy {
  none,
  goingAvailable,
  takingBreak,
  cancellingBreak,
  endingBreak,
  hangingUp,
  savingDisposition,
  markingDnc,
  redialing,
  leaving,
}

@immutable
class StationView {
  const StationView({
    required this.campaignId,
    required this.campaignName,
    this.sessionId,
    this.link = StationLink.connecting,
    this.phase = AgentPhase.offline,
    this.phaseSince,
    this.campaignDialing = true,
    this.campaignMessage,
    this.callsStopped,
    this.onBreak,
    this.queuedBreak,
    this.breakOptions = const [],
    this.call,
    this.release,
    this.wrapup,
    this.dispositions = const [],
    this.dispositionSaved,
    this.notes = const NotesView(),
    this.audio = const AudioView(),
    this.missedRelease,
    this.reconnectDeadline,
    this.reconnectWindow,
    this.dncOutcome,
    this.weakConnection = false,
    this.busy = StationBusy.none,
    this.actionError,
    this.fatal,
    this.queue,
    this.dialActivity,
    this.myContactsOffered = false,
    this.assignsContacts = false,
    this.inbound,
    this.customerWaiting,
    this.inboundNotice,
    this.help = const HelpView(),
    this.script,
    this.maskPhone = false,
    this.readyCount = 0,
  });

  final String campaignId;
  final String campaignName;
  final String? sessionId;
  final StationLink link;
  final AgentPhase phase;

  /// When [phase] started (break timers, "Available for 01:42").
  final DateTime? phaseSince;

  /// False while the campaign is paused or not dialling: "no campaign calls for now" (customers
  /// who ring in can still reach the agent: the inbound router does not read campaign status).
  final bool campaignDialing;
  final String? campaignMessage;

  /// Why calls stopped, while [campaignDialing] is false; null while dialling.
  final CallsStopped? callsStopped;

  final BreakInfo? onBreak;
  final BreakInfo? queuedBreak;
  final List<BreakOption> breakOptions;

  final CallView? call;
  final ReleaseView? release;
  final WrapupView? wrapup;
  final List<DispositionOption> dispositions;

  /// The code saved for the call on screen, once the server accepted it.
  final String? dispositionSaved;
  final NotesView notes;
  final AudioView audio;
  final MissedReleaseView? missedRelease;

  /// Mid-call reconnect: the server ends the call if the socket is not back by then.
  final DateTime? reconnectDeadline;

  /// The whole mid-call reconnect window ([reconnectDeadline] minus the drop time), so a
  /// countdown can be drawn to scale. Null with no deadline.
  final Duration? reconnectWindow;

  /// The follow-up line after Mark DNC for the call on screen, in the console's words
  /// (what the server confirmed it recorded). Null until a mark succeeds.
  final String? dncOutcome;

  /// Pings are arriving late (≥ 2 missed): show "Weak connection".
  final bool weakConnection;
  final StationBusy busy;

  /// The last refused action, in the server's or the console's words.
  final String? actionError;

  /// The station cannot open at all (join refused); shown full-screen with a way back.
  final String? fatal;

  /// The agent's own queue, from the `queue` frame: sent on every assignment mode since BE-5
  /// (a `pool` campaign included, for No calls right now's reasons), so it says nothing about
  /// who makes a call-later. Null before the first frame, or from a server older than it.
  final QueueView? queue;

  /// Late binding's hidden dials, when the waiting screen has something to say
  /// about them ([DialActivityView]); null otherwise.
  final DialActivityView? dialActivity;

  /// Whether this campaign has a My contacts for the agent (contact
  /// assignment), as the join bootstrap says: it assigns contacts (not
  /// `pool`) or lets agents retry the ones they did not reach. The
  /// console's rule for its header button; the flag is checked on top.
  final bool myContactsOffered;

  /// The campaign assigns contacts (`strict` or `preferred`, as the join bootstrap says; an
  /// absent mode reads `pool`): a call-later booked here comes back to this agent (AS8). On a
  /// `pool` campaign another agent may make it. The console's `assigns` (`AgentConsolePage`).
  final bool assignsContacts;

  /// The inbound caller on the station (offered, on the call, or owing the outcome), or null.
  /// While it is set, [call] is null, and [notes], [dispositions], [dispositionSaved] and
  /// [dncOutcome] are this call's; [phase] follows it (reserved, on a call, wrap-up).
  final InboundCallView? inbound;

  /// "Your customer is waiting", above whatever the station shows.
  final CustomerWaitingView? customerWaiting;

  /// Why an inbound call just left the station without the agent's outcome (the caller hung
  /// up first, it went back to the queue, ...), for 30 s or until the next call.
  final String? inboundNotice;

  /// The agent's Need help (floor assist): its own stage, never [busy], so asking for help never
  /// holds up hanging up or saving the outcome.
  final HelpView help;

  /// The campaign's script (BE-8); null when it has none, or from a server that does not send it.
  final ScriptView? script;

  /// The campaign shows the customer's number masked (AS9, `phone_display: 'masked'`): `98••• ••321`
  /// on every station screen. The number is still in [CallView.phoneE164] for the call itself.
  final bool maskPhone;

  /// How many `ready` frames this session has had (the first, and one after each reconnect). The
  /// station reads My day again on each (the my-day contract's "on every `ready` frame").
  final int readyCount;

  /// The call on screen, campaign or inbound: what notes, dialogs and sheets are keyed by.
  String? get callId => call?.attemptId ?? inbound?.callId;

  /// The call screen must be in front: reserved, on a call or in wrap-up.
  bool get callActive => phase == AgentPhase.reserved || phase == AgentPhase.onCall || phase == AgentPhase.wrapup;

  static const _eqB = ListEquality<BreakOption>();
  static const _eqD = ListEquality<DispositionOption>();

  @override
  bool operator ==(Object other) =>
      other is StationView &&
      other.campaignId == campaignId &&
      other.campaignName == campaignName &&
      other.sessionId == sessionId &&
      other.link == link &&
      other.phase == phase &&
      other.phaseSince == phaseSince &&
      other.campaignDialing == campaignDialing &&
      other.campaignMessage == campaignMessage &&
      other.callsStopped == callsStopped &&
      other.onBreak == onBreak &&
      other.queuedBreak == queuedBreak &&
      _eqB.equals(other.breakOptions, breakOptions) &&
      other.call == call &&
      other.release == release &&
      other.wrapup == wrapup &&
      _eqD.equals(other.dispositions, dispositions) &&
      other.dispositionSaved == dispositionSaved &&
      other.notes == notes &&
      other.audio == audio &&
      other.missedRelease == missedRelease &&
      other.reconnectDeadline == reconnectDeadline &&
      other.reconnectWindow == reconnectWindow &&
      other.dncOutcome == dncOutcome &&
      other.weakConnection == weakConnection &&
      other.busy == busy &&
      other.actionError == actionError &&
      other.fatal == fatal &&
      other.queue == queue &&
      other.dialActivity == dialActivity &&
      other.myContactsOffered == myContactsOffered &&
      other.assignsContacts == assignsContacts &&
      other.inbound == inbound &&
      other.customerWaiting == customerWaiting &&
      other.inboundNotice == inboundNotice &&
      other.help == help &&
      other.script == script &&
      other.maskPhone == maskPhone &&
      other.readyCount == readyCount;

  @override
  int get hashCode => Object.hashAll([campaignId, sessionId, link, phase, phaseSince, call, wrapup, busy, audio, notes, actionError, queue, inbound]);
}

/// Everything the station screens can ask for. Each returns when the server
/// answered; refusals land in [StationView.actionError] (and the future
/// completes normally), so a screen never needs try/catch for expected cases.
abstract interface class StationActions {
  Future<void> goAvailable();
  Future<void> takeBreak(String code);
  Future<void> cancelQueuedBreak();
  Future<void> endBreak();
  /// Hangs up the call on screen: a campaign attempt, or an inbound call once it is connected
  /// (never while it is only offered).
  Future<void> hangUp();
  Future<void> setMuted(bool muted);
  Future<void> setRoute(AudioRouteOption route);

  /// Debounced and saved by the core; call on every keystroke. The notes of the call on
  /// screen: a campaign attempt's, or an inbound call's.
  void updateNotes(String text);

  /// Saves the outcome of the call on screen: a campaign wrap-up's, or an inbound call's (from
  /// its own catalog, [StationView.dispositions]).
  ///
  /// [promiseDate] (`YYYY-MM-DD`) and [promiseAmount] are the promise to pay (PT1), sent
  /// only with an outcome that asks for one.
  Future<void> submitDisposition(
    String code, {
    String? notes,
    DateTime? callbackAt,
    String? promiseDate,
    String? promiseAmount,
  });

  /// Redials the customer of the wrap-up on screen, before its outcome is
  /// saved ([WrapupView.redialRemaining]). [attemptId] is the call the agent
  /// is looking at: when the wrap-up is another call's by then, nothing is
  /// dialled and [StationView.actionError] says so. A refusal leaves the
  /// agent in wrap-up with the outcome pad usable.
  Future<void> redial({String? attemptId});
  /// Marks the live call Do Not Call (or the inbound caller's number, on the
  /// call or owing its outcome). [attemptId] is the call the agent confirmed
  /// for: when the call is another one by then, nothing is marked and
  /// [StationView.actionError] says so.
  Future<void> markDnc({String? reason, String? attemptId});

  /// Leaves the station. [LeaveOutcome.stayed] (the refusal is in
  /// [StationView.actionError]) keeps the agent on it.
  Future<LeaveOutcome> leave();
  Future<void> reconnect();

  /// After 4409: take the station back on this device.
  Future<void> useThisDevice();

  /// The agent is leaving a station that is over on this phone (4404, 4409,
  /// or one that cannot open): forget it here. Nothing is sent.
  Future<void> dismiss();
  void dismissActionError();
  void dismissMissedRelease();

  /// Need help (floor assist, LF4): asks every supervisor of the account for help with the call on
  /// screen or its wrap-up. Refusals land in [HelpView.error].
  Future<void> raiseHelp();

  /// Withdraws the open Need help request. Refusals land in [HelpView.error].
  Future<void> cancelHelp();

  /// Puts away [HelpView.notice] and [HelpView.error].
  void dismissHelpNotice();
}

/// How [StationActions.leave] ended.
enum LeaveOutcome {
  /// The server took the agent off the station.
  left,

  /// The server could not be reached: the station was closed on this phone
  /// anyway (its socket closing is what takes the agent off duty server-side).
  leftOffline,

  /// Refused, or a call is live: still on the station.
  stayed,
}

/// How starting a station ended. The preflight screen shows the conflicts as
/// choices ("Leave X and join here") and the rest as a message.
sealed class StationStart {
  const StationStart();
}

final class StationStarted extends StationStart {
  const StationStarted();
}

/// `409 session_on_other_campaign`: live on another campaign (maybe in a
/// sibling account). [canLeave] is false while a call is live there.
@immutable
final class StationElsewhere extends StationStart {
  const StationElsewhere({
    required this.sessionId,
    required this.campaignId,
    required this.campaignName,
    required this.stateLabel,
    required this.canLeave,
    this.accountId,
    this.accountName,
  });
  final String sessionId;
  final String campaignId;
  final String campaignName;

  /// What the agent is doing there, in the station's words ("on a call", `joinDoing`).
  final String stateLabel;
  final bool canLeave;
  final String? accountId;
  final String? accountName;
}

/// `409 session_on_softphone`: the soft phone is open (the app has no soft
/// phone in v1, so the agent closes it here or on the web).
@immutable
final class StationOnSoftphone extends StationStart {
  const StationOnSoftphone({required this.sessionId, this.accountId, this.accountName});
  final String sessionId;
  final String? accountId;
  final String? accountName;
}

/// Anything else that stops the station opening (`not_staffed`, a paused or
/// stopped campaign, the dialer switched off, offline), in words for the agent.
@immutable
final class StationRefused extends StationStart {
  const StationRefused(this.message, {this.code});
  final String message;
  final String? code;
}

/// Opens and closes stations. Separate from [StationActions] because it is
/// used before a station exists (the preflight screen's "Go on duty").
abstract interface class StationLauncher {
  /// Joins (or rehydrates) the campaign's session, starts the on-duty
  /// foreground service and the audio pre-warm, and opens the socket.
  ///
  /// [takeOver] (OS3): the agent chose this phone, so the station moves here. An automatic resume
  /// passes false, and is refused (a [StationRefused] with `station_on_other_device`) when another
  /// device holds the station.
  Future<StationStart> start(String campaignId, {required String campaignName, bool takeOver = true});

  /// Leaves [other] (refused while a call is live there), then starts.
  Future<StationStart> leaveOtherAndStart(StationElsewhere other, String campaignId, {required String campaignName});

  /// Closes the agent's soft-phone session (refused, as a [StationRefused] in the
  /// console's words, while it has an unsettled call), then starts.
  Future<StationStart> closeSoftphoneAndStart(StationOnSoftphone softphone, String campaignId, {required String campaignName});
}

final stationLauncherProvider = Provider<StationLauncher>(
  (ref) => throw UnimplementedError('stationLauncherProvider is provided by the station core'),
);

/// The live station, or null when the agent is not at one. Overridden by the
/// station core.
final stationViewProvider = Provider<StationView?>((ref) => null);

final stationActionsProvider = Provider<StationActions>(
  (ref) => throw UnimplementedError('stationActionsProvider is provided by the station core'),
);

/// A supervisor's messages to the agent (floor assist, LF5), oldest first, until dismissed: on a
/// campaign station or a soft-phone session alike. The app shell shows them over every tab.
/// Overridden by the station core; none without a session.
final supervisorMessagesProvider = Provider<List<SupervisorMessageView>>((ref) => const []);

/// Dismisses the message with that id. Overridden by the station core.
final dismissSupervisorMessageProvider = Provider<void Function(String id)>((ref) => (_) {});
