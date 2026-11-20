/// The agent station redesign's wire additions (docs/agent-station.md,
/// rulings AS1–AS18): the tile icons (BE-13), how the number is shown (AS9),
/// a booked call-later on the panel (BE-4), the typed customer facts and the
/// context roles and types (BE-6), the campaign's script (BE-8), and the
/// agent's own day (`GET /proxy/agency/my-day`, BE-1 to BE-3).
///
/// Every field these add to an existing shape is optional (AS18), and each
/// reader here is lenient: a value this build cannot read is read as absent
/// (an unknown icon as none, an unreadable `callback` or `facts` as no tag and
/// no facts), never a failed bootstrap or frame.
///
/// Contract: `packages/contracts/src/agency/tile-icons.ts`,
/// `agency/customer-facts.ts`, `agency/agent-script.ts`, `agency/session.ts`
/// (`AgencyPhoneDisplay`), `agency/station.ts` (`AgencyAttemptCallback`) and
/// `api/agency/my-day.ts`.
library;

import 'package:meta/meta.dart';

import 'enums.dart';
import 'equality.dart';
import 'json.dart';

// ─── Tile icons (BE-13) ─────────────────────────────────────────────────────

/// The picture on an outcome or break tile, chosen by a supervisor.
///
/// Contract: `AgencyTileIcon` / `AGENCY_TILE_ICONS`. Read through
/// [tryFromWire]: a value this build does not know is no icon, and the station
/// works one out from the outcome's flags or the break's code instead.
enum TileIcon implements WireEnum {
  rupee('rupee'),
  clock('clock'),
  calendar('calendar'),
  stop('stop'),
  thumbsUp('thumbs_up'),
  thumbsDown('thumbs_down'),
  check('check'),
  cross('cross'),
  phoneMissed('phone_missed'),
  phoneBusy('phone_busy'),
  voicemail('voicemail'),
  wrongNumber('wrong_number'),
  language('language'),
  question('question'),
  tea('tea'),
  lunch('lunch'),
  washroom('washroom'),
  meeting('meeting'),
  training('training'),
  prayer('prayer'),
  headset('headset'),
  walk('walk'),
  person('person'),
  dot('dot'),
  unknown('');

  const TileIcon(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static TileIcon fromWire(String? raw) => _byWire[raw] ?? unknown;

  /// [raw] as an icon, or null (no icon) for anything else: absent, not a
  /// string, or a value this build does not know.
  static TileIcon? tryFromWire(Object? raw) => raw is String ? _byWire[raw] : null;
}

// ─── Number display (AS9) ───────────────────────────────────────────────────

/// How the station shows the customer's number on a campaign. A display
/// choice only: the number is still on the wire.
///
/// Contract: `AgencyPhoneDisplay` / `AGENCY_PHONE_DISPLAYS`.
enum PhoneDisplay implements WireEnum {
  full('full'),

  /// `98••• ••321` on every station screen.
  masked('masked'),
  unknown('');

  const PhoneDisplay(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static PhoneDisplay fromWire(String? raw) => _byWire[raw] ?? unknown;
}

// ─── A booked call-later on the panel (BE-4) ────────────────────────────────

/// Where a booked call-later came from.
///
/// Contract: `AgencyAttemptCallbackSource` / `AGENCY_ATTEMPT_CALLBACK_SOURCES`.
enum AttemptCallbackSource implements WireEnum {
  /// An agent's outcome booked it.
  outcome('outcome'),

  /// A promise to pay's follow-up (PT2).
  promise('promise'),

  /// The customer rang in and reached nobody.
  inbound('inbound'),
  unknown('');

  const AttemptCallbackSource(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static AttemptCallbackSource fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Set on a reserved (or active) attempt that is a booked call-later coming
/// due: "Call later · You said you will call at 3:00 PM".
///
/// Contract: `AgencyAttemptCallback` (`AgencyReservedAttempt.callback`).
@immutable
final class AttemptCallback {
  AttemptCallback({required this.dueAt, required this.bookedByMe, required this.source, String? sourceRaw})
    : sourceRaw = sourceRaw ?? source.wire;

  factory AttemptCallback.fromJson(Map<String, Object?> j) {
    final source = j.str('source');
    return AttemptCallback(
      dueAt: j.time('due_at'),
      bookedByMe: j.boolean('booked_by_me'),
      source: AttemptCallbackSource.fromWire(source),
      sourceRaw: source,
    );
  }

  /// [raw] as a call-later, or null when absent or unreadable: the panel it
  /// rides on is never lost over it.
  static AttemptCallback? tryFromJson(Object? raw) {
    if (raw is! Map<String, Object?>) return null;
    try {
      return AttemptCallback.fromJson(raw);
    } on FormatException {
      return null;
    }
  }

  /// The time that was booked.
  final DateTime dueAt;

  /// This agent booked it: only then "You said you will call at …".
  final bool bookedByMe;
  final AttemptCallbackSource source;
  final String sourceRaw;

  @override
  bool operator ==(Object other) =>
      other is AttemptCallback && other.dueAt == dueAt && other.bookedByMe == bookedByMe && other.sourceRaw == sourceRaw;

  @override
  int get hashCode => Object.hash(dueAt, bookedByMe, sourceRaw);
}

// ─── Typed customer facts (BE-6) ────────────────────────────────────────────

/// A role a roster column can play on the station.
///
/// Contract: `AgencyContextRole` / `AGENCY_CONTEXT_ROLES`.
enum ContextRole implements WireEnum {
  name('name'),
  place('place'),
  amountDue('amount_due'),
  dueDate('due_date'),
  unknown('');

  const ContextRole(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static ContextRole fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// How a roster column's values are read.
///
/// Contract: `AgencyContextFieldType` / `AGENCY_CONTEXT_FIELD_TYPES`.
enum ContextFieldType implements WireEnum {
  text('text'),
  money('money'),
  date('date'),
  unknown('');

  const ContextFieldType(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static ContextFieldType fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// The two roles shown as a tile: the amount chips read [amountDue].
///
/// Contract: `AgencyFactTileRole` / `AGENCY_FACT_TILE_ROLES`.
enum FactTileRole implements WireEnum {
  amountDue('amount_due'),
  dueDate('due_date'),
  unknown('');

  const FactTileRole(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static FactTileRole fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Which roster column plays each role (`context_display.roles`).
///
/// Contract: `AgencyContextRoles`.
@immutable
final class ContextRoles {
  const ContextRoles({this.name, this.place, this.amountDue, this.dueDate});

  /// [raw] as roles, or null when absent or not an object. A role whose value
  /// is not a string is read as unset.
  static ContextRoles? tryFromJson(Object? raw) {
    if (raw is! Map<String, Object?>) return null;
    String? s(String k) => raw[k] is String ? raw[k]! as String : null;
    return ContextRoles(name: s('name'), place: s('place'), amountDue: s('amount_due'), dueDate: s('due_date'));
  }

  final String? name;
  final String? place;
  final String? amountDue;
  final String? dueDate;

  /// The column playing [role], or null.
  String? columnFor(ContextRole role) => switch (role) {
    ContextRole.name => name,
    ContextRole.place => place,
    ContextRole.amountDue => amountDue,
    ContextRole.dueDate => dueDate,
    ContextRole.unknown => null,
  };

  @override
  bool operator ==(Object other) =>
      other is ContextRoles &&
      other.name == name &&
      other.place == place &&
      other.amountDue == amountDue &&
      other.dueDate == dueDate;

  @override
  int get hashCode => Object.hash(name, place, amountDue, dueDate);
}

/// `context_display.types` read leniently: entries whose value is not a
/// string are dropped; a type this build does not know is
/// [ContextFieldType.unknown] (show the column as text).
Map<String, ContextFieldType>? contextFieldTypesFromJson(Object? raw) {
  if (raw is! Map<String, Object?>) return null;
  return Map<String, ContextFieldType>.unmodifiable(<String, ContextFieldType>{
    for (final e in raw.entries)
      if (e.value is String) e.key: ContextFieldType.fromWire(e.value! as String),
  });
}

/// One fact tile: a hero column, its raw text and its parsed value.
///
/// Contract: `AgencyFactTile`.
@immutable
final class FactTile {
  FactTile({
    required this.column,
    this.role,
    String? roleRaw,
    required this.type,
    String? typeRaw,
    required this.raw,
    this.value,
  }) : roleRaw = roleRaw ?? role?.wire,
       typeRaw = typeRaw ?? type.wire;

  factory FactTile.fromJson(Map<String, Object?> j) {
    final role = j.strOrNull('role');
    final type = j.str('type');
    return FactTile(
      column: j.str('column'),
      role: role == null ? null : FactTileRole.fromWire(role),
      roleRaw: role,
      type: ContextFieldType.fromWire(type),
      typeRaw: type,
      raw: j.str('raw'),
      value: j.strOrNull('value'),
    );
  }

  final String column;
  final FactTileRole? role;
  final String? roleRaw;
  final ContextFieldType type;
  final String typeRaw;

  /// As uploaded. Display text, never markup.
  final String raw;

  /// Parsed: a decimal string for money (`"12500.00"`), `YYYY-MM-DD` for a
  /// date; null for text and for a value the server could not read (show
  /// [raw]).
  final String? value;

  /// The text to show when the client does not format [value] itself.
  String get display => value ?? raw;

  @override
  bool operator ==(Object other) =>
      other is FactTile &&
      other.column == column &&
      other.roleRaw == roleRaw &&
      other.typeRaw == typeRaw &&
      other.raw == raw &&
      other.value == value;

  @override
  int get hashCode => Object.hash(column, roleRaw, typeRaw, raw, value);
}

/// The customer's facts on the panel, parsed by the server.
///
/// Contract: `AgencyCustomerFacts` (`AgencyReservedAttempt.facts`).
@immutable
final class CustomerFacts {
  CustomerFacts({this.name, this.place, required List<FactTile> tiles}) : tiles = List.unmodifiable(tiles);

  factory CustomerFacts.fromJson(Map<String, Object?> j) =>
      CustomerFacts(name: j.strOrNull('name'), place: j.strOrNull('place'), tiles: j.list('tiles', FactTile.fromJson));

  /// [raw] as facts, or null when absent or unreadable: the station then reads
  /// `context` through `ContextDisplay` as before.
  static CustomerFacts? tryFromJson(Object? raw) {
    if (raw is! Map<String, Object?>) return null;
    try {
      return CustomerFacts.fromJson(raw);
    } on FormatException {
      return null;
    }
  }

  /// Never the number.
  final String? name;
  final String? place;

  /// In hero order, at most 4.
  final List<FactTile> tiles;

  /// The tile playing [role], or null.
  FactTile? tileFor(FactTileRole role) {
    for (final t in tiles) {
      if (t.role == role) return t;
    }
    return null;
  }

  /// The parsed amount due (a decimal string), or null: the "Full / Half"
  /// chips are hidden then.
  String? get amountDue => tileFor(FactTileRole.amountDue)?.value;

  /// The parsed due date (`YYYY-MM-DD`), or null.
  String? get dueDate => tileFor(FactTileRole.dueDate)?.value;

  @override
  bool operator ==(Object other) =>
      other is CustomerFacts && other.name == name && other.place == place && listEquals(other.tiles, tiles);

  @override
  int get hashCode => Object.hash(name, place, listHash(tiles));
}

// ─── The script (BE-8) ──────────────────────────────────────────────────────

/// A name a script's text may use in braces (`{name}`).
///
/// Contract: `AgencyScriptPlaceholder` / `AGENCY_SCRIPT_PLACEHOLDERS`.
enum ScriptPlaceholder implements WireEnum {
  name('name'),
  place('place'),
  amountDue('amount_due'),
  dueDate('due_date'),
  agentName('agent_name'),
  campaignName('campaign_name'),
  unknown('');

  const ScriptPlaceholder(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static ScriptPlaceholder fromWire(String? raw) => _byWire[raw] ?? unknown;
}

final _placeholder = RegExp(r'\{([a-z_]+)\}');

/// [text] with each known `{placeholder}` replaced by [valueOf]'s answer, or
/// by nothing when it answers null (the step still shows). A `{word}` this
/// build does not know is left as it is.
String fillScriptPlaceholders(String text, String? Function(ScriptPlaceholder placeholder) valueOf) =>
    text.replaceAllMapped(_placeholder, (m) {
      final p = ScriptPlaceholder.fromWire(m[1]);
      return p.isUnknown ? m[0]! : (valueOf(p) ?? '');
    });

/// One numbered step of the script.
///
/// Contract: `AgencyAgentScriptStep`.
@immutable
final class AgentScriptStep {
  const AgentScriptStep(this.text);

  final String text;

  @override
  bool operator ==(Object other) => other is AgentScriptStep && other.text == text;

  @override
  int get hashCode => text.hashCode;
}

/// The campaign's script: "First, say this" and "What to say".
///
/// Contract: `AgencyAgentScript` (`AgencySessionBootstrap.script`).
@immutable
final class AgentScript {
  AgentScript({this.opening, List<AgentScriptStep> steps = const []}) : steps = List.unmodifiable(steps);

  /// [raw] as a script, or null when absent, unreadable or empty (no opening
  /// and no steps): the station then shows the last calls and a note. A step
  /// without a string `text` is skipped.
  static AgentScript? tryFromJson(Object? raw) {
    if (raw is! Map<String, Object?>) return null;
    final opening = raw['opening'] is String && (raw['opening']! as String).trim().isNotEmpty
        ? raw['opening']! as String
        : null;
    final rawSteps = raw['steps'];
    final steps = <AgentScriptStep>[
      if (rawSteps is List<Object?>)
        for (final s in rawSteps)
          if (s is Map<String, Object?> && s['text'] is String && (s['text']! as String).trim().isNotEmpty)
            AgentScriptStep(s['text']! as String),
    ];
    if (opening == null && steps.isEmpty) return null;
    return AgentScript(opening: opening, steps: steps);
  }

  /// Contract: `AGENCY_SCRIPT_STEPS_MAX`, `AGENCY_SCRIPT_STEP_MAX_CHARS`,
  /// `AGENCY_SCRIPT_OPENING_MAX_CHARS`.
  static const stepsMax = 12;
  static const stepMaxChars = 200;
  static const openingMaxChars = 300;

  final String? opening;
  final List<AgentScriptStep> steps;

  @override
  bool operator ==(Object other) => other is AgentScript && other.opening == opening && listEquals(other.steps, steps);

  @override
  int get hashCode => Object.hash(opening, listHash(steps));
}

// ─── My day (BE-1 to BE-3) ──────────────────────────────────────────────────

/// What a daily target counts.
///
/// Contract: `AgencyMyDayTargetMetric` / `AGENCY_MY_DAY_TARGET_METRICS`.
enum MyDayTargetMetric implements WireEnum {
  /// Connected calls (conversations).
  calls('calls'),
  unknown('');

  const MyDayTargetMetric(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static MyDayTargetMetric fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// Where a call-later the agent leaves today goes (Finish work's line).
///
/// Contract: `AgencyMyCallLaterLeftGoesTo` / `AGENCY_MY_CALL_LATER_LEFT_GOES_TO`.
enum CallLaterLeftGoesTo implements WireEnum {
  /// Another agent may make it.
  pool('pool'),

  /// It waits for this agent.
  waitsForMe('waits_for_me'),
  unknown('');

  const CallLaterLeftGoesTo(this.wire);
  @override
  final String wire;

  static final _byWire = wireIndex(values);
  static CallLaterLeftGoesTo fromWire(String? raw) => _byWire[raw] ?? unknown;
}

/// The query of `GET /proxy/agency/my-day`.
@immutable
final class MyDayQuery {
  const MyDayQuery({required this.campaignId});

  final String campaignId;

  Map<String, String> toQuery() => <String, String>{'campaign_id': campaignId};

  @override
  bool operator ==(Object other) => other is MyDayQuery && other.campaignId == campaignId;

  @override
  int get hashCode => campaignId.hashCode;
}

/// The campaign's daily target.
///
/// Contract: `AgencyMyDayTarget`.
@immutable
final class MyDayTarget {
  MyDayTarget({required this.metric, String? metricRaw, required this.value}) : metricRaw = metricRaw ?? metric.wire;

  factory MyDayTarget.fromJson(Map<String, Object?> j) {
    final metric = j.str('metric');
    return MyDayTarget(metric: MyDayTargetMetric.fromWire(metric), metricRaw: metric, value: j.integer('value'));
  }

  final MyDayTargetMetric metric;
  final String metricRaw;
  final int value;

  @override
  bool operator ==(Object other) => other is MyDayTarget && other.metricRaw == metricRaw && other.value == value;

  @override
  int get hashCode => Object.hash(metricRaw, value);
}

/// One call-later on the agent's list.
///
/// Contract: `AgencyMyCallLaterRow`.
@immutable
final class MyCallLaterRow {
  const MyCallLaterRow({required this.contactId, this.customerName, required this.dueAt, required this.overdue});

  factory MyCallLaterRow.fromJson(Map<String, Object?> j) => MyCallLaterRow(
    contactId: j.str('contact_id'),
    customerName: j.strOrNull('customer_name'),
    dueAt: j.time('due_at'),
    overdue: j.boolean('overdue'),
  );

  final String contactId;

  /// Never the number; null without a name.
  final String? customerName;
  final DateTime dueAt;
  final bool overdue;

  @override
  bool operator ==(Object other) =>
      other is MyCallLaterRow &&
      other.contactId == contactId &&
      other.customerName == customerName &&
      other.dueAt == dueAt &&
      other.overdue == overdue;

  @override
  int get hashCode => Object.hash(contactId, customerName, dueAt, overdue);
}

/// The agent's own call-laters on the campaign.
///
/// Contract: `AgencyMyCallLater`.
@immutable
final class MyCallLater {
  MyCallLater({
    required List<MyCallLaterRow> rows,
    required this.today,
    required this.overdue,
    required this.comesToMe,
    required this.leftTodayGoesTo,
    String? leftTodayGoesToRaw,
  }) : rows = List.unmodifiable(rows),
       leftTodayGoesToRaw = leftTodayGoesToRaw ?? leftTodayGoesTo.wire;

  factory MyCallLater.fromJson(Map<String, Object?> j) {
    final goes = j.str('left_today_goes_to');
    return MyCallLater(
      rows: j.list('rows', MyCallLaterRow.fromJson),
      today: j.integer('today'),
      overdue: j.integer('overdue'),
      comesToMe: j.boolean('comes_to_me'),
      leftTodayGoesTo: CallLaterLeftGoesTo.fromWire(goes),
      leftTodayGoesToRaw: goes,
    );
  }

  /// Oldest due first, at most 20 (`AGENCY_MY_CALL_LATER_ROWS_MAX`).
  final List<MyCallLaterRow> rows;

  /// Due from now to the campaign's midnight.
  final int today;

  /// Due before now.
  final int overdue;

  /// True: "These calls will come to you on time." False: "We will call them
  /// on time. Another agent may get the call."
  final bool comesToMe;
  final CallLaterLeftGoesTo leftTodayGoesTo;
  final String leftTodayGoesToRaw;

  @override
  bool operator ==(Object other) =>
      other is MyCallLater &&
      listEquals(other.rows, rows) &&
      other.today == today &&
      other.overdue == overdue &&
      other.comesToMe == comesToMe &&
      other.leftTodayGoesToRaw == leftTodayGoesToRaw;

  @override
  int get hashCode => Object.hash(listHash(rows), today, overdue, comesToMe, leftTodayGoesToRaw);
}

/// `GET /proxy/agency/my-day`: the agent's own day on one campaign, cut at
/// the campaign's own midnight by the server's clock.
///
/// Contract: `AgencyMyDay` (`api/agency/my-day.ts`).
@immutable
final class MyDay {
  const MyDay({
    required this.campaignId,
    required this.timezone,
    required this.dayStart,
    required this.dayEnd,
    required this.calls,
    required this.dialed,
    required this.talkSeconds,
    this.willPay,
    required this.successes,
    this.target,
    required this.callLater,
    required this.asOf,
  });

  factory MyDay.fromJson(Map<String, Object?> j) {
    final target = j.objOrNull('target');
    return MyDay(
      campaignId: j.str('campaign_id'),
      timezone: j.str('timezone'),
      dayStart: j.time('day_start'),
      dayEnd: j.time('day_end'),
      calls: j.integer('calls'),
      dialed: j.integer('dialed'),
      talkSeconds: j.integer('talk_seconds'),
      willPay: j.integerOrNull('will_pay'),
      successes: j.integer('successes'),
      target: target == null ? null : MyDayTarget.fromJson(target),
      callLater: MyCallLater.fromJson(j.obj('call_later')),
      asOf: j.time('as_of'),
    );
  }

  final String campaignId;

  /// The campaign's IANA zone.
  final String timezone;
  final DateTime dayStart;

  /// Exclusive.
  final DateTime dayEnd;

  /// Conversations: what the target bar counts.
  final int calls;

  /// Every dial for this agent today; context only.
  final int dialed;
  final int talkSeconds;

  /// Outcomes today that recorded a pay date; null when the campaign has no
  /// promise outcome (the tile is not shown).
  final int? willPay;

  /// Shown instead of [willPay] when it is null.
  final int successes;

  /// Null: no target, no bar.
  final MyDayTarget? target;
  final MyCallLater callLater;
  final DateTime asOf;

  @override
  bool operator ==(Object other) =>
      other is MyDay &&
      other.campaignId == campaignId &&
      other.timezone == timezone &&
      other.dayStart == dayStart &&
      other.dayEnd == dayEnd &&
      other.calls == calls &&
      other.dialed == dialed &&
      other.talkSeconds == talkSeconds &&
      other.willPay == willPay &&
      other.successes == successes &&
      other.target == target &&
      other.callLater == callLater &&
      other.asOf == asOf;

  @override
  int get hashCode => Object.hash(
    campaignId,
    timezone,
    dayStart,
    dayEnd,
    calls,
    dialed,
    talkSeconds,
    willPay,
    successes,
    target,
    callLater,
    asOf,
  );
}
