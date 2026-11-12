import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/app_theme.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/api/api_error.dart';
import '../../../core/softphone/call_labels.dart';
import '../../../core/softphone/call_state.dart';
import '../../../core/softphone/softphone_view.dart';
import '../../../core/station/contact_context.dart';
import '../../../ui/primitives.dart';
import '../../performance/logic/en_in_format.dart';
import '../../performance/performance_api.dart';
import '../../performance/performance_controller.dart' show statsClockProvider;
import '../logic/attempt_copy.dart' show attemptOutcomeLabels;
import 'softphone_call_tile.dart';
import 'softphone_calls_controller.dart';

/// One soft-phone call, as its agent may read it (a port of the console's
/// `SoftphoneCallDetailPage` without the media): the call record, the outcome
/// and who saved it, the call details by the account's field labels, the
/// agent's override notes, and the roster contact with its earlier calls.
///
/// A call's recording, transcript and analysis are `agency.supervise`'s: the
/// detail route sends an agent `media: null`. The app never renders `media`,
/// even when a supervisor's answer carries it, so the sheet says why there is
/// none from `call_availability` alone (never placed, purged, or placed and
/// open to supervisors) and never claims an `available` call was not placed.
Future<void> showSoftphoneCallDetail(BuildContext context, {required ManualCallListRow row}) =>
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.75,
        minChildSize: 0.4,
        maxChildSize: 0.95,
        builder: (context, scroll) => SoftphoneCallDetail(row: row, controller: scroll),
      ),
    );

/// A label and its value; [muted] for "none" values.
typedef SoftphoneDetailFact = ({String label, String value, bool muted});

/// A titled group of facts, as the console's fact cards group them.
typedef SoftphoneDetailSection = ({String title, List<SoftphoneDetailFact> facts});

SoftphoneDetailFact _fact(String label, String value, {bool muted = false}) =>
    (label: label, value: value, muted: muted);

/// Why the sheet shows the record alone, by `call_availability` (the console's
/// `NO_MEDIA_COPY`). Null for a value this build does not know.
({String title, String body})? softphoneNoMediaCopy(CallAvailability availability) => switch (availability) {
      CallAvailability.neverPlaced => (
          title: 'No call was placed',
          body: 'This dial ended before a call was placed, so there is no recording or transcript. '
              'The record below is all there is.',
        ),
      CallAvailability.purged => (
          title: 'This call’s recording and transcript are no longer available',
          body: 'They passed their retention window and were deleted. '
              'The call record and the agent’s notes below are kept.',
        ),
      CallAvailability.available => (
          title: 'The recording and analysis are available to supervisors',
          body: 'This call was placed. Its recording, transcript and AI summary can be opened by a supervisor; '
              'the call record and the agent’s notes are below.',
        ),
      CallAvailability.unknown => null,
    };

const _contactStateLabels = <ContactState, String>{
  ContactState.pending: 'Waiting to be called',
  ContactState.inFlight: 'Being called',
  ContactState.connected: 'Connected, awaiting its outcome',
  ContactState.completed: 'Completed',
  ContactState.exhausted: 'Out of attempts',
  ContactState.suppressed: 'Do not call',
};

/// When the outcome was saved, and by whom (the console's `savedByLine`): a
/// save on the agent's behalf says so, naming the supervisor when the detail
/// does. Null when no outcome is saved.
String? softphoneSavedByLine(ManualCall call, String? dispositionedByName) {
  final at = call.dispositionedAt;
  if (at == null) return null;
  final when = EnIn.timestamp(at);
  final trimmed = dispositionedByName?.trim();
  final name = trimmed == null || trimmed.isEmpty ? null : trimmed;
  if (call.dispositionedOnBehalf) {
    return name != null ? '$when · by $name, on the agent’s behalf' : '$when · by a supervisor, on the agent’s behalf';
  }
  return name != null ? '$when · by $name' : when;
}

/// A call field's label, else its key in words (a field since removed from the set).
String softphoneFieldLabel(List<CallField> fields, String key) {
  for (final f in fields) {
    if (f.key == key) return f.label;
  }
  return key.replaceAll('_', ' ');
}

/// A call field's value for reading, or null when empty (the console's
/// `formatFieldValue`): Yes / No, a date as `16 Oct 2026`, anything else as sent.
String? softphoneFieldValue(CallField? field, Object? value) {
  if (value == null || (value is String && value.trim().isEmpty)) return null;
  if (value is bool) return value ? 'Yes' : 'No';
  if (field?.type == CallFieldType.date && value is String) {
    final m = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(value);
    if (m != null) {
      // Built at local noon from the parts, so the day cannot shift with the zone.
      final day = DateTime(int.parse(m.group(1)!), int.parse(m.group(2)!), int.parse(m.group(3)!), 12);
      return EnIn.dayMonthYear(day);
    }
  }
  if (value is num && value == value.truncate()) return value.toInt().toString();
  return contextDisplayString(value);
}

String _dncReach(DncEntry entry, ManualCall call) => switch (entry.scope) {
      DncEntryScope.tenant => 'Every campaign and account in this organisation',
      DncEntryScope.account => 'This account',
      _ => entry.campaignId != null && call.tag?.campaignId == entry.campaignId
          ? 'The campaign ${call.tag!.campaignName}'
          : 'One of this account’s campaigns',
    };

/// Everything the sheet shows below its header, in order (tested directly).
/// [bootstrap] supplies the names (outcome labels, field labels, the contact
/// display); without it a code or a key reads as itself. `media` is not read.
List<SoftphoneDetailSection> softphoneCallDetailSections(ManualCallDetail detail, SoftphoneBootstrap? bootstrap) {
  final call = detail.call;
  final catalog = catalogForCall(call, bootstrap);
  final sections = <SoftphoneDetailSection>[];

  // The call record.
  final whatHappened = call.outcomeRaw != null
      ? (attemptOutcomeLabels[call.outcome] ?? call.outcomeRaw!)
      : call.state == AttemptState.ended
          ? callEndSummary(call)
          : 'On a call now';
  sections.add((
    title: 'Call record',
    facts: [
      _fact('Number', formatDialNumber(call.destinationE164)),
      _fact('Caller ID', formatDialNumber(call.callerId)),
      _fact('When', EnIn.timestamp(call.createdAt)),
      if (call.talkSeconds != null) _fact('Talk time', EnIn.talkTime(call.talkSeconds!.toDouble())),
      _fact('What happened', whatHappened),
      _fact('Logged to', loggedToLabel(call), muted: call.tag == null),
    ],
  ));

  // The outcome, and who saved it.
  final outcome = manualCallOutcome(call, catalog);
  final code = call.dispositionCode;
  final saved = softphoneSavedByLine(call, detail.dispositionedByName);
  sections.add((
    title: 'Outcome',
    facts: [
      _fact(
        'Outcome',
        code != null ? outcome.text : (outcome.kind == SoftphoneOutcomeKind.awaiting ? 'No outcome yet' : 'Not written up'),
        muted: code == null,
      ),
      _fact('Saved', saved ?? '—', muted: saved == null),
      if (call.callbackAt != null) _fact('Call back', EnIn.timestamp(call.callbackAt)),
      _fact('Notes', call.notes ?? 'None', muted: call.notes == null),
    ],
  ));

  // The call details, by the account's labels; keys since removed still show.
  final fields = bootstrap?.callFields ?? const <CallField>[];
  final keys = [
    for (final f in fields) f.key,
    for (final k in call.fields.keys)
      if (!fields.any((f) => f.key == k)) k,
  ];
  if (keys.isNotEmpty) {
    sections.add((
      title: 'Call details',
      facts: [
        for (final key in keys)
          () {
            final field = fields.where((f) => f.key == key).firstOrNull;
            final value = softphoneFieldValue(field, call.fields[key]);
            return _fact(softphoneFieldLabel(fields, key), value ?? 'Not filled in', muted: value == null);
          }(),
      ],
    ));
  }

  // The agent's reasons for calling through a refusal, only when one was used.
  final o = detail.overrides;
  final overrideFacts = <SoftphoneDetailFact>[];
  if (o.dncNote != null) {
    overrideFacts.add(_fact('Called through Do Not Call', o.dncNote!));
    final entry = o.dncEntry;
    if (entry != null) {
      overrideFacts
        ..add(_fact('Listed for', _dncReach(entry, call)))
        ..add(_fact('Reason', entry.reason?.trim().isNotEmpty ?? false ? entry.reason!.trim() : 'No reason was recorded'))
        ..add(_fact('Listed on', EnIn.dayMonthYear(entry.createdAt.toLocal())));
    } else if (o.dncEntryId != null) {
      overrideFacts.add(_fact('DNC entry', 'Removed from the list since this call', muted: true));
    }
  }
  if (o.hoursNote != null) overrideFacts.add(_fact('Called outside calling hours', o.hoursNote!));
  if (overrideFacts.isNotEmpty) sections.add((title: 'Overrides', facts: overrideFacts));

  // The roster contact the number matched, its columns and its earlier calls.
  final contact = call.contact;
  if (contact != null) {
    final tag = call.tag;
    final campaign = tag == null
        ? null
        : bootstrap?.taggable(tag.campaignId) ??
            (bootstrap?.callCampaign?.campaignId == tag.campaignId ? bootstrap?.callCampaign : null);
    final contactFacts = <SoftphoneDetailFact>[
      _fact('Now', _contactStateLabels[contact.state] ?? contact.stateRaw),
      _fact(
        'This call',
        contact.claimed ? 'Settled the contact with its outcome' : 'Linked only — the campaign was not waiting on it',
      ),
    ];
    final context = contact.context;
    if (context != null) {
      final resolved = resolveContextFields(context, campaign?.contextDisplay);
      for (final f in [...resolved.hero, ...resolved.fields]) {
        if (!f.isEmpty) contactFacts.add(_fact(f.label, f.value));
      }
    }
    sections.add((title: 'Roster contact', facts: contactFacts));

    final prior = priorAttemptsFor(
      contact.priorAttempts ?? const [],
      campaignId: tag?.campaignId ?? '',
      catalog: campaign?.dispositionCatalog ?? const [],
      offsetMs: 0,
    );
    if (prior.isNotEmpty) {
      sections.add((
        title: 'Earlier calls',
        facts: [
          for (final p in prior)
            _fact(
              EnIn.timestamp(p.at),
              [
                p.outcomeLabel,
                if (!p.sameCampaign && p.campaignName != null) p.campaignName!,
                if (p.notes != null) p.notes!,
              ].join(' · '),
            ),
        ],
      ));
    }
  }
  return sections;
}

/// The sheet's body: the row's header at once, the detail when it lands.
class SoftphoneCallDetail extends ConsumerStatefulWidget {
  const SoftphoneCallDetail({super.key, required this.row, this.controller});

  final ManualCallListRow row;
  final ScrollController? controller;

  @override
  ConsumerState<SoftphoneCallDetail> createState() => _SoftphoneCallDetailState();
}

class _SoftphoneCallDetailState extends ConsumerState<SoftphoneCallDetail> {
  ManualCallDetail? _detail;
  String? _error;

  /// A 403 or 404: this call is not the agent's to read (or is gone), and
  /// trying again will not change that.
  bool _terminal = false;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    final mine = ++_generation;
    if (_error != null) {
      // A retry: back to the spinner while it is read again.
      setState(() {
        _error = null;
        _terminal = false;
      });
    }
    try {
      final detail = await ref.read(softphoneCallsApiProvider).callDetail(widget.row.id);
      if (!mounted || mine != _generation) return;
      setState(() => _detail = detail);
    } on Exception catch (e) {
      if (!mounted || mine != _generation) return;
      setState(() {
        _error = errorMessage(e, 'We couldn’t load this call.');
        _terminal = e is ApiHttpError && (e.status == 403 || e.status == 404);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final tk = context.tokens;
    final text = Theme.of(context).textTheme;
    final bootstrap = softphoneCallsBootstrapOf(ref);
    final detail = _detail;
    final header = SoftphoneCallRowView(
      detail?.call ?? widget.row,
      catalog: catalogForCall(detail?.call ?? widget.row, bootstrap),
      now: ref.read(statsClockProvider)(),
    );
    final absent = detail == null ? null : softphoneNoMediaCopy(detail.callAvailability);

    return ListView(
      key: const Key('softphone-call-detail'),
      controller: widget.controller,
      padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.xxl),
      children: [
        Row(
          children: [
            Expanded(
              child: Semantics(
                header: true,
                child: Text(header.number, style: monoStyle(context, size: 20, color: tk.textPrimary)),
              ),
            ),
            StatusPill(header.outcome, tone: header.tone),
          ],
        ),
        const SizedBox(height: Space.md),
        if (detail == null && _error == null)
          const Padding(
            padding: EdgeInsets.all(Space.xl),
            child: Center(
              child: SizedBox.square(
                key: Key('softphone-detail-loading'),
                dimension: 24,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            ),
          ),
        if (_error != null)
          _terminal
              ? AppCard(
                  key: const Key('softphone-detail-gone'),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('We can’t show this call', style: text.titleSmall),
                      const SizedBox(height: Space.xs),
                      Text(_error!, style: text.bodySmall),
                    ],
                  ),
                )
              : SizedBox(
                  height: 220,
                  child: LoadErrorView(
                    key: const Key('softphone-detail-error'),
                    message: _error!,
                    onRetry: () => unawaited(_load()),
                  ),
                ),
        if (detail != null) ...[
          if (absent != null)
            AppCard(
              key: Key('softphone-detail-${detail.callAvailabilityRaw}'),
              color: tk.bgTertiary,
              borderColor: tk.border,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    switch (detail.callAvailability) {
                      CallAvailability.neverPlaced => Icons.phone_missed_outlined,
                      CallAvailability.purged => Icons.phone_disabled_outlined,
                      _ => Icons.lock_outline,
                    },
                    size: 20,
                    color: tk.textMuted,
                  ),
                  const SizedBox(width: Space.sm),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(absent.title, style: text.titleSmall),
                        const SizedBox(height: Space.xs),
                        Text(absent.body, style: text.bodySmall),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          for (final section in softphoneCallDetailSections(detail, bootstrap)) ...[
            const SizedBox(height: Space.lg),
            SectionLabel(section.title),
            for (final f in section.facts)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: Space.xs + 2),
                child: MergeSemantics(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(width: 120, child: Text(f.label, style: text.labelMedium)),
                      Expanded(
                        child: SelectableText(
                          f.value,
                          style: f.muted ? text.bodyMedium!.copyWith(color: tk.textMuted) : text.bodyMedium,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ],
      ],
    );
  }
}
