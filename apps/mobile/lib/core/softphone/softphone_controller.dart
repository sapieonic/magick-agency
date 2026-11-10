import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:collection/collection.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;

import '../../features/performance/logic/stats_windows.dart' show DeviceCalendar, LocalCalendar;
import '../../features/preflight/preflight_checks.dart' show MicPermission, preflightChecksProvider;
import '../api/api_error.dart';
import '../auth/app_gate.dart';
import '../lifecycle/app_lifecycle.dart';
import '../station/contact_context.dart';
import '../station/disposition_rules.dart';
import '../station/server_clock.dart';
import '../station/station_copy.dart' show agentStateLabel, catalogChangedCopy;
import '../station/station_deps.dart' show notesStoreProvider, stationNowProvider;
import '../station/station_view.dart';
import '../telemetry/call_telemetry.dart';
import '../telemetry/log.dart';
import '../telemetry/telemetry.dart';
import 'call_fields.dart';
import 'call_labels.dart';
import 'call_state.dart';
import 'hosted_here.dart';
import 'manual_autosave.dart';
import 'overrides.dart';
import 'phone_input.dart';
import 'refusal_copy.dart';
import 'softphone_api.dart';
import 'softphone_copy.dart';
import 'softphone_host.dart';
import 'softphone_view.dart';

/// The soft phone's call domain: a port of the console's `useSoftphone` (and
/// the session states of its `useSoftphoneSession`), on top of a session host
/// someone else owns.
///
/// ── One host, read through a seam ───────────────────────────────────────────
/// The station controller hosts the session (soft-phone or campaign), its
/// socket, its microphone and its on-duty service; this controller never
/// touches any of them. It reads [softphoneHostViewProvider] (the merged
/// manual call, the connection, the clock offset, the audio) and asks
/// [SoftphoneHostActions] for anything that belongs to the session. HTTP
/// answers go back through `adoptManualCall`, so the router's hold and the
/// audio never depend on this controller being alive.
///
/// ── Per workspace, never auto-disposed ──────────────────────────────────────
/// Built once per `user:tenant:account` ([agentWorkspaceProvider]) like the
/// app's other per-workspace state: an account switch or another agent
/// signing in drops every draft, the bootstrap and the recent calls, and
/// re-reads the bootstrap. It is not auto-disposed: the Phone tab's
/// visibility ([softphoneAvailabilityProvider]) keeps it alive from the shell,
/// and a reconnect's bootstrap re-read must not be lost to a tab change.
///
/// ── Finish mode ─────────────────────────────────────────────────────────────
/// With `softphone_enabled` off (the bootstrap says so, or a dial was refused
/// `softphone_disabled`), every input that STARTS work (typing, paste, redial,
/// Call) does nothing, and the call, hang-up, the outcome, the notes and Close
/// or Return keep working: the server keeps the routes that finish work open.
///
/// ── The frames are the authority ────────────────────────────────────────────
/// The call on screen is the host's merged copy. The bootstrap is re-read on a
/// reconnect because a call that settled while the socket was away sends no
/// frame into the new one: its `call: null` retires the copy held when it was
/// asked for (`retireManualCall` by version key), and a newer frame survives.
///
/// ── When the bootstrap is read ──────────────────────────────────────────────
/// On a workspace change (at gate-ready too), on return to the app at most
/// every [resumeRereadAfter] (and always for a resume put off in the
/// background), when the host starts holding a new session, when a station
/// switches to the soft phone, after the hosted session closes, after a
/// reconnect, after `softphone_disabled` (and the other refusals that mean
/// what may be dialled changed), and after a `fields_invalid` naming a field
/// this phone does not know.
///
/// ── Resuming only what this phone hosted ────────────────────────────────────
/// A session the bootstrap names resumes by itself only when it is the one
/// this phone last hosted ([HostedHere]). One opened on the web or on another
/// phone waits for the agent's "Use it on this phone": rehydrating it here
/// would take it, and any call on it, away from wherever the agent is using it.
final softphoneControllerProvider = NotifierProvider<SoftphoneController, SoftphoneCoreState>(SoftphoneController.new);

/// Its own app-lifecycle source: the station's attaches one listener to its
/// source, and a second attach to the same one would replace it.
final softphoneLifecycleSourceProvider = Provider<AppLifecycleSource>((ref) => FlutterAppLifecycleSource());

/// The reader's calendar, for the calling-hours prompt; tests pin a zone.
final softphoneCalendarProvider = Provider<LocalCalendar>((ref) => const DeviceCalendar());

/// What `main.dart` adds to its `ProviderScope` overrides to plug the soft-phone
/// core into the seams the screens and the shell read.
final List<Override> softphoneOverrides = [
  softphoneViewProvider.overrideWith((ref) => ref.watch(softphoneControllerProvider.select((s) => s.view))),
  softphoneActionsProvider.overrideWith((ref) => ref.watch(softphoneControllerProvider.notifier)),
  softphoneAvailabilityProvider.overrideWith(
    (ref) => ref.watch(softphoneControllerProvider.select((s) => s.availability)),
  ),
];

/// The controller's state: what the screens render, and whether the Phone tab shows.
@immutable
class SoftphoneCoreState {
  const SoftphoneCoreState({this.view = const SoftphoneView(), this.availability = SoftphoneAvailability.hidden});

  final SoftphoneView view;
  final SoftphoneAvailability availability;

  @override
  bool operator ==(Object other) =>
      other is SoftphoneCoreState && other.view == view && other.availability == availability;

  @override
  int get hashCode => Object.hash(view, availability);
}

/// How long a bootstrap read on return to the app is good for.
const resumeRereadAfter = Duration(minutes: 5);

/// The recent calls on the idle pad.
const softphoneRecentLimit = 8;

/// What the bootstrap answered for this workspace.
enum _Reach {
  /// Not answered yet (or only failed).
  none,

  /// 200.
  ok,

  /// 403: no `agency.softphone.dial`. The Phone tab stays hidden.
  forbidden,
}

/// The override prompt waiting for the agent: what it says, the overrides
/// already given in this dial (kept when a second refusal of the other kind
/// arrives), and the number the server refused: "Call anyway" redials that
/// one, whatever the pad holds by then.
final class _Override {
  const _Override(this.prompt, this.overrides, this.to);
  final SoftphoneOverridePrompt prompt;
  final ManualCallOverridesRequest overrides;
  final String to;
}

/// How long a Missed call's Call back waits for the soft phone to take it
/// ([SoftphoneController.callBack]). Time spent behind a call on screen does
/// not count: the clock starts again when that call settles.
const callBackWaitsFor = Duration(minutes: 5);

/// A Missed call's Call back waiting for the pad.
final class _CallBack {
  _CallBack(this.number, this.campaignId, this.askedAt, this.sessionId);
  final String number;
  final String? campaignId;

  /// When it was asked for, or when the call it waited behind settled.
  DateTime askedAt;

  /// The session it is for: the one hosted when it was asked for, else the
  /// first one to open after. Any other session change drops it.
  String? sessionId;

  /// A call on screen held it at the last look.
  bool behindCall = false;
}

class SoftphoneController extends Notifier<SoftphoneCoreState> implements SoftphoneActions {
  static final _log = Log('softphone');

  /// Bumped on every build (a workspace change): an answer for the previous
  /// workspace is told apart by this, since the notifier outlives a rebuild.
  int _epoch = 0;
  bool _building = false;

  // ── Workspace ──
  String? _workspace;
  late ManualAutosave _autosave;
  AppLifecycleSource? _lifecycle;

  // ── Bootstrap ──
  SoftphoneBootstrap? _bootstrap;
  _Reach _reach = _Reach.none;
  String? _bootstrapError;
  int _bootstrapSeq = 0;
  DateTime? _bootstrapReadAt;

  /// The hosted session when the bootstrap held now was asked for, and
  /// whether it was on the soft phone then: the SP7 preset is judged only on
  /// an answer asked for that session on the soft phone.
  String? _bootstrapFor;
  bool _bootstrapOnSoftphone = false;

  /// A reconciling read is in flight (see [_loadBootstrap]'s `reconcile`).
  bool _reconcileAsked = false;
  bool _resumeTried = false;
  bool _resumePending = false;

  // ── The host ──
  SoftphoneHostView? _host;
  ManualCall? _prevCall;
  SoftphonePhase _prevPhase = SoftphonePhase.ready;
  String? _hydratedFor;
  ManualCall? _lastCall;
  ({String callId, String? name})? _nameSent;

  /// What [HostedHere] was last told this phone hosts.
  ({String workspace, String sessionId})? _hosted;

  // ── The Phone tab's screen, when no session is hosted ──
  SoftphoneScreenState _screen = const SoftphoneScreenLoading();
  String? _screenSessionId;
  bool _errorFromOpen = false;
  bool _micBlocked = false;
  SoftphoneSessionBusy _sessionBusy = SoftphoneSessionBusy.none;
  String? _sessionError;

  // ── The draft ──
  String _number = '';
  String? _tagDraft;
  String? _callerDraft;
  Map<String, Object?> _fieldValues = const {};
  Map<String, String> _fieldErrors = const {};
  bool _fieldsTouched = false;
  String? _presetFor;

  /// A Missed call's Call back waiting for the soft phone ([callBack]).
  _CallBack? _pendingCallBack;

  /// How the number got onto the pad, for `agency_softphone_call_placed`
  /// (the console's `entry`): `typed`, `pasted`, `redial` or `inbound_callback`.
  String _entry = 'typed';
  bool _disabledSeen = false;
  int? _disabledAtSeq;

  // ── Dial ──
  bool _placing = false;
  String? _dialError;

  /// The call an `outcome_pending` / `manual_call_live` refusal named: its
  /// arrival on screen keeps the refusal's sentence.
  String? _refusedFor;
  _Override? _override;
  String? _overrideError;
  int _focusCallToken = 0;

  // ── Outcome ──
  String? _outcomeCode;
  DateTime? _callbackAt;
  ({String callId, List<Disposition> catalog})? _catalogOverride;
  String? _padRejection;
  bool _saving = false;

  // ── Controls ──
  bool _hangingUp = false;
  String? _hangupFailure;
  bool _dncInFlight = false;
  String? _dncOutcome;
  String? _dncFailure;

  // ── Recent calls ──
  List<ManualCall> _recent = const [];
  bool _recentLoading = false;
  String? _recentError;
  int _recentSeq = 0;

  // ── Announcements ──
  String _announcement = '';
  int _announcementSeq = 0;

  // ── Mapping caches ──
  List<Disposition>? _optionsSource;
  List<DispositionOption> _options = const [];

  SoftphoneApi get _api => ref.read(softphoneApiProvider);
  SoftphoneHostActions get _actions => ref.read(softphoneHostActionsProvider);
  DateTime _now() => ref.read(stationNowProvider)();

  @override
  SoftphoneCoreState build() {
    _building = true;
    final workspace = ref.watch(agentWorkspaceProvider);
    final epoch = ++_epoch;
    _resetForWorkspace();
    _workspace = workspace;
    _autosave = ManualAutosave(
      save: (id, request) => _api.updateCall(id, request, accountId: _host?.accountId),
      request: _autosaveRequest,
      store: ref.read(notesStoreProvider),
      onChanged: _emit,
      onSaved: _adopt,
      onFailed: _onAutosaveFailed,
      now: _now,
    );
    _host = ref.read(softphoneHostViewProvider);
    ref.listen<SoftphoneHostView?>(softphoneHostViewProvider, (_, next) => _onHost(next));
    ref.listen<AppGate>(appGateProvider, (_, _) => _emit());
    final lifecycle = ref.read(softphoneLifecycleSourceProvider);
    _lifecycle = lifecycle;
    lifecycle.attach(onHide: _onHide, onShow: _onShow);
    final autosave = _autosave;
    ref.onDispose(() {
      lifecycle.detach();
      unawaited(autosave.persistNow());
      autosave.dispose();
    });
    _syncCall();
    if (workspace != null) {
      unawaited(Future.microtask(() {
        if (epoch == _epoch) _start();
      }));
    }
    _building = false;
    return _compute();
  }

  void _resetForWorkspace() {
    _bootstrap = null;
    _reach = _Reach.none;
    _bootstrapError = null;
    _bootstrapReadAt = null;
    _bootstrapFor = null;
    _bootstrapOnSoftphone = false;
    _reconcileAsked = false;
    _resumeTried = false;
    _resumePending = false;
    _prevCall = null;
    _prevPhase = SoftphonePhase.ready;
    _hydratedFor = null;
    _lastCall = null;
    _nameSent = null;
    _screen = const SoftphoneScreenLoading();
    _screenSessionId = null;
    _errorFromOpen = false;
    _sessionBusy = SoftphoneSessionBusy.none;
    _sessionError = null;
    _clearDraft();
    _tagDraft = null;
    _presetFor = null;
    _pendingCallBack = null;
    _disabledSeen = false;
    _disabledAtSeq = null;
    _placing = false;
    _dialError = null;
    _override = null;
    _overrideError = null;
    _saving = false;
    _hangingUp = false;
    _dncInFlight = false;
    _recent = const [];
    _recentLoading = false;
    _recentError = null;
    _announcement = '';
  }

  /// Back to an empty pad (a call settled, or a new workspace). The tag stays:
  /// the next call is most likely logged where the last one was.
  void _clearDraft() {
    _number = '';
    _entry = 'typed';
    _callerDraft = null;
    _fieldValues = const {};
    _fieldErrors = const {};
    _fieldsTouched = false;
    _outcomeCode = null;
    _callbackAt = null;
    _catalogOverride = null;
    _padRejection = null;
    _hangupFailure = null;
    _dncOutcome = null;
    _dncFailure = null;
  }

  void _start() {
    unawaited(_sweepNotes());
    unawaited(_checkMicrophone());
    unawaited(_loadBootstrap(initial: true));
  }

  Future<void> _sweepNotes() async {
    try {
      await ref.read(notesStoreProvider).sweep(_now());
    } catch (_) {}
  }

  // ─── Derived facts ────────────────────────────────────────────────────────

  String? get _accountId {
    final gate = ref.read(appGateProvider);
    return gate is GateReady ? gate.accountId : null;
  }

  String? get _userId {
    final gate = ref.read(appGateProvider);
    return gate is GateReady ? gate.userId : null;
  }

  /// The session's unsettled call (live, or ended and owing its outcome), or null.
  ManualCall? get _call {
    final c = _host?.call;
    return isCallUnsettled(c) ? c : null;
  }

  SoftphonePhase get _phase => softphonePhase(_call);

  List<CallField> get _fields => _bootstrap?.callFields ?? const [];

  /// The field set is known. Until the bootstrap lands the fields are empty
  /// because nothing has said what they are, not because the account has none,
  /// and `fields` on the wire REPLACES the stored values: so no request
  /// carries `fields` before this is true.
  bool get _fieldsKnown => _bootstrap != null;

  bool get _finishOnly => _bootstrap?.softphoneEnabled == false || _disabledSeen;

  bool get _setupEditable => _call == null && !_placing && !_finishOnly;

  SoftphoneSurface get _surface =>
      _host?.kind == SessionKind.campaign ? SoftphoneSurface.station : SoftphoneSurface.phone;

  String get _countryCode => _bootstrap?.defaultCountryCode ?? '+91';

  SoftphoneCampaign? get _draftCampaign => _bootstrap?.taggable(_tagDraft);

  /// The campaign the screen is about: the call's tag (taggable, else the
  /// bootstrap's `call_campaign` when it describes it), else the draft's.
  SoftphoneCampaign? get _campaign {
    final b = _bootstrap;
    if (b == null) return null;
    final call = _call;
    if (call == null) return b.taggable(_tagDraft);
    final tag = call.tag;
    if (tag == null) return null;
    return b.taggable(tag.campaignId) ?? (b.callCampaign?.campaignId == tag.campaignId ? b.callCampaign : null);
  }

  List<String> get _draftCallerIds {
    final b = _bootstrap;
    if (b == null) return const [];
    if (_tagDraft != null) return _draftCampaign?.callerIds ?? const [];
    return b.untagged.callerIds;
  }

  /// The tag's first number, else the untagged default while still listed, else the first.
  String? get _draftCallerId {
    final options = _draftCallerIds;
    final draft = _callerDraft;
    if (draft != null && options.contains(draft)) return draft;
    final campaign = _draftCampaign;
    if (campaign != null) return campaign.callerIds.firstOrNull;
    final untaggedDefault = _bootstrap?.untagged.defaultCallerId;
    if (untaggedDefault != null && options.contains(untaggedDefault)) return untaggedDefault;
    return options.firstOrNull;
  }

  /// The tag's catalog, else `call_campaign`'s, else the untagged one; a
  /// `disposition_invalid` resync for this call wins.
  List<Disposition> get _catalog {
    final call = _call;
    final b = _bootstrap;
    final override = _catalogOverride;
    if (call != null && override != null && override.callId == call.id) return override.catalog;
    if (b == null) return const [];
    final tag = call?.tag;
    if (tag == null) return b.untagged.dispositionCatalog;
    return b.taggable(tag.campaignId)?.dispositionCatalog ??
        (b.callCampaign?.campaignId == tag.campaignId ? b.callCampaign!.dispositionCatalog : null) ??
        b.untagged.dispositionCatalog;
  }

  bool get _dncEnabled {
    final phase = _phase;
    return _call != null &&
        (phase == SoftphonePhase.onCall || phase == SoftphonePhase.outcome || phase == SoftphonePhase.ringing);
  }

  String? get _dialUnavailableReason {
    if (_finishOnly) return _call != null ? softphoneFinishCallCopy : softphoneFinishIdleCopy[_surface];
    final host = _host;
    if (host?.link != StationLink.open) return softphoneWaitForConnectionCopy;
    if (_bootstrap == null || host == null) return softphoneLoadingCopy;
    if (host.kind == SessionKind.campaign && !host.onSoftphone) return softphoneNotSwitchedYetCopy;
    final call = _call;
    if (call != null) return _phase == SoftphonePhase.outcome ? softphoneSaveBeforeDialCopy : softphoneCallInProgressCopy;
    if (_draftCallerIds.isEmpty) return softphoneNoCallerIdCopy;
    return null;
  }

  bool get _canDial => _dialUnavailableReason == null && dialBlockReason(_number) == null && !_placing;

  /// Typing, paste and the pad: locked while a dial is in flight too, so the
  /// number on screen is the one the server is answering about.
  bool get _dialPadEnabled => !_finishOnly && _call == null && !_placing;

  /// Something here to finish with the soft phone off: a soft-phone session
  /// (here, or stranded in another account), or a campaign session here on the
  /// soft phone with an unsettled call.
  bool _somethingToFinish(SoftphoneBootstrap b) {
    final s = b.session;
    if (s == null) return false;
    if (s.kind == SessionKind.softphone) return true;
    return s.onSoftphone && s.accountId == _accountId && b.call != null;
  }

  // ─── The host ─────────────────────────────────────────────────────────────

  void _onHost(SoftphoneHostView? next) {
    final prev = _host;
    _host = next;
    _trackHostedHere(next);
    if (prev?.sessionId != next?.sessionId) {
      // A waiting Call back is for the session hosted when it was asked for,
      // else the first to open after it: never a later one, whose pad (and
      // "Log to") it would otherwise fill out of nowhere.
      final pending = _pendingCallBack;
      if (pending != null) {
        if (pending.sessionId == null && prev == null && next != null) {
          pending.sessionId = next.sessionId;
        } else {
          _pendingCallBack = null;
        }
      }
      if (next == null) {
        // The station (or the soft-phone session) closed: where things stand now is the bootstrap's.
        _screen = const SoftphoneScreenClosed();
        _screenSessionId = null;
        unawaited(_loadBootstrap());
      } else {
        if (_screen is SoftphoneScreenOpening) _screen = const SoftphoneScreenClosed();
        // A new session starts from a clean setup: the last one's tag (a
        // station's campaign) and caller ID are not this one's.
        _tagDraft = null;
        _callerDraft = null;
        // Read for this session, in its own account: the campaigns, caller IDs
        // and fields may have changed since the last read (a campaign staffed
        // since is the station's preset tag only once the bootstrap says so).
        // The host has just loaded the session's call, so nothing is reconciled.
        unawaited(_loadBootstrap(reconcile: false));
      }
    } else if (next != null && prev != null) {
      if (next.link == StationLink.open && prev.link != StationLink.open && prev.everOpened) {
        // A reconnect, not the first open: a call that settled meanwhile sent no frame.
        unawaited(_loadBootstrap());
      } else if (next.onSoftphone && !prev.onSoftphone) {
        // A station switched to the soft phone: what it may dial and log to is read now.
        unawaited(_loadBootstrap(reconcile: false));
      }
    }
    _applyPreset();
    _syncCall();
    _emit();
  }

  /// Keeps [HostedHere] in step with the host: this phone hosts a session
  /// while the host holds it and no other device has taken it (4409).
  void _trackHostedHere(SoftphoneHostView? next) {
    final hosting = next != null && next.link != StationLink.superseded ? next : null;
    final workspace = hosting == null ? null : _workspaceFor(hosting.accountId);
    final was = _hosted;
    if (was != null && was.sessionId == hosting?.sessionId && was.workspace == workspace) return;
    final memory = ref.read(hostedHereProvider);
    // Another session in the same workspace overwrites; otherwise the old one is forgotten.
    if (was != null && was.workspace != workspace) unawaited(memory.forget(was.workspace, was.sessionId));
    _hosted = null;
    if (hosting != null && workspace != null) {
      _hosted = (workspace: workspace, sessionId: hosting.sessionId);
      unawaited(memory.remember(workspace, hosting.sessionId));
    }
  }

  /// `user:tenant:account` for [accountId] (else the gate's account), as [agentWorkspaceProvider] spells it.
  String? _workspaceFor(String? accountId) {
    final gate = ref.read(appGateProvider);
    if (gate is! GateReady) return null;
    return '${gate.userId}:${gate.tenantId}:${accountId ?? gate.accountId}';
  }

  /// A call arriving, a call settling, and the moment it is answered.
  void _syncCall() {
    final call = _call;
    final prev = _prevCall;
    if (call != null && _hydratedFor != call.id) {
      if (prev != null && prev.id != call.id) _settled(prev);
      _hydratedFor = call.id;
      _fieldsTouched = false;
      // A call not placed from this screen (a restart, a reconnect, the web):
      // take what the server holds. One placed here already matches the draft.
      // (Before the field set is known this compares against nothing; the
      // field set arriving hydrates again, see [_loadBootstrap].)
      if (!sameFieldValues(_fields, _fieldValues, call.fields)) _fieldValues = Map.of(call.fields);
      _autosave.callChanged(call.id, serverNotes: call.notes, accepting: true);
      if (_number.isEmpty) _number = call.destinationE164;
      _outcomeCode = call.dispositionCode;
      _callbackAt = null;
      _padRejection = null;
      _hangupFailure = null;
      _dncOutcome = null;
      _dncFailure = null;
      // A dial refused because of this very call keeps saying so.
      if (_refusedFor != call.id) _dialError = null;
      _refusedFor = null;
    } else if (call == null && prev != null) {
      _settled(prev);
      _hydratedFor = null;
      _autosave.callChanged(null, accepting: false);
    }
    _prevCall = call;

    final phase = softphonePhase(call);
    if (phase == SoftphonePhase.onCall && _prevPhase != SoftphonePhase.onCall && (_host?.audio.muted ?? false)) {
      _announce(softphoneMutedAtAnswerCopy);
    }
    _prevPhase = phase;
  }

  /// Settled (outcome saved, lapsed, or an unanswered call closed): back to Ready.
  void _settled(ManualCall prev) {
    final held = _host?.call;
    _lastCall = held != null && held.id == prev.id ? held : prev;
    _clearDraft();
    if (!_building) unawaited(_loadRecent());
  }

  /// SP7: the station's campaign is the tag, once the bootstrap confirms it is
  /// taggable. Judged once per session, on an answer asked for while that
  /// station was on the soft phone: one read before then may predate the
  /// agent's staffing on it.
  void _applyPreset() {
    final host = _host;
    final b = _bootstrap;
    if (host == null || b == null || host.kind != SessionKind.campaign || !host.onSoftphone) return;
    if (_bootstrapFor != host.sessionId || !_bootstrapOnSoftphone) return;
    if (_presetFor == host.sessionId) return;
    _presetFor = host.sessionId;
    final campaignId = host.campaignId;
    if (campaignId != null && b.taggable(campaignId) != null && _call == null) {
      _tagDraft = campaignId;
      _callerDraft = null;
    }
  }

  void _adopt(ManualCall call) {
    final host = _host;
    if (host == null || call.sessionId != host.sessionId) return;
    _actions.adoptManualCall(call);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  void _onHide() => unawaited(_autosave.persistNow());

  void _onShow() {
    if (_workspace == null) return;
    // The agent may have allowed the microphone in Settings while away.
    unawaited(_checkMicrophone());
    if (_resumePending) {
      _resumePending = false;
      // Settled from a fresh answer, never the one read in the background: that
      // may be hours old, and its session closed since (a resume would then open a new one).
      if (_host == null) unawaited(_loadBootstrap(initial: true));
      return;
    }
    final readAt = _bootstrapReadAt;
    if (readAt == null || _now().difference(readAt) >= resumeRereadAfter) unawaited(_loadBootstrap());
  }

  /// Whether the microphone is refused for good (permanently denied, or
  /// restricted): the closed screen then offers the system settings instead of
  /// Open. Read without prompting; a plain refusal is the screen's to handle
  /// when it asks.
  Future<void> _checkMicrophone() async {
    final epoch = _epoch;
    bool blocked;
    try {
      final mic = await ref.read(preflightChecksProvider).microphone();
      blocked = mic == MicPermission.permanentlyDenied || mic == MicPermission.restricted;
    } catch (e) {
      // No way to read it (not wired, a platform without the API): never block on it.
      blocked = false;
    }
    if (epoch != _epoch || blocked == _micBlocked) return;
    _micBlocked = blocked;
    _emit();
  }

  // ─── Bootstrap ────────────────────────────────────────────────────────────

  /// Reads the bootstrap in the hosted session's account (else this one).
  /// [initial]: the first read for this workspace, which may resume a session.
  /// [reconcile]: the answer's `call` is the authority on the hosted session's
  /// call (adopted, or the copy held at the ask retired). Off for a read that
  /// only refreshes what may be dialled (a new session, the switch to the soft
  /// phone), where no frame can have been missed; a reconciling read it
  /// supersedes still has its answer reconciled.
  Future<void> _loadBootstrap({bool initial = false, bool reconcile = true}) async {
    if (_workspace == null) return;
    final epoch = _epoch;
    final seq = ++_bootstrapSeq;
    final reconciles = reconcile || _reconcileAsked;
    _reconcileAsked = reconciles;
    final host = _host;
    // What is held at the moment of asking: if the answer says there is no
    // call, THIS copy is the one it contradicts. A newer frame arriving
    // meanwhile has another version key and survives.
    final heldAtAsk = host?.call;
    final account = host?.accountId;
    _bootstrapReadAt = _now();
    // Read beside the bootstrap: whether the session it names is the one this phone hosted.
    final hostedBefore = host == null ? _readHostedHere() : Future<String?>.value();
    try {
      final b = await _api.bootstrap(accountId: account);
      final hosted = await hostedBefore;
      if (epoch != _epoch || seq != _bootstrapSeq) return;
      final wasKnown = _fieldsKnown;
      _bootstrap = b;
      _bootstrapFor = host?.sessionId;
      _bootstrapOnSoftphone = host?.onSoftphone ?? false;
      if (!b.softphoneEnabled) {
        // Off: nothing new may start, so a prompt to dial anyway goes.
        _override = null;
        _overrideError = null;
      }
      _reach = _Reach.ok;
      _bootstrapError = null;
      final disabledAt = _disabledAtSeq;
      if (disabledAt != null && seq > disabledAt && b.softphoneEnabled) {
        _disabledSeen = false;
        _disabledAtSeq = null;
      }
      _reconcileAsked = false;
      final h = _host;
      if (reconciles && h != null && (b.session == null || b.session!.sessionId == h.sessionId)) {
        final call = b.call;
        if (call != null) {
          _adopt(call);
        } else if (heldAtAsk != null && heldAtAsk.isUnsettled) {
          _actions.retireManualCall(heldAtAsk.versionKey);
        }
      }
      // The field set arrived after the call: take the server's values again,
      // unless the agent has typed into a field since (newer than any copy).
      final current = _call;
      if (!wasKnown && current != null && !_fieldsTouched) _fieldValues = Map.of(current.fields);
      _applyPreset();
      if (_host == null) await _settleScreen(b, initial: initial, hostedBefore: hosted);
      if (epoch != _epoch) return;
      if (initial) unawaited(_loadRecent());
    } on ApiError catch (e) {
      if (epoch != _epoch || seq != _bootstrapSeq) return;
      if (e is ApiHttpError && e.status == 403) {
        _reach = _Reach.forbidden;
        _bootstrap = null;
        _bootstrapError = null;
        if (_host == null) _screen = const SoftphoneScreenOff();
      } else {
        _bootstrapError = e is ApiNetworkError ? e.userMessage : softphoneBootstrapFailedCopy;
        if (_host == null && _bootstrap == null) {
          _screen = SoftphoneScreenError(_bootstrapError!);
          _errorFromOpen = false;
        }
      }
    }
    _emit();
  }

  /// The session this phone last hosted in this workspace, or null.
  Future<String?> _readHostedHere() async {
    final workspace = _workspaceFor(null);
    return workspace == null ? null : ref.read(hostedHereProvider).read(workspace);
  }

  /// The Phone tab's screen from the bootstrap, when no session is hosted here.
  /// On the first read, a session to resume is resumed (decision 1) when it is
  /// the one this phone last hosted ([hostedBefore]): a soft-phone session in
  /// this account is reopened (the server rehydrates it even with the flag
  /// off), and a campaign session here on the soft phone with an unsettled
  /// call has its station started. A session this phone did not host (the
  /// web, another phone) is [SoftphoneScreenOtherDevice]: nothing opens until
  /// the agent asks.
  Future<void> _settleScreen(SoftphoneBootstrap b, {required bool initial, String? hostedBefore}) async {
    final s = b.session;
    final here = _accountId;
    final enabled = b.softphoneEnabled && !_disabledSeen;
    _screenSessionId = s?.sessionId;
    if (s == null) {
      _screen = enabled ? const SoftphoneScreenClosed() : const SoftphoneScreenOff();
      return;
    }
    final resume = initial && !_resumeTried;
    final hostedHere = s.sessionId == hostedBefore;
    if (s.kind == SessionKind.softphone) {
      if (s.accountId == here) {
        if (!hostedHere) {
          _screen = SoftphoneScreenOtherDevice(canClose: b.call == null);
          return;
        }
        if (resume && _foregroundOrDefer()) {
          _resumeTried = true;
          await _openSession();
          return;
        }
        _screen = const SoftphoneScreenClosed();
        return;
      }
      final name = _accountName(s.accountId, null);
      if (enabled) {
        _screen = SoftphoneScreenElsewhere(
          accountId: s.accountId,
          accountName: name,
          canSwitchAccount: _canSwitchTo(s.accountId),
        );
        return;
      }
      _screen = SoftphoneScreenOffStranded(accountId: s.accountId, accountName: name);
      unawaited(_readStrandedCall(s.accountId));
      return;
    }
    final unsettledHere = s.onSoftphone && s.accountId == here && b.call != null;
    if (unsettledHere && !hostedHere) {
      _screen = SoftphoneScreenOtherDevice(campaignId: s.campaignId ?? '', campaignName: s.campaignName ?? '');
      return;
    }
    if (unsettledHere && resume && _foregroundOrDefer()) {
      _resumeTried = true;
      _screen = _onCampaignFromSummary(s);
      _emit();
      unawaited(_startStation(s.campaignId ?? '', s.campaignName ?? ''));
      return;
    }
    _screen = enabled || unsettledHere ? _onCampaignFromSummary(s) : const SoftphoneScreenOff();
  }

  /// Android refuses a microphone foreground service started from the
  /// background: a resume waits for the app to come back.
  bool _foregroundOrDefer() {
    if (_lifecycle?.isForeground ?? true) return true;
    _resumePending = true;
    return false;
  }

  Future<void> _startStation(String campaignId, String campaignName) async {
    try {
      await ref.read(stationLauncherProvider).start(campaignId, campaignName: campaignName);
    } catch (e) {
      _log.warn('station resume failed', {'error': e.runtimeType.toString()});
    }
  }

  /// The stranded session's call, read where it lives (its own account).
  Future<void> _readStrandedCall(String accountId) async {
    final epoch = _epoch;
    try {
      final there = await _api.bootstrap(accountId: accountId);
      if (epoch != _epoch) return;
      final screen = _screen;
      if (screen is! SoftphoneScreenOffStranded || screen.accountId != accountId) return;
      final call = there.call;
      _screen = SoftphoneScreenOffStranded(
        accountId: accountId,
        accountName: screen.accountName,
        callOwed: call != null && call.requiresDisposition,
      );
      _emit();
    } on ApiError {
      // Unreadable: the screen says what is known.
    }
  }

  // ─── Account names ────────────────────────────────────────────────────────

  String? _accountName(String accountId, String? fromServer) {
    if (fromServer != null) return fromServer;
    final gate = ref.read(appGateProvider);
    if (gate is! GateReady) return null;
    return gate.accounts.firstWhereOrNull((a) => a.accountId == accountId)?.accountName;
  }

  /// Another account the agent has, so the app can switch to it.
  bool _canSwitchTo(String accountId) {
    final gate = ref.read(appGateProvider);
    if (gate is! GateReady || accountId == gate.accountId) return false;
    return gate.accounts.any((a) => a.accountId == accountId && a.tenantId == gate.tenantId);
  }

  SoftphoneScreenOnCampaign _onCampaignFromSummary(SoftphoneSessionSummary s) => SoftphoneScreenOnCampaign(
    campaignId: s.campaignId ?? '',
    campaignName: s.campaignName ?? '',
    stateLabel: s.onSoftphone ? 'On the soft phone' : agentStateLabel(s.state, s.stateRaw),
    accountId: s.accountId,
    accountName: _accountName(s.accountId, null),
    sameAccount: s.accountId == _accountId,
    hostedHere: false,
    switchQueued: s.switchQueued,
    canSwitchAccount: _canSwitchTo(s.accountId),
    onSoftphone: s.onSoftphone,
  );

  SoftphoneScreenOnCampaign _onCampaignFromRefusal(SoftphoneSessionOnCampaignRefusal r) => SoftphoneScreenOnCampaign(
    campaignId: r.campaignId,
    campaignName: r.campaignName,
    stateLabel: agentStateLabel(r.state, r.stateRaw),
    accountId: r.accountId,
    accountName: _accountName(r.accountId, r.accountName),
    sameAccount: r.accountId == _accountId,
    hostedHere: _host?.sessionId == r.sessionId,
    canSwitchAccount: _canSwitchTo(r.accountId),
  );

  static const Map<AgentPhase, String> _phaseLabels = {
    AgentPhase.offline: 'Offline',
    AgentPhase.available: 'Available',
    AgentPhase.reserved: 'Reserved',
    AgentPhase.onCall: 'On a call',
    AgentPhase.wrapup: 'Wrapping up',
    AgentPhase.onBreak: 'On break',
  };

  /// The screen now: a hosted session decides it; otherwise the bootstrap's or the open's answer.
  SoftphoneScreenState get _screenNow {
    final host = _host;
    if (host == null) {
      final s = _screen;
      return s is SoftphoneScreenClosed ? SoftphoneScreenClosed(microphoneBlocked: _micBlocked, notice: s.notice) : s;
    }
    if (host.kind == SessionKind.softphone) return const SoftphoneScreenActive();
    return SoftphoneScreenOnCampaign(
      campaignId: host.campaignId ?? '',
      campaignName: host.campaignName ?? '',
      stateLabel: host.onSoftphone ? 'On the soft phone' : (_phaseLabels[host.phase] ?? 'On duty'),
      accountId: host.accountId ?? _accountId ?? '',
      accountName: _accountName(host.accountId ?? _accountId ?? '', null),
      sameAccount: true,
      hostedHere: true,
      switchQueued: host.switchQueued,
      onSoftphone: host.onSoftphone,
    );
  }

  // ─── The Phone tab's session ──────────────────────────────────────────────

  @override
  Future<void> open() async {
    if (_workspace == null || _host?.kind == SessionKind.softphone || _sessionBusy != SoftphoneSessionBusy.none) return;
    final screen = _screen;
    if (_host == null && screen is SoftphoneScreenOtherDevice && screen.campaignId != null) {
      await _useStationHere(screen);
      return;
    }
    await _openSession();
  }

  /// "Use it on this phone" for a campaign station on the soft phone that
  /// another device holds: its station is started here (the host rehydrates it).
  Future<void> _useStationHere(SoftphoneScreenOtherDevice screen) async {
    final epoch = _epoch;
    _resumeTried = true;
    _sessionBusy = SoftphoneSessionBusy.opening;
    _sessionError = null;
    _emit();
    StationStart started;
    try {
      started = await ref
          .read(stationLauncherProvider)
          .start(screen.campaignId!, campaignName: screen.campaignName ?? '');
    } catch (e) {
      _log.warn('station take-over failed', {'error': e.runtimeType.toString()});
      started = const StationRefused(softphoneOpenFailedCopy);
    }
    if (epoch != _epoch) return;
    _sessionBusy = SoftphoneSessionBusy.none;
    switch (started) {
      case StationStarted():
        break;
      case StationRefused(:final message):
        _sessionError = message;
      case StationElsewhere() || StationOnSoftphone():
        _sessionError = softphoneStillOpenCopy;
        unawaited(_loadBootstrap());
    }
    _emit();
  }

  Future<void> _openSession() async {
    final epoch = _epoch;
    _sessionBusy = SoftphoneSessionBusy.opening;
    _sessionError = null;
    _screen = const SoftphoneScreenOpening();
    _emit();
    SoftphoneOpenResult result;
    try {
      result = await _actions.openSoftphone();
    } catch (e) {
      _log.warn('soft phone open failed', {'error': e.runtimeType.toString()});
      result = const SoftphoneOpenRefused(softphoneOpenFailedCopy);
    }
    if (epoch != _epoch) return;
    _sessionBusy = SoftphoneSessionBusy.none;
    switch (result) {
      case SoftphoneOpened():
        // The host's view takes over (Active) as soon as it holds the session.
        if (_host?.kind != SessionKind.softphone) _screen = const SoftphoneScreenOpening();
      case SoftphoneOpenOnCampaign(:final refusal):
        _screen = _onCampaignFromRefusal(refusal);
        _screenSessionId = refusal.sessionId;
      case SoftphoneOpenElsewhere(:final refusal):
        _screen = SoftphoneScreenElsewhere(
          accountId: refusal.accountId,
          accountName: _accountName(refusal.accountId, refusal.accountName),
          canSwitchAccount: _canSwitchTo(refusal.accountId),
        );
        _screenSessionId = refusal.sessionId;
      case SoftphoneOpenDisabled():
        // Off for the account and nothing here to rehydrate: the bootstrap says the rest.
        _screen = const SoftphoneScreenOff();
        unawaited(_loadBootstrap());
      case SoftphoneOpenRefused(:final message):
        _screen = SoftphoneScreenError(message);
        _errorFromOpen = true;
    }
    _emit();
  }

  @override
  Future<void> retry() async {
    if (_workspace == null) return;
    if (_host == null && _screen is SoftphoneScreenError && _errorFromOpen) {
      await _openSession();
      return;
    }
    await _loadBootstrap(initial: _bootstrap == null);
  }

  @override
  Future<void> close() async {
    final host = _host;
    if (host == null) {
      await _closeOtherDevice();
      return;
    }
    if (host.kind != SessionKind.softphone || _sessionBusy != SoftphoneSessionBusy.none) return;
    if (_call != null) {
      _sessionError = softphoneLeaveBlockedCopy;
      _emit();
      return;
    }
    final epoch = _epoch;
    _sessionBusy = SoftphoneSessionBusy.closing;
    _sessionError = null;
    _emit();
    final result = await _actions.closeSoftphone();
    if (epoch != _epoch) return;
    _sessionBusy = SoftphoneSessionBusy.none;
    switch (result) {
      case SoftphoneClosed() || SoftphoneCloseNoSession():
        _screen = const SoftphoneScreenClosed();
      case SoftphoneCloseCallPending(:final call):
        if (call != null) _adopt(call);
        _sessionError = softphoneLeaveBlockedCopy;
      case SoftphoneCloseFailed(:final message):
        _sessionError = message;
    }
    _emit();
  }

  /// "Close it" on [SoftphoneScreenOtherDevice]: the soft-phone session the
  /// other device holds is closed where it is; nothing opens here.
  Future<void> _closeOtherDevice() async {
    final screen = _screen;
    final sessionId = _screenSessionId;
    if (screen is! SoftphoneScreenOtherDevice || !screen.canClose || _sessionBusy != SoftphoneSessionBusy.none) return;
    final epoch = _epoch;
    _sessionBusy = SoftphoneSessionBusy.closing;
    _sessionError = null;
    _emit();
    final result = await _actions.closeSoftphone(sessionId: sessionId, accountId: _accountId);
    if (epoch != _epoch) return;
    _sessionBusy = SoftphoneSessionBusy.none;
    switch (result) {
      case SoftphoneClosed() || SoftphoneCloseNoSession():
        _screen = const SoftphoneScreenClosed();
        unawaited(_loadBootstrap());
      case SoftphoneCloseCallPending():
        // A call started there meanwhile: it is the other device's to finish, or this phone's to take.
        _screen = const SoftphoneScreenOtherDevice();
        _sessionError = softphoneLeaveBlockedCopy;
      case SoftphoneCloseFailed(:final message):
        _sessionError = message;
    }
    _emit();
  }

  @override
  Future<void> closeElsewhereAndOpen() async {
    final screen = _screen;
    final sessionId = _screenSessionId;
    if (_host != null || screen is! SoftphoneScreenElsewhere || _sessionBusy != SoftphoneSessionBusy.none) return;
    final epoch = _epoch;
    _sessionBusy = SoftphoneSessionBusy.closing;
    _sessionError = null;
    _emit();
    final result = await _actions.closeSoftphone(sessionId: sessionId, accountId: screen.accountId);
    if (epoch != _epoch) return;
    _sessionBusy = SoftphoneSessionBusy.none;
    switch (result) {
      case SoftphoneClosed():
        await _openSession();
        return;
      case SoftphoneCloseCallPending():
        _screen = SoftphoneScreenElsewhere(
          accountId: screen.accountId,
          accountName: screen.accountName,
          callPending: true,
          canSwitchAccount: screen.canSwitchAccount,
        );
      case SoftphoneCloseFailed(:final message):
        _sessionError = message;
      case SoftphoneCloseNoSession():
        _sessionError = softphoneStillOpenCopy;
    }
    _emit();
  }

  @override
  Future<void> closeStranded() async {
    final screen = _screen;
    final sessionId = _screenSessionId;
    if (_host != null || screen is! SoftphoneScreenOffStranded || _sessionBusy != SoftphoneSessionBusy.none) return;
    final epoch = _epoch;
    _sessionBusy = SoftphoneSessionBusy.closing;
    _sessionError = null;
    _emit();
    final result = await _actions.closeSoftphone(sessionId: sessionId, accountId: screen.accountId);
    if (epoch != _epoch) return;
    _sessionBusy = SoftphoneSessionBusy.none;
    switch (result) {
      case SoftphoneClosed() || SoftphoneCloseNoSession():
        _screen = const SoftphoneScreenOff();
        unawaited(_loadBootstrap());
      case SoftphoneCloseCallPending():
        _screen = SoftphoneScreenOffStranded(accountId: screen.accountId, accountName: screen.accountName, callOwed: true);
        _sessionError = softphoneElsewhereCallPendingCopy(screen.accountName);
      case SoftphoneCloseFailed(:final message):
        _sessionError = message;
    }
    _emit();
  }

  @override
  Future<bool> switchToSoftphone() async {
    final screen = _screenNow;
    if (screen is! SoftphoneScreenOnCampaign || _sessionBusy != SoftphoneSessionBusy.none) return false;
    // Nothing to switch on a station already on the soft phone, and no new
    // soft-phone work with the soft phone off (finish mode).
    if (!screen.sameAccount || screen.onSoftphone || _bootstrap?.softphoneEnabled != true || _disabledSeen) return false;
    final epoch = _epoch;
    _sessionBusy = SoftphoneSessionBusy.switching;
    _sessionError = null;
    _emit();
    var ok = false;
    if (screen.hostedHere) {
      final result = await _actions.switchToSoftphone();
      if (epoch != _epoch) return false;
      switch (result) {
        case SoftphoneSwitchApplied() || SoftphoneSwitchQueued():
          ok = true;
        case SoftphoneSwitchRefused(:final message):
          _sessionError = message;
      }
    } else {
      // That station is not open on this phone: switch it, then open it here.
      final sessionId = _screenSessionId;
      try {
        if (sessionId == null) throw StateError('no session');
        await _api.switchToSoftphone(sessionId, accountId: screen.accountId);
        if (epoch != _epoch) return false;
        final started = await ref
            .read(stationLauncherProvider)
            .start(screen.campaignId, campaignName: screen.campaignName);
        if (epoch != _epoch) return false;
        switch (started) {
          case StationStarted():
            ok = true;
          case StationRefused(:final message):
            _sessionError = message;
          case StationElsewhere() || StationOnSoftphone():
            _sessionError = softphoneRefusalCopy[SoftphoneErrorCode.sessionOnCampaign];
        }
      } on ApiError catch (e) {
        if (epoch != _epoch) return false;
        _sessionError = softphoneErrorCopy(e, context: SoftphoneRefusalContext.status);
      } on StateError {
        _sessionError = softphoneStillOpenCopy;
      }
    }
    _sessionBusy = SoftphoneSessionBusy.none;
    _emit();
    return ok;
  }

  @override
  Future<void> requestAccountSwitch(String accountId) async {
    final gate = ref.read(appGateProvider);
    if (gate is! GateReady || accountId == gate.accountId) return;
    final choice = gate.accounts.firstWhereOrNull((a) => a.accountId == accountId && a.tenantId == gate.tenantId);
    if (choice == null) return;
    final epoch = _epoch;
    try {
      await ref.read(appGateProvider.notifier).switchAccount(choice);
    } on ApiError catch (e) {
      if (epoch != _epoch) return;
      _sessionError = e.userMessage;
      _emit();
    } on StateError catch (e) {
      if (epoch != _epoch) return;
      _sessionError = e.message;
      _emit();
    }
  }

  // ─── The station surface (SP7) ────────────────────────────────────────────

  @override
  Future<void> returnToCampaign() async {
    final host = _host;
    if (host == null || host.kind != SessionKind.campaign || _call != null) return;
    if (_sessionBusy != SoftphoneSessionBusy.none) return;
    final epoch = _epoch;
    _sessionBusy = SoftphoneSessionBusy.returning;
    _sessionError = null;
    _emit();
    final result = await _actions.returnToCampaign();
    if (epoch != _epoch) return;
    _sessionBusy = SoftphoneSessionBusy.none;
    if (result case SoftphoneSwitchRefused(:final message, :final code)) {
      _sessionError = message;
      // The server holds a call this screen does not show: the host took its copy; re-read the rest.
      if (code == SoftphoneErrorCode.manualCallLive) unawaited(_loadBootstrap());
    }
    _emit();
  }

  @override
  Future<void> cancelSwitch() async {
    final host = _host;
    if (host == null || !host.switchQueued || _sessionBusy != SoftphoneSessionBusy.none) return;
    final epoch = _epoch;
    _sessionBusy = SoftphoneSessionBusy.switching;
    _sessionError = null;
    _emit();
    final result = await _actions.cancelSwitch();
    if (epoch != _epoch) return;
    _sessionBusy = SoftphoneSessionBusy.none;
    if (result case SoftphoneSwitchRefused(:final message)) _sessionError = message;
    _emit();
  }

  // ─── The number ───────────────────────────────────────────────────────────

  @override
  void setNumber(String raw) {
    if (!_dialPadEnabled) return;
    _number = normaliseTypedNumber(sanitiseDialInput(raw));
    _entry = 'typed';
    _dialError = null;
    _emit();
  }

  @override
  void pressKey(String key) {
    if (!_dialPadEnabled) return;
    _number = appendDialKey(_number, key);
    _entry = 'typed';
    _dialError = null;
    _emit();
  }

  @override
  void backspace() {
    if (!_dialPadEnabled) return;
    _number = deleteLastDialChar(_number);
    _emit();
  }

  @override
  void clearNumber() {
    if (!_dialPadEnabled) return;
    _number = '';
    _dialError = null;
    _emit();
  }

  @override
  void pasteNumber(String raw) {
    if (!_dialPadEnabled) return;
    _number = normalisePastedNumber(raw, _countryCode);
    _entry = 'pasted';
    _dialError = null;
    _emit();
  }

  // ─── Dial ─────────────────────────────────────────────────────────────────

  @override
  Future<void> dial() async {
    if (!_canDial) return;
    await _place(const ManualCallOverridesRequest());
  }

  /// One dial in flight: [_placing] is set before the first await, so two
  /// presses in the same frame (a double tap, the keyboard's Go on top of a
  /// tap) place one call. `POST /calls` is never retried.
  Future<void> _place(ManualCallOverridesRequest overrides, {String? to}) async {
    final host = _host;
    final b = _bootstrap;
    if (host == null || b == null || _placing) return;
    // The number this dial is about: an override prompt names it, and "Call anyway" redials it.
    final number = to ?? _number;
    _placing = true;
    _dialError = null;
    _overrideError = null;
    _emit();
    final epoch = _epoch;
    final cleaned = cleanFieldValues(b.callFields, _fieldValues);
    final request = ManualCallCreateRequest(
      sessionId: host.sessionId,
      to: number,
      callerId: _draftCallerId,
      campaignId: _tagDraft,
      fields: cleaned.isEmpty ? null : cleaned,
      overrides: overrides.isEmpty ? null : overrides,
    );
    try {
      final call = await _api.placeCall(request, accountId: host.accountId);
      Telemetry.event('agency_softphone_call_placed', {
        'tagged': request.campaignId != null,
        'overrides': _overridesLabel(overrides),
        'entry': _entry,
        'surface': _surface == SoftphoneSurface.station ? 'station' : 'softphone_page',
      });
      CallTelemetry.instance.manualPlaced(call);
      if (epoch != _epoch) return;
      _placing = false;
      _override = null;
      _adopt(call);
    } on ApiError catch (e) {
      if (epoch != _epoch) return;
      _placing = false;
      final body = refusalBodyOf(e);
      final refused = body != null && body.softphoneCode != SoftphoneErrorCode.unknown;
      // As the console's `agency_softphone_call_refused`; a failure it has no event for besides.
      Telemetry.event(refused ? 'agency_softphone_call_refused' : 'agency_softphone_dial_failed', {
        'code': refused ? body.codeRaw : (e is ApiHttpError ? e.code : null),
        'tagged': request.campaignId != null,
        if (!refused) ...{
          'status': e is ApiHttpError ? e.status : null,
          'error': e.runtimeType.toString(),
          'overrides': _overridesLabel(overrides),
        },
      });
      if (refused) {
        _onDialRefused(body, overrides, number);
      } else if (e is ApiUnauthorized || (e is ApiHttpError && !e.isServerError)) {
        _override = null;
        _dialError = softphoneErrorCopy(e);
      } else {
        // No answer, a server fault, or an answer that did not read: the call
        // may have been placed. Never sent again; the frame or the bootstrap says.
        _override = null;
        _dialError = softphoneDialUnconfirmedCopy;
        unawaited(_loadBootstrap());
      }
    }
    _emit();
  }

  /// Which refusals a dial went through with a note, as the console labels it.
  static String _overridesLabel(ManualCallOverridesRequest o) => switch ((o.dncNote != null, o.hoursNote != null)) {
        (false, false) => 'none',
        (true, false) => 'dnc',
        (false, true) => 'hours',
        (true, true) => 'both',
      };

  void _onDialRefused(ErrorBody refusal, ManualCallOverridesRequest overrides, String number) {
    final campaignName = _draftCampaign?.campaignName;
    final copy = refusalCopy(refusal);
    switch (refusal.softphoneCode) {
      case SoftphoneErrorCode.dncListed:
        final dnc = refusal.dncListed;
        if (dnc == null) {
          _override = null;
          _dialError = copy;
          return;
        }
        _override = _Override(
          describeDncRefusal(
            dnc,
            // As dialled: a number typed without a country code is read in the account's.
            number: number.startsWith('+') ? number : '$_countryCode$number',
            campaignName: campaignName,
            calendar: ref.read(softphoneCalendarProvider),
          ),
          overrides,
          number,
        );
      case SoftphoneErrorCode.outsideCallingHours:
        final hours = refusal.outsideHours;
        if (hours == null) {
          _override = null;
          _dialError = copy;
          return;
        }
        _override = _Override(
          describeHoursRefusal(
            hours,
            campaignName: campaignName,
            now: _now(),
            offsetMs: _host?.clockOffsetMs ?? 0,
            calendar: ref.read(softphoneCalendarProvider),
          ),
          overrides,
          number,
        );
      case SoftphoneErrorCode.overrideNoteInvalid:
        if (_override != null) {
          _overrideError = refusal.message.isNotEmpty ? refusal.message : copy;
        } else {
          _dialError = copy;
        }
      case SoftphoneErrorCode.outcomePending || SoftphoneErrorCode.manualCallLive:
        _override = null;
        final pending = refusal.callPending;
        if (pending != null) {
          _refusedFor = pending.call.id;
          _adopt(pending.call);
        }
        _dialError = copy;
      case SoftphoneErrorCode.contactInFlight:
        _override = null;
        _dialError = campaignName != null ? softphoneContactInFlightCopy(campaignName) : copy;
      case SoftphoneErrorCode.fieldsInvalid:
        _override = null;
        final details = refusal.details;
        if (details != null && details.isNotEmpty) _onFieldsInvalid(details);
        _dialError = copy;
      case SoftphoneErrorCode.softphoneDisabled:
        // Turned off under an open soft phone: finish mode, and the bootstrap says the rest.
        _override = null;
        _disabledSeen = true;
        _disabledAtSeq = _bootstrapSeq + 1;
        _announce(softphoneFinishIdleCopy[_surface]!);
        unawaited(_loadBootstrap());
      case SoftphoneErrorCode.callerIdNotAllowed || SoftphoneErrorCode.campaignNotTaggable:
        // What may be called from, and logged to, changed under us: re-read it.
        _override = null;
        _dialError = copy;
        unawaited(_loadBootstrap());
      default:
        _override = null;
        _dialError = copy;
    }
  }

  @override
  void redial(String recentCallId) {
    if (_call != null || _placing || _finishOnly) return;
    final from = _recent.firstWhereOrNull((c) => c.id == recentCallId);
    if (from == null) return;
    _number = sanitiseDialInput(from.destinationE164);
    final tagId = from.tag?.campaignId;
    _tagDraft = tagId == null || _bootstrap?.taggable(tagId) != null ? tagId : null;
    _callerDraft = from.callerId;
    _entry = 'redial';
    _dialError = null;
    // An override prompt names the number it was for: "Call anyway" must never
    // dial that one under this setup.
    _override = null;
    _overrideError = null;
    _focusCallToken++;
    _emit();
  }

  @override
  void callBack(String number, {String? campaignId}) {
    _pendingCallBack = _CallBack(number, campaignId, _now(), _host?.sessionId);
    _emit();
  }

  /// Puts a waiting [callBack] on the pad once the soft phone can take it:
  /// a session open here (the soft phone's own, or a campaign switched to it)
  /// whose bootstrap was read for it, nothing on screen, not in finish mode.
  /// A call live or owing its outcome keeps the screen: the number waits until
  /// it settles (the console's `presetNumber`). Run before every emit.
  ///
  /// It lapses: [callBackWaitsFor] after it was asked for (or after the call
  /// it waited behind settled), on a session change ([_onHost]), when the
  /// session is taken by another device, and when the soft phone turns out to
  /// be open elsewhere (another device or account), where nothing here can
  /// take it.
  void _applyCallBack() {
    final pending = _pendingCallBack;
    if (pending == null) return;
    if (_call != null || _placing) {
      pending.behindCall = true;
      return;
    }
    final now = _now();
    if (pending.behindCall) {
      pending.behindCall = false;
      pending.askedAt = now;
    }
    if (now.difference(pending.askedAt) >= callBackWaitsFor) {
      _pendingCallBack = null;
      return;
    }
    final host = _host;
    if (host == null) {
      final screen = _screen;
      if (screen is SoftphoneScreenOtherDevice ||
          screen is SoftphoneScreenElsewhere ||
          screen is SoftphoneScreenOffStranded ||
          screen is SoftphoneScreenOff) {
        _pendingCallBack = null;
      }
      return;
    }
    if (host.link == StationLink.superseded) {
      _pendingCallBack = null;
      return;
    }
    final b = _bootstrap;
    if (b == null || _bootstrapFor != host.sessionId) return;
    if (host.kind == SessionKind.campaign && !host.onSoftphone) return;
    if (_finishOnly) return;
    _pendingCallBack = null;
    _number = sanitiseDialInput(pending.number);
    final tag = pending.campaignId;
    // The matched campaign is "Log to" only where the agent may log to it;
    // otherwise the tag stays as it was (the console's `presetCampaignId`).
    if (tag != null && b.taggable(tag) != null && tag != _tagDraft) {
      _tagDraft = tag;
      _callerDraft = null;
    }
    _entry = 'inbound_callback';
    _dialError = null;
    // An open override prompt was for another number: "Call anyway" must never
    // dial it under the tag just set.
    _override = null;
    _overrideError = null;
    _focusCallToken++;
  }

  // ─── Setup ────────────────────────────────────────────────────────────────

  @override
  void setTag(String? campaignId) {
    if (!_setupEditable) return;
    _tagDraft = campaignId;
    // The caller-ID set belongs to the tag; a pick from the old set would be refused.
    _callerDraft = null;
    _dialError = null;
    _emit();
  }

  @override
  void setCallerId(String callerId) {
    if (!_setupEditable) return;
    _callerDraft = callerId;
    _emit();
  }

  // ─── Fields and notes ─────────────────────────────────────────────────────

  bool get _fieldsEditable => !(_placing || (_finishOnly && _call == null));

  @override
  void setFieldValue(String key, Object? value) {
    if (!_fieldsEditable) return;
    _fieldsTouched = true;
    _fieldValues = {..._fieldValues, key: value};
    if (_fieldErrors.containsKey(key)) _fieldErrors = Map.of(_fieldErrors)..remove(key);
    if (_call != null) _autosave.fieldsChanged();
    _emit();
  }

  @override
  void setNotes(String text) {
    if (_call == null) return;
    _autosave.editNotes(text);
    _emit();
  }

  /// The PATCH body when it is sent: notes alone until the field set is known
  /// (`fields` would replace the stored values), then both.
  ManualCallUpdateRequest _autosaveRequest(String? notes) => _fieldsKnown
      ? ManualCallUpdateRequest(fields: cleanFieldValues(_fields, _fieldValues), notes: notes)
      : ManualCallUpdateRequest(notes: notes);

  void _onAutosaveFailed(String callId, ApiError error) {
    if (_call?.id != callId) return;
    final body = refusalBodyOf(error);
    final details = body?.details;
    if (body?.softphoneCode == SoftphoneErrorCode.fieldsInvalid && details != null && details.isNotEmpty) {
      _onFieldsInvalid(details);
    }
    _emit();
  }

  /// Marks the fields a `fields_invalid` names. One this phone does not know
  /// means the field set changed since it was read (a required field added):
  /// re-read it, so the field appears with its error and can be filled.
  void _onFieldsInvalid(List<FieldIssue> details) {
    _fieldErrors = fieldErrorsFromDetails(details);
    if (_fieldErrors.keys.any((key) => _fields.every((f) => f.key != key))) unawaited(_loadBootstrap(reconcile: false));
  }

  // ─── The outcome ──────────────────────────────────────────────────────────

  bool get _padEnabled => _phase == SoftphonePhase.onCall || _phase == SoftphonePhase.outcome;

  @override
  void selectOutcome(String code) {
    if (!_padEnabled || _saving) return;
    _outcomeCode = code;
    _padRejection = null;
    _emit();
  }

  @override
  void setCallback(DateTime? at) {
    if (_call == null || _saving) return;
    _callbackAt = at;
    _emit();
  }

  @override
  Future<void> saveOutcome() async {
    final call = _call;
    final host = _host;
    if (call == null || host == null || _saving) return;
    final now = _now();
    final problems = validateCallFieldValues(_fields, _fieldValues, requireFilled: true);
    if (problems.isNotEmpty) {
      _fieldErrors = problems;
      _announce(softphoneSaveBlockCopy[SoftphoneSaveBlock.fieldsRequired]!);
      _emit();
      return;
    }
    final block = state.view.saveBlockAt(now);
    if (block != null) {
      _announce(softphoneSaveBlockCopy[block]!);
      _emit();
      return;
    }
    final catalog = _catalog;
    final payload = buildDispositionRequest(
      catalog,
      code: _outcomeCode!,
      notes: _autosave.text,
      callbackAt: _callbackAt,
      now: now,
    );
    if (payload == null) return;
    _autosave.cancelPending();
    _saving = true;
    _padRejection = null;
    _emit();
    final epoch = _epoch;
    // Notes the agent cleared go as '': the pending PATCH that would have
    // cleared them was just cancelled, and an absent `notes` keeps the stored
    // text. Notes never touched stay absent, so a save never clears what was
    // written elsewhere.
    final notes = payload.notes ?? (_autosave.touched ? '' : null);
    final request = ManualCallDispositionRequest(
      code: payload.dispositionCode,
      notes: notes,
      callbackAt: payload.callbackAt,
      // Absent until the field set is known: the server then keeps (and checks) the stored values.
      fields: _fieldsKnown ? cleanFieldValues(_fields, _fieldValues) : null,
    );
    try {
      final answer = await _api.disposition(call.id, request, accountId: host.accountId);
      if (epoch != _epoch) return;
      _saving = false;
      _autosave.savedWithOutcome(call.id, notes);
      _adopt(answer.call);
      _announce(softphoneOutcomeSavedCopy);
    } on ApiError catch (e) {
      if (epoch != _epoch) return;
      _saving = false;
      // The refused outcome carried nothing: notes typed since the last confirmed save go by
      // their own route again, or they would stay on this phone with the status at saving.
      _autosave.outcomeRefused(call.id);
      final refusal = refusalBodyOf(e);
      final code = refusal?.softphoneCode;
      final allowed = refusal?.allowedCodes;
      if (code == SoftphoneErrorCode.dispositionInvalid && allowed != null && allowed.isNotEmpty) {
        _catalogOverride = (callId: call.id, catalog: resyncDispositions(catalog, allowed));
        _padRejection = catalogChangedCopy;
      } else if (code == SoftphoneErrorCode.fieldsInvalid) {
        final details = refusal?.details;
        if (details != null && details.isNotEmpty) _onFieldsInvalid(details);
        _padRejection = softphoneRefusalCopy[SoftphoneErrorCode.fieldsInvalid];
      } else if (code == SoftphoneErrorCode.callSettled) {
        // Saved already (a supervisor on the agent's behalf): the server's view retires it here.
        _padRejection = softphoneRefusalCopy[SoftphoneErrorCode.callSettled];
        unawaited(_loadBootstrap());
      } else {
        _padRejection = softphoneErrorCopy(e);
      }
      _announce(softphoneOutcomeNotSavedCopy(softphoneErrorCopy(e)));
    }
    _emit();
  }

  // ─── Call controls ────────────────────────────────────────────────────────

  @override
  Future<void> hangUp() async {
    final call = _call;
    final host = _host;
    if (call == null || !call.isLive || host == null || _hangingUp) return;
    final epoch = _epoch;
    _hangingUp = true;
    _hangupFailure = null;
    _emit();
    try {
      final answer = await _api.hangup(call.id, accountId: host.accountId);
      if (epoch != _epoch) return;
      _adopt(answer);
    } on ApiError catch (e) {
      if (epoch != _epoch) return;
      final code = refusalBodyOf(e)?.softphoneCode;
      if (code == SoftphoneErrorCode.callSettled || code == SoftphoneErrorCode.callNotFound) {
        unawaited(_loadBootstrap());
      } else {
        _hangupFailure = softphoneHangupFailedCopy(softphoneErrorCopy(e));
      }
    }
    _hangingUp = false;
    _emit();
  }

  @override
  Future<void> toggleMute() async {
    final host = _host;
    if (host == null) return;
    switch (_phase) {
      case SoftphonePhase.ringing:
        // The ring has its own mute, so an agent who quietened it is not muted when the customer answers.
        _actions.setRingMuted(!host.ringMuted);
      case SoftphonePhase.onCall:
        await _actions.setMuted(!host.audio.muted);
      case SoftphonePhase.ready || SoftphonePhase.dialing || SoftphonePhase.outcome:
        break;
    }
  }

  @override
  Future<void> setRoute(AudioRouteOption route) async {
    if (_host == null) return;
    await _actions.setRoute(route);
  }

  @override
  Future<void> markDnc({String? reason, required String callId}) async {
    final call = _call;
    final host = _host;
    if (call == null || host == null || call.id != callId || !_dncEnabled || _dncInFlight) return;
    final epoch = _epoch;
    _dncInFlight = true;
    _dncFailure = null;
    _emit();
    try {
      final answer = await _api.markDnc(call.id, ManualCallDncRequest(reason: reason), accountId: host.accountId);
      if (epoch != _epoch) return;
      final where = softphoneDncScopeLabel(answer.scope == DncEntryScope.campaign ? call.tag?.campaignName : null);
      final text = softphoneDncDoneCopy(answer.phoneE164, where);
      _dncOutcome = text;
      _announce(text);
    } on ApiError catch (e) {
      if (epoch != _epoch) return;
      final text = softphoneDncFailedCopy(softphoneErrorCopy(e));
      _dncFailure = text;
      _announce(text);
    }
    _dncInFlight = false;
    _emit();
  }

  // ─── The override prompt ──────────────────────────────────────────────────

  @override
  Future<void> confirmOverride(String note) async {
    final o = _override;
    // As Call: nothing is dialled in finish mode or while the phone cannot dial.
    if (o == null || _placing || _dialUnavailableReason != null) return;
    final block = overrideNoteBlock(note);
    if (block != null) {
      _overrideError = overrideNoteBlockCopy[block];
      _emit();
      return;
    }
    await _place(withOverride(o.overrides, o.prompt.kind, note), to: o.to);
  }

  @override
  void cancelOverride() {
    if (_placing || _override == null) return;
    _override = null;
    _overrideError = null;
    _emit();
  }

  // ─── Connection ───────────────────────────────────────────────────────────

  @override
  Future<void> reconnect() async {
    if (_host == null) return;
    await _actions.reconnect();
  }

  @override
  Future<void> useThisDevice() async {
    if (_host == null) return;
    await _actions.useThisDevice();
  }

  // ─── Recent calls ─────────────────────────────────────────────────────────

  @override
  Future<void> reloadRecent() => _loadRecent();

  /// The agent's own last few soft-phone calls (a supervisor using the app
  /// sees their own too), newest first.
  Future<void> _loadRecent() async {
    final userId = _userId;
    if (_workspace == null || userId == null || _reach == _Reach.forbidden) return;
    final epoch = _epoch;
    final seq = ++_recentSeq;
    _recentLoading = true;
    _emit();
    try {
      final page = await _api.listCalls(ManualCallsQuery(agentUserId: userId, limit: softphoneRecentLimit));
      if (epoch != _epoch || seq != _recentSeq) return;
      _recent = page.rows;
      _recentError = null;
    } on ApiError {
      if (epoch != _epoch || seq != _recentSeq) return;
      _recentError = softphoneRecentFailedCopy;
    }
    _recentLoading = false;
    _emit();
  }

  @override
  void dismissDialError() {
    if (_dialError == null) return;
    _dialError = null;
    _emit();
  }

  @override
  void dismissSessionError() {
    if (_sessionError == null) return;
    _sessionError = null;
    _emit();
  }

  void _announce(String text) {
    _announcement = text;
    _announcementSeq++;
  }

  // ─── The view ─────────────────────────────────────────────────────────────

  void _emit() {
    if (_building) return;
    _applyCallBack();
    final next = _compute();
    _sendDisplayName();
    state = next;
  }

  /// The matched contact's name to the host, for CallKit and the on-duty notification.
  void _sendDisplayName() {
    final call = _call;
    if (call == null || _host == null) return;
    final name = contactName(call, _campaign?.contextDisplay);
    final sent = _nameSent;
    if (sent != null && sent.callId == call.id && sent.name == name) return;
    _nameSent = (callId: call.id, name: name);
    _actions.setCallDisplayName(call.id, name);
  }

  List<DispositionOption> _optionsFor(List<Disposition> catalog) {
    if (identical(catalog, _optionsSource)) return _options;
    _optionsSource = catalog;
    return _options = List.unmodifiable(
      catalog.map(
        (d) => DispositionOption(
          code: d.code,
          label: d.label,
          requiresNote: d.noteRequired,
          requiresCallbackTime: d.datetimeRequired,
          isSuccess: d.isSuccess ?? false,
          suppresses: d.suppress ?? false,
        ),
      ),
    );
  }

  SoftphoneContactView? _contactFor(ManualCall call, SoftphoneCampaign? campaign, int offsetMs) {
    final contact = call.contact;
    if (contact == null) return null;
    final display = campaign?.contextDisplay;
    final context = contact.context ?? const <String, Object?>{};
    final resolved = resolveContextFields(context, display);
    ContactField field(ResolvedField f) => ContactField(key: f.label, label: f.label, value: f.isEmpty ? '' : f.value);
    return SoftphoneContactView(
      displayName: contactName(call, display),
      heroFields: List.unmodifiable(resolved.hero.map(field)),
      heroesConfigured: heroesWereConfigured(display),
      otherFields: List.unmodifiable([...resolved.fields.map(field), ...resolved.empty.map(field)]),
      priorAttempts: priorAttemptsFor(
        contact.priorAttempts ?? const [],
        campaignId: call.tag?.campaignId ?? '',
        catalog: campaign?.dispositionCatalog ?? const [],
        offsetMs: offsetMs,
      ),
      claimed: contact.claimed,
      campaignName: call.tag?.campaignName,
    );
  }

  SoftphoneCoreState _compute() {
    final host = _host;
    final b = _bootstrap;
    final call = _call;
    final phase = softphonePhase(call);
    final offset = host?.clockOffsetMs ?? 0;
    final campaign = _campaign;
    final finishOnly = _finishOnly;
    final live = phase == SoftphonePhase.dialing || phase == SoftphonePhase.ringing || phase == SoftphonePhase.onCall;
    final now = _now();
    final fields = _fields;
    final callerIds = call != null ? [call.callerId] : _draftCallerIds;
    final block = dialBlockReason(_number);
    final padEnabled = phase == SoftphonePhase.onCall || phase == SoftphonePhase.outcome;
    final notesEnabled = call != null;
    final override = _override;
    final audio = host?.audio ?? const AudioView();
    final ringing = phase == SoftphonePhase.ringing;

    final view = SoftphoneView(
      screen: _screenNow,
      link: host?.link ?? StationLink.connecting,
      reconnectDeadline: host?.reconnectDeadline,
      phase: phase,
      rail: describeSoftphoneRail(
        link: host?.link ?? StationLink.connecting,
        call: call,
        lastCall: _lastCall,
        fromCampaign: host?.kind == SessionKind.campaign,
        contactName: call == null ? null : contactName(call, campaign?.contextDisplay),
        offsetMs: offset,
      ),
      callId: call?.id,
      startAllowed: (b?.softphoneEnabled ?? false) && !_disabledSeen,
      finishOnly: finishOnly,
      campaigns: _tagOptions(b, call),
      tagCampaignId: call != null ? call.tag?.campaignId : _tagDraft,
      callerIds: [for (final id in callerIds) SoftphoneChoice(value: id, label: formatDialNumber(id))],
      callerId: call?.callerId ?? _draftCallerId,
      setupEditable: _setupEditable,
      recording: call != null
          ? call.recordingRequested
          : (_draftCampaign?.recordCalls ?? (_tagDraft == null ? (b?.untagged.recordCalls ?? false) : false)),
      countryCode: _countryCode,
      number: _number,
      numberDisplay: formatDialNumber(_number),
      dialPadEnabled: _dialPadEnabled,
      canDial: _canDial,
      dialBlockReason: _number.isNotEmpty && block != null ? dialBlockCopy[block] : null,
      dialUnavailableReason: _dialUnavailableReason,
      placing: _placing,
      dialError: _dialError,
      focusCallToken: _focusCallToken,
      contact: call == null ? null : _contactFor(call, campaign, offset),
      fields: [
        for (final f in fields)
          SoftphoneFieldView(
            key: f.key,
            label: f.label,
            type: fieldTypeOf(f),
            options: f.options ?? const [],
            required: f.required,
            value: _fieldValues[f.key],
            error: _fieldErrors[f.key],
          ),
      ],
      fieldsEditable: _fieldsEditable,
      requiredFieldsMissing: validateCallFieldValues(fields, _fieldValues, requireFilled: true).isNotEmpty,
      notes: _autosave.view,
      notesEnabled: notesEnabled,
      notesDisabledReason: notesEnabled ? null : softphoneNotesDisabledCopy,
      outcomes: _optionsFor(_catalog),
      outcomeCode: _outcomeCode,
      callbackAt: _callbackAt,
      padEnabled: padEnabled,
      padDisabledReason: padEnabled ? null : softphonePadDisabledCopy,
      padRejection: _padRejection,
      saving: _saving,
      outcomeDueAt: phase == SoftphonePhase.outcome ? correctedInstant(call?.outcomeDueAt, offset) : null,
      muteTarget: ringing ? SoftphoneMuteTarget.ring : SoftphoneMuteTarget.mic,
      muted: ringing ? (host?.ringMuted ?? false) : audio.muted,
      micMuted: audio.muted,
      muteEnabled: ringing || phase == SoftphonePhase.onCall,
      audio: audio,
      canHangUp: live && !_hangingUp,
      // As the console's: anything but an explicit `true` warns (fail closed).
      warnRingingHangUp: ringing && call?.canCancelRinging != true,
      hangingUp: _hangingUp,
      // This screen's own hang-up failure, else one from the system controls
      // (CallKit, the notification), which only the host sees.
      hangupFailure: _hangupFailure ?? host?.hangupFailure,
      dncEnabled: _dncEnabled,
      dncScopeLabel: call == null ? null : softphoneDncScopeLabel(call.tag?.campaignName),
      dncInFlight: _dncInFlight,
      dncOutcome: _dncOutcome,
      dncFailure: _dncFailure,
      overridePrompt: override == null
          ? null
          : SoftphoneOverridePrompt(
              kind: override.prompt.kind,
              title: override.prompt.title,
              facts: override.prompt.facts,
              consequence: override.prompt.consequence,
              noteLabel: override.prompt.noteLabel,
              confirmLabel: override.prompt.confirmLabel,
              submitting: _placing,
              error: _overrideError,
            ),
      recent: [
        for (final r in _recent) _recentRow(r, b, offset, now, canRedial: !finishOnly && call == null && !_placing),
      ],
      recentLoading: _recentLoading,
      recentError: _recentError,
      canClose: call == null,
      closeBlockedReason: call == null ? null : softphoneLeaveBlockedCopy,
      canReturn: call == null,
      returnBlockedReason: call == null ? null : softphoneRefusalCopy[SoftphoneErrorCode.manualCallLive],
      sessionBusy: _sessionBusy,
      sessionError: _sessionError,
      bootstrapError: _bootstrapError,
      announcement: _announcement,
      announcementSeq: _announcementSeq,
    );
    return SoftphoneCoreState(view: view, availability: _availability());
  }

  static SoftphoneTagOption _tagOption(SoftphoneCampaign c) => SoftphoneTagOption(
    campaignId: c.campaignId,
    name: c.status == CampaignStatus.running ? c.campaignName : '${c.campaignName} (${c.statusRaw})',
    windowOpen: c.callingWindowOpen,
    windowNote: c.callingWindowOpen ? null : softphoneWindowClosedCopy,
    recording: c.recordCalls,
    analysisProfileName: c.analysisProfile?.name,
  );

  /// "Log to": the taggable campaigns, plus, while a call is on screen, the
  /// campaign it is logged to when that is no longer taggable (completed since
  /// the dial, the agent unstaffed): the bootstrap's `call_campaign`, else the
  /// call's own tag. The screen looks the call's tag up here.
  List<SoftphoneTagOption> _tagOptions(SoftphoneBootstrap? b, ManualCall? call) {
    final options = [for (final c in b?.taggableCampaigns ?? const <SoftphoneCampaign>[]) _tagOption(c)];
    final tag = call?.tag;
    if (tag != null && options.every((o) => o.campaignId != tag.campaignId)) {
      final callCampaign = b?.callCampaign;
      options.add(
        callCampaign != null && callCampaign.campaignId == tag.campaignId
            ? _tagOption(callCampaign)
            : SoftphoneTagOption(campaignId: tag.campaignId, name: tag.campaignName, recording: call!.recordingRequested),
      );
    }
    return options;
  }

  SoftphoneRecentCall _recentRow(ManualCall r, SoftphoneBootstrap? b, int offset, DateTime now, {required bool canRedial}) {
    final at = correctedInstant(r.dialedAt ?? r.createdAt, offset)!;
    final outcome = manualCallOutcome(r, catalogForCall(r, b));
    return SoftphoneRecentCall(
      id: r.id,
      numberE164: r.destinationE164,
      numberDisplay: formatDialNumber(r.destinationE164),
      at: at,
      whenLabel: recentCallWhen(at, now),
      outcomeLabel: outcome.text,
      outcomeKind: outcome.kind,
      loggedTo: loggedToLabel(r),
      tagged: r.tag != null,
      canRedial: canRedial,
    );
  }

  /// The Phone tab shows when the bootstrap answered 200 and (the soft phone is
  /// on, or there is something to finish), or the host holds a soft-phone
  /// session or a campaign session on the soft phone. A 403, or no answer yet,
  /// is hidden: the app keeps no role matrix of its own.
  SoftphoneAvailability _availability() {
    if (_workspace == null) return SoftphoneAvailability.hidden;
    final host = _host;
    final b = _bootstrap;
    final hostHolds = host != null && (host.kind == SessionKind.softphone || host.onSoftphone);
    final ok = _reach == _Reach.ok && b != null;
    final enabled = ok && b.softphoneEnabled;
    return SoftphoneAvailability(
      visible: hostHolds || (ok && (enabled || _somethingToFinish(b))),
      startAllowed: enabled && !_disabledSeen,
      loaded: _reach != _Reach.none,
    );
  }
}
