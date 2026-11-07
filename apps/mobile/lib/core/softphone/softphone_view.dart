import 'package:collection/collection.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../station/station_view.dart';

/// The soft phone as the screens see it: the seam between the soft-phone core
/// (`softphone_controller.dart`, a port of the console's `useSoftphone`) and the
/// soft-phone UI (`lib/features/softphone/`).
///
/// The core turns the host's manual call, its own bootstrap and the agent's
/// edits into one [SoftphoneView]; the UI renders it and calls
/// [SoftphoneActions]. Nothing here depends on `agency_wire`, so the UI is built
/// and tested against plain values, the same pattern as `station_view.dart`
/// (whose [ContactField], [PriorAttempt], [DispositionOption], [NotesView],
/// [AudioView], [AudioRouteOption] and [StationLink] are reused). Every type is
/// immutable with value equality, so `ref.watch(softphoneViewProvider.select(…))`
/// rebuilds a widget only when its slice changed.
///
/// Times are on this DEVICE's clock: the core maps server instants with the
/// host's clock offset, so the UI compares them to `DateTime.now()` directly.
///
/// Copy: every sentence the core decides (refusals, the rail, block reasons)
/// arrives as a string, in the console's words with the mobile substitutions.
/// The UI owns only its own labels.

// ─── Enums ──────────────────────────────────────────────────────────────────

/// Which host the soft-phone panel is drawn in. The panel is the same; the way
/// out differs: Close the soft phone on the Phone tab, Return to the campaign
/// on the station (SP7).
enum SoftphoneSurface {
  /// The Phone tab, hosting a soft-phone session.
  phone,

  /// The campaign station, switched to the soft phone (`break/soft_phone`).
  station,
}

/// The rail's five states, from the call alone (`call_state.dart`).
enum SoftphonePhase {
  /// No call, or the last one is settled: the pad is up.
  ready,

  /// Queued or dialing: the agent's leg comes up first, then the customer is dialled.
  dialing,

  /// The customer's phone is ringing; ringback plays (unless the ring is muted).
  ringing,

  /// Answered or bridged. The talk timer waits for `bridged_at`.
  onCall,

  /// Ended after an answer: the outcome is owed before the next dial.
  outcome,
}

enum SoftphoneRailTone { neutral, info, success, warning, danger }

/// What Mute acts on: the ringback while the customer's phone rings, else the
/// microphone. Separate so an agent who quietened the ring is not muted when
/// the customer answers.
enum SoftphoneMuteTarget { ring, mic }

/// Which refusal the override prompt is answering.
enum SoftphoneOverrideKind {
  /// `dnc_listed` (SP1).
  dnc,

  /// `outside_calling_hours` (SP2).
  hours,
}

/// A call field's input. [unsupported] is a type this build does not know:
/// show the value read-only, never drop it.
enum SoftphoneFieldType { text, number, choice, boolean, date, unsupported }

/// How a recent call's outcome line reads (`manualCallOutcome`).
enum SoftphoneOutcomeKind {
  /// The agent saved an outcome: its label.
  saved,

  /// Ended, outcome still owed: "No outcome yet".
  awaiting,

  /// Still on the line: "On a call now".
  live,

  /// Unanswered and closed: what the line did ("No answer").
  line,
}

/// Why "Save outcome" is disabled right now. See [SoftphoneView.saveBlockAt]
/// and [softphoneSaveBlockCopy].
enum SoftphoneSaveBlock { noSelection, callLive, noteRequired, callbackRequired, callbackInPast, fieldsRequired }

/// A session-level action in flight on the soft phone's header or screen card.
enum SoftphoneSessionBusy { none, opening, closing, switching, returning }

// ─── Small values ───────────────────────────────────────────────────────────

/// The rail (status band): label, detail and the instant its timer counts from.
@immutable
class SoftphoneRail {
  const SoftphoneRail({required this.tone, required this.label, this.detail, this.timerFrom});

  final SoftphoneRailTone tone;

  /// "Ready to dial", "Ringing +91 98123 45678", "On call with Rahul Verma",
  /// "Outcome needed", "Reconnecting", …
  final String label;
  final String? detail;

  /// Device clock; null for no timer (Ready, connection problems, and on a call
  /// before `bridged_at`).
  final DateTime? timerFrom;

  static const connecting = SoftphoneRail(tone: SoftphoneRailTone.neutral, label: 'Connecting your phone…');

  @override
  bool operator ==(Object other) =>
      other is SoftphoneRail &&
      other.tone == tone &&
      other.label == label &&
      other.detail == detail &&
      other.timerFrom == timerFrom;
  @override
  int get hashCode => Object.hash(tone, label, detail, timerFrom);
}

/// One choice in a picker: what is sent and what is shown.
@immutable
class SoftphoneChoice {
  const SoftphoneChoice({required this.value, required this.label});

  /// Sent as is (an E.164 caller ID).
  final String value;

  /// Shown ("+91 20712 34567").
  final String label;

  @override
  bool operator ==(Object other) => other is SoftphoneChoice && other.value == value && other.label == label;
  @override
  int get hashCode => Object.hash(value, label);
}

/// A campaign the call can be logged to ("Log to").
@immutable
class SoftphoneTagOption {
  const SoftphoneTagOption({
    required this.campaignId,
    required this.name,
    this.windowOpen = true,
    this.windowNote,
    this.recording = false,
    this.analysisProfileName,
  });

  final String campaignId;
  final String name;

  /// The calling window was open when the bootstrap was read (advisory).
  final bool windowOpen;

  /// "(campaign time) · may need a reason" while the window is closed; null when open.
  final String? windowNote;

  /// Calls logged here are recorded: the UI must disclose it.
  final bool recording;

  /// "Summarised with Renewals v3", or null for the account default.
  final String? analysisProfileName;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneTagOption &&
      other.campaignId == campaignId &&
      other.name == name &&
      other.windowOpen == windowOpen &&
      other.windowNote == windowNote &&
      other.recording == recording &&
      other.analysisProfileName == analysisProfileName;
  @override
  int get hashCode => Object.hash(campaignId, name, windowOpen, windowNote, recording, analysisProfileName);
}

/// One call field, with the value on screen and its problem.
@immutable
class SoftphoneFieldView {
  const SoftphoneFieldView({
    required this.key,
    required this.label,
    required this.type,
    this.options = const [],
    this.required = false,
    this.value,
    this.error,
  });

  /// Passed back to [SoftphoneActions.setFieldValue].
  final String key;
  final String label;
  final SoftphoneFieldType type;

  /// `choice` only.
  final List<String> options;

  /// The outcome cannot be saved while it is empty.
  final bool required;

  /// `String` (text, choice, and date as `YYYY-MM-DD`), `num`, `bool`, or null (empty).
  final Object? value;

  /// The server's or the local check's sentence for this field; null when fine.
  final String? error;

  static const _eq = ListEquality<String>();

  @override
  bool operator ==(Object other) =>
      other is SoftphoneFieldView &&
      other.key == key &&
      other.label == label &&
      other.type == type &&
      _eq.equals(other.options, options) &&
      other.required == required &&
      other.value == value &&
      other.error == error;
  @override
  int get hashCode => Object.hash(key, label, type, options.length, required, value, error);
}

/// The roster contact the dialled number matched, as the station's screen pop
/// shows one (resolved through the tag's `context_display`).
@immutable
class SoftphoneContactView {
  const SoftphoneContactView({
    this.displayName,
    this.heroFields = const [],
    this.heroesConfigured = false,
    this.otherFields = const [],
    this.priorAttempts = const [],
    this.claimed = false,
    this.campaignName,
  });

  /// A name-like field's value for "On call with …"; null leads with the number.
  final String? displayName;
  final List<ContactField> heroFields;

  /// False when the heroes were guessed: the UI says "auto-selected".
  final bool heroesConfigured;
  final List<ContactField> otherFields;
  final List<PriorAttempt> priorAttempts;

  /// This call claimed the contact, so its outcome settles the roster row.
  final bool claimed;

  /// The campaign whose roster matched (the call's tag).
  final String? campaignName;

  static const _eqF = ListEquality<ContactField>();
  static const _eqP = ListEquality<PriorAttempt>();

  @override
  bool operator ==(Object other) =>
      other is SoftphoneContactView &&
      other.displayName == displayName &&
      _eqF.equals(other.heroFields, heroFields) &&
      other.heroesConfigured == heroesConfigured &&
      _eqF.equals(other.otherFields, otherFields) &&
      _eqP.equals(other.priorAttempts, priorAttempts) &&
      other.claimed == claimed &&
      other.campaignName == campaignName;
  @override
  int get hashCode => Object.hash(displayName, heroFields.length, otherFields.length, priorAttempts.length, claimed);
}

/// One line of the override prompt's facts ("Listed for", "Since", "Window").
@immutable
class SoftphoneFact {
  const SoftphoneFact({required this.label, required this.value});
  final String label;
  final String value;

  @override
  bool operator ==(Object other) => other is SoftphoneFact && other.label == label && other.value == value;
  @override
  int get hashCode => Object.hash(label, value);
}

/// The DNC / calling-hours override prompt (a port of the console's
/// `OverrideDialog`). "Don't call" is the primary action
/// ([SoftphoneActions.cancelOverride]); "Call anyway"
/// ([SoftphoneActions.confirmOverride]) is enabled only while the note is
/// [noteMin]–[noteMax] characters after trimming (count code points).
@immutable
class SoftphoneOverridePrompt {
  const SoftphoneOverridePrompt({
    required this.kind,
    required this.title,
    this.facts = const [],
    required this.consequence,
    required this.noteLabel,
    required this.confirmLabel,
    this.submitting = false,
    this.error,
  });

  final SoftphoneOverrideKind kind;

  /// "This number is on the Do Not Call list" / "Outside calling hours".
  final String title;

  /// What matched, in reading order. Times are already in words (the window as
  /// the server states it, the next opening as relative time plus device time).
  final List<SoftphoneFact> facts;

  /// What calling anyway does; always shown.
  final String consequence;
  final String noteLabel;

  /// "Call anyway".
  final String confirmLabel;

  /// The redial with the note is in flight.
  final bool submitting;

  /// `override_note_invalid` (or a failed redial) while the prompt is open.
  final String? error;

  static const noteMin = 10;
  static const noteMax = 500;

  /// The note as the server counts it: code points after trimming.
  static int noteLength(String note) => note.trim().runes.length;

  /// Whether "Call anyway" may be pressed with [note].
  static bool noteValid(String note) {
    final n = noteLength(note);
    return n >= noteMin && n <= noteMax;
  }

  static const _eq = ListEquality<SoftphoneFact>();

  @override
  bool operator ==(Object other) =>
      other is SoftphoneOverridePrompt &&
      other.kind == kind &&
      other.title == title &&
      _eq.equals(other.facts, facts) &&
      other.consequence == consequence &&
      other.noteLabel == noteLabel &&
      other.confirmLabel == confirmLabel &&
      other.submitting == submitting &&
      other.error == error;
  @override
  int get hashCode => Object.hash(kind, title, facts.length, submitting, error);
}

/// One recent call on the idle pad (the agent's last few soft-phone calls).
@immutable
class SoftphoneRecentCall {
  const SoftphoneRecentCall({
    required this.id,
    required this.numberE164,
    required this.numberDisplay,
    required this.at,
    required this.whenLabel,
    required this.outcomeLabel,
    required this.outcomeKind,
    required this.loggedTo,
    this.tagged = false,
    this.canRedial = true,
  });

  /// Passed back to [SoftphoneActions.redial].
  final String id;
  final String numberE164;
  final String numberDisplay;

  /// When it was placed, device clock.
  final DateTime at;

  /// "Today, 09:05 am" / "Yesterday, 06:40 pm" / "28 Oct, 11:12 am".
  final String whenLabel;
  final String outcomeLabel;
  final SoftphoneOutcomeKind outcomeKind;

  /// "Logged to Q4 Renewals" / "Not logged to a campaign".
  final String loggedTo;
  final bool tagged;

  /// False in finish mode, or while a call is on screen.
  final bool canRedial;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneRecentCall &&
      other.id == id &&
      other.numberE164 == numberE164 &&
      other.numberDisplay == numberDisplay &&
      other.at == at &&
      other.whenLabel == whenLabel &&
      other.outcomeLabel == outcomeLabel &&
      other.outcomeKind == outcomeKind &&
      other.loggedTo == loggedTo &&
      other.tagged == tagged &&
      other.canRedial == canRedial;
  @override
  int get hashCode => Object.hash(id, at, whenLabel, outcomeLabel, outcomeKind, canRedial);
}

// ─── The Phone tab's screen ─────────────────────────────────────────────────

/// What the Phone tab shows (a port of the console's `SoftphoneSessionState`).
/// Only [SoftphoneScreenActive] draws the panel.
@immutable
sealed class SoftphoneScreenState {
  const SoftphoneScreenState();
}

/// The bootstrap has not answered yet.
final class SoftphoneScreenLoading extends SoftphoneScreenState {
  const SoftphoneScreenLoading();

  @override
  bool operator ==(Object other) => other is SoftphoneScreenLoading;
  @override
  int get hashCode => (SoftphoneScreenLoading).hashCode;
}

/// No soft-phone session: "Open the soft phone". The UI asks for the
/// microphone and notification permissions on the tap, then calls
/// [SoftphoneActions.open].
final class SoftphoneScreenClosed extends SoftphoneScreenState {
  const SoftphoneScreenClosed({this.microphoneBlocked = false, this.notice});

  /// The microphone permission was refused (permanently): the card explains
  /// and offers the system settings instead of Open.
  final bool microphoneBlocked;

  /// Why the last open did not happen ("Your soft phone is still open — …"),
  /// or null.
  final String? notice;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneScreenClosed && other.microphoneBlocked == microphoneBlocked && other.notice == notice;
  @override
  int get hashCode => Object.hash(microphoneBlocked, notice);
}

/// The open (or the resume) is in flight.
final class SoftphoneScreenOpening extends SoftphoneScreenState {
  const SoftphoneScreenOpening();

  @override
  bool operator ==(Object other) => other is SoftphoneScreenOpening;
  @override
  int get hashCode => (SoftphoneScreenOpening).hashCode;
}

/// A soft-phone session is hosted here: draw `SoftphonePanel(surface: phone)`.
final class SoftphoneScreenActive extends SoftphoneScreenState {
  const SoftphoneScreenActive();

  @override
  bool operator ==(Object other) => other is SoftphoneScreenActive;
  @override
  int get hashCode => (SoftphoneScreenActive).hashCode;
}

/// `session_on_campaign`: the agent is live on a campaign. The remedy is the
/// switch on that session (SP7), never a second session.
final class SoftphoneScreenOnCampaign extends SoftphoneScreenState {
  const SoftphoneScreenOnCampaign({
    required this.campaignId,
    required this.campaignName,
    required this.stateLabel,
    required this.accountId,
    this.accountName,
    required this.sameAccount,
    required this.hostedHere,
    this.switchQueued = false,
    this.canSwitchAccount = false,
    this.onSoftphone = false,
  });

  final String campaignId;
  final String campaignName;

  /// The agent's state there, in words ("On a call", "Available").
  final String stateLabel;
  final String accountId;
  final String? accountName;

  /// The session is in the workspace the app is in now.
  final bool sameAccount;

  /// That station is open on this phone: offer "Switch to soft phone"
  /// ([SoftphoneActions.switchToSoftphone]), then go to the station.
  final bool hostedHere;

  /// The switch is already queued behind a call or wrap-up.
  final bool switchQueued;

  /// Another account: "You're live on {campaign} in {account}", with a switch
  /// button ([SoftphoneActions.requestAccountSwitch]) when the agent has that account.
  final bool canSwitchAccount;

  /// That session is already on the soft phone (`break/soft_phone`): there is
  /// nothing to switch, only the station to go to.
  final bool onSoftphone;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneScreenOnCampaign &&
      other.campaignId == campaignId &&
      other.campaignName == campaignName &&
      other.stateLabel == stateLabel &&
      other.accountId == accountId &&
      other.accountName == accountName &&
      other.sameAccount == sameAccount &&
      other.hostedHere == hostedHere &&
      other.switchQueued == switchQueued &&
      other.canSwitchAccount == canSwitchAccount &&
      other.onSoftphone == onSoftphone;
  @override
  int get hashCode =>
      Object.hash(campaignId, stateLabel, accountId, sameAccount, hostedHere, switchQueued, canSwitchAccount, onSoftphone);
}

/// `session_on_softphone`: the agent's soft-phone session is open in ANOTHER
/// account (or on another device in this one). "Close it and open the soft
/// phone here" ([SoftphoneActions.closeElsewhereAndOpen]), blocked while its
/// call is unfinished; or switch account.
final class SoftphoneScreenElsewhere extends SoftphoneScreenState {
  const SoftphoneScreenElsewhere({
    required this.accountId,
    this.accountName,
    this.callPending = false,
    this.canSwitchAccount = false,
  });

  final String accountId;
  final String? accountName;

  /// A call there is live or owes its outcome: closing is blocked; say so.
  final bool callPending;
  final bool canSwitchAccount;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneScreenElsewhere &&
      other.accountId == accountId &&
      other.accountName == accountName &&
      other.callPending == callPending &&
      other.canSwitchAccount == canSwitchAccount;
  @override
  int get hashCode => Object.hash(accountId, accountName, callPending, canSwitchAccount);
}

/// A session in this account that this phone did not host is open: on the
/// web, or on another phone. Nothing is resumed by itself (that would move the
/// session, and any call on it, away from wherever the agent is using it): the
/// agent taps "Use it on this phone" ([SoftphoneActions.open], after the
/// microphone and notification prompts), or "Close it"
/// ([SoftphoneActions.close]) when [canClose].
final class SoftphoneScreenOtherDevice extends SoftphoneScreenState {
  const SoftphoneScreenOtherDevice({this.campaignId, this.campaignName, this.canClose = false});

  /// A campaign session on the soft phone (with a call to finish): "Use it on
  /// this phone" starts its station here. Null for the soft-phone session.
  final String? campaignId;
  final String? campaignName;

  /// Nothing there is unfinished (no live call, no owed outcome): "Close it"
  /// is offered too. Never for a campaign session.
  final bool canClose;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneScreenOtherDevice &&
      other.campaignId == campaignId &&
      other.campaignName == campaignName &&
      other.canClose == canClose;
  @override
  int get hashCode => Object.hash(campaignId, campaignName, canClose);
}

/// The soft phone is off for the account and nothing here is left to finish:
/// "Not available for your account".
final class SoftphoneScreenOff extends SoftphoneScreenState {
  const SoftphoneScreenOff();

  @override
  bool operator ==(Object other) => other is SoftphoneScreenOff;
  @override
  int get hashCode => (SoftphoneScreenOff).hashCode;
}

/// Off here, and the agent's soft-phone session is in another account: close
/// it there ([SoftphoneActions.closeStranded]); a supervisor can save an
/// outcome its call still owes.
final class SoftphoneScreenOffStranded extends SoftphoneScreenState {
  const SoftphoneScreenOffStranded({required this.accountId, this.accountName, this.callOwed = false});

  final String accountId;
  final String? accountName;

  /// Its call ended and owes an outcome (closing lets it lapse; say who can save it).
  final bool callOwed;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneScreenOffStranded &&
      other.accountId == accountId &&
      other.accountName == accountName &&
      other.callOwed == callOwed;
  @override
  int get hashCode => Object.hash(accountId, accountName, callOwed);
}

/// The bootstrap or the open failed for a reason Retry may fix
/// ([SoftphoneActions.retry]).
final class SoftphoneScreenError extends SoftphoneScreenState {
  const SoftphoneScreenError(this.message);
  final String message;

  @override
  bool operator ==(Object other) => other is SoftphoneScreenError && other.message == message;
  @override
  int get hashCode => message.hashCode;
}

// ─── The view ───────────────────────────────────────────────────────────────

/// Everything the Phone screen and the soft-phone panel render.
@immutable
class SoftphoneView {
  const SoftphoneView({
    this.screen = const SoftphoneScreenLoading(),
    this.link = StationLink.connecting,
    this.reconnectDeadline,
    this.phase = SoftphonePhase.ready,
    this.rail = SoftphoneRail.connecting,
    this.callId,
    this.startAllowed = true,
    this.finishOnly = false,
    this.campaigns = const [],
    this.tagCampaignId,
    this.callerIds = const [],
    this.callerId,
    this.setupEditable = true,
    this.recording = false,
    this.countryCode = '+91',
    this.number = '',
    this.numberDisplay = '',
    this.dialPadEnabled = true,
    this.canDial = false,
    this.dialBlockReason,
    this.dialUnavailableReason,
    this.placing = false,
    this.dialError,
    this.focusCallToken = 0,
    this.contact,
    this.fields = const [],
    this.fieldsEditable = true,
    this.requiredFieldsMissing = false,
    this.notes = const NotesView(),
    this.notesEnabled = false,
    this.notesDisabledReason,
    this.outcomes = const [],
    this.outcomeCode,
    this.callbackAt,
    this.padEnabled = false,
    this.padDisabledReason,
    this.padRejection,
    this.saving = false,
    this.outcomeDueAt,
    this.muteTarget = SoftphoneMuteTarget.mic,
    this.muted = false,
    this.micMuted = false,
    this.muteEnabled = false,
    this.audio = const AudioView(),
    this.canHangUp = false,
    this.warnRingingHangUp = false,
    this.hangingUp = false,
    this.hangupFailure,
    this.dncEnabled = false,
    this.dncScopeLabel,
    this.dncInFlight = false,
    this.dncOutcome,
    this.dncFailure,
    this.overridePrompt,
    this.recent = const [],
    this.recentLoading = false,
    this.recentError,
    this.canClose = true,
    this.closeBlockedReason,
    this.canReturn = true,
    this.returnBlockedReason,
    this.sessionBusy = SoftphoneSessionBusy.none,
    this.sessionError,
    this.bootstrapError,
    this.announcement = '',
    this.announcementSeq = 0,
  });

  // ── Screen and connection ──

  /// The Phone tab's state. The station surface ignores it (the station is the host).
  final SoftphoneScreenState screen;

  /// The host's socket. The rail already words it; this is for the Reconnect /
  /// "Use this phone" buttons ([SoftphoneActions.reconnect], [SoftphoneActions.useThisDevice]).
  final StationLink link;

  /// Answered call, socket lost: the server ends the call if the socket is not
  /// back by then. Null while ringing (the call ends at once) and when connected.
  final DateTime? reconnectDeadline;

  // ── The call ──

  final SoftphonePhase phase;

  /// The status band (`describeSoftphoneRail`).
  final SoftphoneRail rail;

  /// The call on screen (live or owing its outcome); null in [SoftphonePhase.ready].
  /// Passed back to [SoftphoneActions.markDnc] so a mark lands on the call the
  /// agent confirmed for.
  final String? callId;

  // ── Finish mode ──

  /// `softphone_enabled` for the account: new calls may start.
  final bool startAllowed;

  /// The soft phone was turned off under the agent (or a dial was refused
  /// `softphone_disabled`): typing, paste, redial and Call do nothing; hang-up,
  /// the outcome, notes and Close / Return still work. See [finishNotice].
  final bool finishOnly;

  // ── Setup (locked once a call is placed) ──

  /// "Log to": the taggable campaigns. Untagged is always offered as well
  /// (`tagCampaignId == null`, label "Don't log to a campaign").
  final List<SoftphoneTagOption> campaigns;

  /// The draft's tag before dialling; the call's tag once dialled. Null: untagged.
  final String? tagCampaignId;

  /// The caller IDs the chosen tag (or untagged) may dial from.
  final List<SoftphoneChoice> callerIds;
  final String? callerId;

  /// Nothing dialled yet and not in finish mode: tag and caller ID may change.
  final bool setupEditable;

  /// The call (or the draft's tag) is recorded: disclose it.
  final bool recording;

  // ── The number and the pad ──

  /// The chip in front of a number typed without one (`default_country_code`).
  final String countryCode;

  /// As typed (digits, `+`, spaces); what [SoftphoneActions.dial] sends.
  final String number;

  /// [number] laid out for reading.
  final String numberDisplay;

  /// The keys, the number field and paste work. False in finish mode and once a call is placed.
  final bool dialPadEnabled;

  /// Call may be pressed now.
  final bool canDial;

  /// Why [number] cannot be called ("That number is too short to call."), or null.
  final String? dialBlockReason;

  /// Why Call is unavailable beyond the number (not connected, a call in progress), or null.
  final String? dialUnavailableReason;

  /// The dial is in flight; a second press does nothing.
  final bool placing;

  /// The last dial's refusal, in words; cleared by the next edit or dial.
  final String? dialError;

  /// Bumped when Call should take focus (a redial filled the pad).
  final int focusCallToken;

  // ── Contact, fields, notes ──

  /// The roster match of the call on screen, or null.
  final SoftphoneContactView? contact;

  /// The account's call fields with their values (empty: none, or not loaded yet).
  final List<SoftphoneFieldView> fields;
  final bool fieldsEditable;

  /// A required field is empty: blocks Save ([SoftphoneSaveBlock.fieldsRequired]).
  final bool requiredFieldsMissing;

  final NotesView notes;
  final bool notesEnabled;

  /// "Notes open when a call starts." while disabled.
  final String? notesDisabledReason;

  // ── The outcome ──

  /// The catalog the call's outcome is saved against.
  final List<DispositionOption> outcomes;

  /// The selected outcome ([SoftphoneActions.selectOutcome]).
  final String? outcomeCode;

  /// The callback time for an outcome that asks for one (device clock).
  final DateTime? callbackAt;

  /// Outcomes may be picked (the customer answered).
  final bool padEnabled;

  /// "Outcomes open when the customer answers." while not.
  final String? padDisabledReason;

  /// The catalog changed under the agent ("This campaign's outcomes changed. Pick one of these.").
  final String? padRejection;
  final bool saving;

  /// When an owed outcome lapses (device clock): "Without one, it closes in m:ss".
  final DateTime? outcomeDueAt;

  // ── Call controls ──

  /// What Mute acts on now ("Mute ring" while ringing).
  final SoftphoneMuteTarget muteTarget;

  /// Whether [muteTarget] is muted.
  final bool muted;

  /// The microphone's own mute, whatever Mute acts on now (the "Muted" pill).
  final bool micMuted;
  final bool muteEnabled;

  /// Route, routes and microphone problems (the host's audio).
  final AudioView audio;
  final bool canHangUp;

  /// SP3: the call rings and its carrier cannot stop the customer's phone
  /// ringing (its `can_cancel_ringing` is not `true`), so hanging up now leaves
  /// it ringing. The warning above hang-up, and the screen reader's confirm
  /// text. False while ringing on a carrier that cancels: hanging up just cancels.
  final bool warnRingingHangUp;
  final bool hangingUp;

  /// A hang-up that failed while the call stays on the line: this screen's
  /// own, else one from CallKit or the notification (the host's).
  final String? hangupFailure;

  // ── Mark DNC ──

  final bool dncEnabled;

  /// "for Q4 Renewals" / "for this account": where the mark reaches.
  final String? dncScopeLabel;
  final bool dncInFlight;

  /// What the server confirmed it recorded, after a mark.
  final String? dncOutcome;
  final String? dncFailure;

  // ── Override prompt ──

  /// Open while a `dnc_listed` / `outside_calling_hours` refusal waits for the agent.
  final SoftphoneOverridePrompt? overridePrompt;

  // ── Recent calls (idle) ──

  final List<SoftphoneRecentCall> recent;
  final bool recentLoading;
  final String? recentError;

  // ── Header: Close (phone) / Return to campaign (station) ──

  /// Close the soft phone: refused while a call is live or owed.
  final bool canClose;
  final String? closeBlockedReason;

  /// Return to the campaign: refused while a call is live or owed.
  final bool canReturn;
  final String? returnBlockedReason;
  final SoftphoneSessionBusy sessionBusy;

  /// The last Close / Return / Switch / Open refusal, in words.
  final String? sessionError;

  /// The bootstrap could not be read (the panel still works from the frames).
  final String? bootstrapError;

  // ── Announcements ──

  /// Assertive: the direct result of something the agent pressed, or the one
  /// thing they must know before speaking ("You are muted. The customer can't
  /// hear you."). The rail is the polite live region.
  final String announcement;

  /// Bumped with every [announcement], so the same sentence twice is announced twice.
  final int announcementSeq;

  // ── Derived ──

  /// A call is on screen (live or owing its outcome).
  bool get callOnScreen => phase != SoftphonePhase.ready;

  /// A call is on the line (not ended).
  bool get callLive =>
      phase == SoftphonePhase.dialing || phase == SoftphonePhase.ringing || phase == SoftphonePhase.onCall;

  /// The first reason Save cannot be pressed at [now] (device clock), or null.
  /// Order as the console's: nothing picked, then the call still live, then
  /// the outcome's own rules, then the required fields.
  SoftphoneSaveBlock? saveBlockAt(DateTime now) {
    final option = outcomes.firstWhereOrNull((o) => o.code == outcomeCode);
    if (option == null) return SoftphoneSaveBlock.noSelection;
    if (phase != SoftphonePhase.outcome) return SoftphoneSaveBlock.callLive;
    if (option.requiresNote && notes.text.trim().isEmpty) return SoftphoneSaveBlock.noteRequired;
    if (option.requiresCallbackTime) {
      final at = callbackAt;
      if (at == null) return SoftphoneSaveBlock.callbackRequired;
      if (!at.isAfter(now)) return SoftphoneSaveBlock.callbackInPast;
    }
    if (requiredFieldsMissing) return SoftphoneSaveBlock.fieldsRequired;
    return null;
  }

  /// What is left before an owed outcome lapses, at [now]; null when none is owed.
  Duration? outcomeTimeLeft(DateTime now) {
    final due = outcomeDueAt;
    if (due == null || phase != SoftphonePhase.outcome) return null;
    final left = due.difference(now);
    return left.isNegative ? Duration.zero : left;
  }

  /// The finish-mode notice for [surface], or null outside finish mode.
  String? finishNotice(SoftphoneSurface surface) {
    if (!finishOnly) return null;
    return callOnScreen ? softphoneFinishCallCopy : softphoneFinishIdleCopy[surface];
  }

  static const _eqT = ListEquality<SoftphoneTagOption>();
  static const _eqC = ListEquality<SoftphoneChoice>();
  static const _eqF = ListEquality<SoftphoneFieldView>();
  static const _eqD = ListEquality<DispositionOption>();
  static const _eqR = ListEquality<SoftphoneRecentCall>();

  @override
  bool operator ==(Object other) =>
      other is SoftphoneView &&
      other.screen == screen &&
      other.link == link &&
      other.reconnectDeadline == reconnectDeadline &&
      other.phase == phase &&
      other.rail == rail &&
      other.callId == callId &&
      other.startAllowed == startAllowed &&
      other.finishOnly == finishOnly &&
      _eqT.equals(other.campaigns, campaigns) &&
      other.tagCampaignId == tagCampaignId &&
      _eqC.equals(other.callerIds, callerIds) &&
      other.callerId == callerId &&
      other.setupEditable == setupEditable &&
      other.recording == recording &&
      other.countryCode == countryCode &&
      other.number == number &&
      other.numberDisplay == numberDisplay &&
      other.dialPadEnabled == dialPadEnabled &&
      other.canDial == canDial &&
      other.dialBlockReason == dialBlockReason &&
      other.dialUnavailableReason == dialUnavailableReason &&
      other.placing == placing &&
      other.dialError == dialError &&
      other.focusCallToken == focusCallToken &&
      other.contact == contact &&
      _eqF.equals(other.fields, fields) &&
      other.fieldsEditable == fieldsEditable &&
      other.requiredFieldsMissing == requiredFieldsMissing &&
      other.notes == notes &&
      other.notesEnabled == notesEnabled &&
      other.notesDisabledReason == notesDisabledReason &&
      _eqD.equals(other.outcomes, outcomes) &&
      other.outcomeCode == outcomeCode &&
      other.callbackAt == callbackAt &&
      other.padEnabled == padEnabled &&
      other.padDisabledReason == padDisabledReason &&
      other.padRejection == padRejection &&
      other.saving == saving &&
      other.outcomeDueAt == outcomeDueAt &&
      other.muteTarget == muteTarget &&
      other.muted == muted &&
      other.micMuted == micMuted &&
      other.muteEnabled == muteEnabled &&
      other.audio == audio &&
      other.canHangUp == canHangUp &&
      other.warnRingingHangUp == warnRingingHangUp &&
      other.hangingUp == hangingUp &&
      other.hangupFailure == hangupFailure &&
      other.dncEnabled == dncEnabled &&
      other.dncScopeLabel == dncScopeLabel &&
      other.dncInFlight == dncInFlight &&
      other.dncOutcome == dncOutcome &&
      other.dncFailure == dncFailure &&
      other.overridePrompt == overridePrompt &&
      _eqR.equals(other.recent, recent) &&
      other.recentLoading == recentLoading &&
      other.recentError == recentError &&
      other.canClose == canClose &&
      other.closeBlockedReason == closeBlockedReason &&
      other.canReturn == canReturn &&
      other.returnBlockedReason == returnBlockedReason &&
      other.sessionBusy == sessionBusy &&
      other.sessionError == sessionError &&
      other.bootstrapError == bootstrapError &&
      other.announcement == announcement &&
      other.announcementSeq == announcementSeq;

  @override
  int get hashCode => Object.hashAll([
    screen,
    link,
    phase,
    rail,
    callId,
    finishOnly,
    tagCampaignId,
    callerId,
    number,
    placing,
    dialError,
    contact,
    notes,
    outcomeCode,
    callbackAt,
    saving,
    muted,
    audio,
    hangingUp,
    overridePrompt,
    recent.length,
    sessionBusy,
    announcementSeq,
  ]);
}

// ─── Copy the view's own derivations use ────────────────────────────────────
//
// Kept here, beside the methods that pick them, so the core and the UI cannot
// word a block differently. The console's sentences (`SAVE_BLOCK_COPY`,
// `SOFTPHONE_FINISH_*_COPY`), with the mobile substitutions.

const Map<SoftphoneSaveBlock, String> softphoneSaveBlockCopy = {
  SoftphoneSaveBlock.noSelection: 'Pick an outcome to save this call.',
  SoftphoneSaveBlock.callLive: 'Save unlocks when the call ends.',
  SoftphoneSaveBlock.noteRequired: 'This disposition needs a note.',
  SoftphoneSaveBlock.callbackRequired: 'This disposition needs a callback time.',
  SoftphoneSaveBlock.callbackInPast: 'That time has already passed. Pick when we should call back.',
  SoftphoneSaveBlock.fieldsRequired: 'Fill in the required call details first.',
};

/// Finish mode with a call on screen: what still works, and what does not.
const softphoneFinishCallCopy =
    'The soft phone has been turned off for this account. Finish this call; you can’t start new ones.';

/// Finish mode with nothing left to finish, by surface: the way out is the surface's.
const Map<SoftphoneSurface, String> softphoneFinishIdleCopy = {
  SoftphoneSurface.phone:
      'The soft phone has been turned off for this account, so you can’t start new calls. Close the soft phone when you’re done.',
  SoftphoneSurface.station:
      'The soft phone has been turned off for this account, so you can’t start new calls. Return to your campaign when you’re ready.',
};

// ─── Actions ────────────────────────────────────────────────────────────────

/// Everything the Phone screen and the soft-phone panel can ask for.
///
/// Like `StationActions`: each returns when the server answered, and refusals
/// land in the view ([SoftphoneView.dialError], [SoftphoneView.sessionError],
/// [SoftphoneView.overridePrompt], [SoftphoneView.announcement], …) while the
/// future completes normally, so a screen never needs try/catch for an
/// expected case. Every action is a no-op when the view says it is unavailable
/// (finish mode, a call in the way, one already in flight).
abstract interface class SoftphoneActions {
  // ── The Phone tab's session ──

  /// Opens the soft phone (or resumes this account's session). The UI has
  /// already asked for the microphone and notification permissions. The
  /// result lands in [SoftphoneView.screen]. On [SoftphoneScreenOtherDevice]
  /// it is "Use it on this phone": the session (or the campaign station on the
  /// soft phone) is taken over here.
  Future<void> open();

  /// Re-reads the bootstrap (and re-tries a failed open) after
  /// [SoftphoneScreenError] or a [SoftphoneView.bootstrapError].
  Future<void> retry();

  /// Closes the hosted soft-phone session (the Phone surface's header).
  /// Refused while a call is live or its outcome is owed. On
  /// [SoftphoneScreenOtherDevice] with [SoftphoneScreenOtherDevice.canClose]
  /// it is "Close it": the session open on the other device is closed.
  Future<void> close();

  /// [SoftphoneScreenElsewhere]: closes the agent's soft-phone session in its
  /// own account (refused while its call is unfinished), then opens one here.
  Future<void> closeElsewhereAndOpen();

  /// [SoftphoneScreenOffStranded]: closes the session in its own account.
  Future<void> closeStranded();

  /// [SoftphoneScreenOnCampaign] with [SoftphoneScreenOnCampaign.hostedHere]:
  /// switches that campaign session to the soft phone (queued behind a call or
  /// wrap-up). True when it was applied or queued: the UI then goes to the station.
  Future<bool> switchToSoftphone();

  /// Asks the app to switch workspace to [accountId] (where the agent's live
  /// session is). The account switcher's own rules still apply; nothing
  /// happens when the switch is refused.
  Future<void> requestAccountSwitch(String accountId);

  // ── The station surface (SP7) ──

  /// Back to the campaign (`available`). Refused while a call is live or owed
  /// ([SoftphoneView.canReturn]).
  Future<void> returnToCampaign();

  /// Withdraws a switch to the soft phone still queued behind a call.
  Future<void> cancelSwitch();

  // ── The number ──

  /// Replaces the number with what the field holds now (typing, deleting).
  void setNumber(String raw);

  /// One dial-pad key: `0`–`9`, `+` (long-press 0), `*`, `#`.
  void pressKey(String key);

  /// Deletes the last character.
  void backspace();

  /// Clears the number.
  void clearNumber();

  /// A paste (or an IME commit of two or more characters at once): the text is
  /// normalised as a pasted number (`tel:` links, `(0)`, separators) rather
  /// than typed key by key.
  void pasteNumber(String raw);

  /// Places the call. One dial in flight: a second press while placing does
  /// nothing, and a dial is never retried (a timeout re-reads the bootstrap
  /// and says the call may have been placed).
  Future<void> dial();

  /// Fills the pad from a recent call (number, its tag while still taggable,
  /// its caller ID) and bumps [SoftphoneView.focusCallToken]. Never dials.
  void redial(String recentCallId);

  // ── Setup ──

  /// The tag before dialling; null logs to no campaign. Changing it resets the
  /// caller ID to the tag's default.
  void setTag(String? campaignId);
  void setCallerId(String callerId);

  // ── During and after the call ──

  /// One call field's value: `String`, `num`, `bool`, or null to empty it.
  /// Autosaved (debounced) while a call is on screen; sent with the dial before.
  void setFieldValue(String key, Object? value);

  /// The notes, on every keystroke (debounced and kept on the phone until saved).
  void setNotes(String text);

  /// Picks an outcome on the pad (keeps a callback time already chosen).
  void selectOutcome(String code);

  /// The callback time for an outcome that asks for one (device clock), or null.
  void setCallback(DateTime? at);

  /// Saves the outcome (with the fields and the notes). Checks
  /// [SoftphoneView.saveBlockAt] first.
  Future<void> saveOutcome();

  /// Hangs up the call on screen (the UI holds to confirm; while ringing it
  /// warns that the customer's phone may keep ringing).
  Future<void> hangUp();

  /// Mute: the ringback while ringing, the microphone otherwise ([SoftphoneView.muteTarget]).
  Future<void> toggleMute();

  Future<void> setRoute(AudioRouteOption route);

  /// Marks the dialled number Do Not Call ([SoftphoneView.dncScopeLabel]).
  /// [callId] is the call the agent confirmed for: when the call on screen is
  /// another one by then, nothing is marked.
  Future<void> markDnc({String? reason, required String callId});

  // ── The override prompt ──

  /// "Call anyway" with the agent's reason: redials with the overrides already
  /// given plus this one.
  Future<void> confirmOverride(String note);

  /// "Don't call": closes the prompt; nothing is dialled.
  void cancelOverride();

  // ── Connection (the host's) ──

  Future<void> reconnect();

  /// After another device took the session (4409): take it back here.
  Future<void> useThisDevice();

  // ── Housekeeping ──

  Future<void> reloadRecent();
  void dismissDialError();
  void dismissSessionError();
}

/// The Phone tab's visibility, and whether new calls may start.
///
/// Visible when the bootstrap answered 200 and (the soft phone is on, or there
/// is a session or call here to finish), or the host holds a soft-phone session
/// or a campaign session on the soft phone. A 403 (no dial permission), or no
/// answer yet, is hidden: the app keeps no role matrix of its own.
@immutable
class SoftphoneAvailability {
  const SoftphoneAvailability({this.visible = false, this.startAllowed = false, this.loaded = false});

  /// Hidden, not yet known.
  static const hidden = SoftphoneAvailability();

  /// Show the Phone tab (and the soft-phone entries on the station).
  final bool visible;

  /// New calls may start (`softphone_enabled`); false with [visible] is finish mode.
  final bool startAllowed;

  /// The bootstrap has answered at least once for this workspace.
  final bool loaded;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneAvailability &&
      other.visible == visible &&
      other.startAllowed == startAllowed &&
      other.loaded == loaded;
  @override
  int get hashCode => Object.hash(visible, startAllowed, loaded);
}

/// The soft phone, as the screens read it. Overridden by the soft-phone core
/// (`softphoneOverrides`); the default is a soft phone that has not loaded.
final softphoneViewProvider = Provider<SoftphoneView>((ref) => const SoftphoneView());

final softphoneActionsProvider = Provider<SoftphoneActions>(
  (ref) => throw UnimplementedError('softphoneActionsProvider is provided by the soft-phone core'),
);

/// Whether the Phone tab shows. Overridden by the soft-phone core; hidden by default.
final softphoneAvailabilityProvider = Provider<SoftphoneAvailability>((ref) => SoftphoneAvailability.hidden);
