import 'package:collection/collection.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/station/station_view.dart';
import '../../../ui/primitives.dart';
import '../logic/format.dart';
import '../station_copy.dart';
import '../widgets/state_band.dart';
import 'call_band.dart';
import 'contact_details.dart';
import 'layouts.dart';
import 'sheets.dart';

/// Reserved with no call on the station yet ([StationStage.incoming]): the server's
/// `agent_state: reserved` for an inbound caller lands a moment before the frame that names
/// them, and a reconnect's `ready` can say `reserved` before a campaign dial is restated. So
/// the words fit either direction. Nothing here acts on a call (there is none yet).
class IncomingView extends StatelessWidget {
  const IncomingView({super.key});

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return StationPage(
      key: const Key('station-incoming'),
      onCall: true,
      band: const StateBand(
        key: Key('band-incoming'),
        tone: StationTone.coming,
        icon: Icons.phone_callback_outlined,
        title: StationCopy.callComing,
        subtitle: StationCopy.callComingSubtitle,
      ),
      body: [
        const SizedBox(height: Space.xl),
        const Center(child: LiveDot(size: 12)),
        const SizedBox(height: Space.md),
        Text(StationCopy.callComingThrough, style: text.titleMedium, textAlign: TextAlign.center),
        const SizedBox(height: Space.xs),
        Text(InboundCopy.connecting, style: text.bodyMedium, textAlign: TextAlign.center),
      ],
      actions: const ConnectsByItself(),
    );
  }
}

/// Call coming (03): the customer card and what they said last time, a few seconds to read who is
/// coming. No button (AS11): "The call connects by itself." (`E` still stops a ringing dial on
/// early-binding accounts on the console; the phone has no key.)
class RingingView extends ConsumerWidget {
  const RingingView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // The countdown is not shown; without it here the card does not rebuild every second.
    final call = ref.watch(stationViewProvider.select((v) => _contactOnly(v?.call)));
    return CallPage(
      body: [
        if (call != null) ...[
          CustomerCard(call: call, lastWords: true),
          // The opening line ("First, say this") slots in here once the campaign has a script (BE-8).
        ],
      ],
      actions: const ConnectsByItself(),
    );
  }
}

/// "The call connects by itself.": the footer of a screen with nothing to press.
class ConnectsByItself extends StatelessWidget {
  const ConnectsByItself({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Space.sm),
      child: Row(
        key: const Key('connects-by-itself'),
        children: [
          Icon(Icons.call_outlined, color: t.textMuted),
          const SizedBox(width: Space.sm),
          Expanded(child: Text(StationCopy.connectsByItself, style: Theme.of(context).textTheme.bodyMedium!.copyWith(color: t.textSecondary))),
        ],
      ),
    );
  }
}

CallView? _contactOnly(CallView? c) => c == null || c.countdownSeconds == null
    ? c
    : CallView(
        attemptId: c.attemptId,
        phoneE164: c.phoneE164,
        attemptNumber: c.attemptNumber,
        callerId: c.callerId,
        campaignName: c.campaignName,
        displayName: c.displayName,
        heroFields: c.heroFields,
        heroesConfigured: c.heroesConfigured,
        otherFields: c.otherFields,
        priorAttempts: c.priorAttempts,
        bridgedAt: c.bridgedAt,
        recording: c.recording,
        redialNumber: c.redialNumber,
        redialLimit: c.redialLimit,
        promise: c.promise,
      );

/// "Calling again · 1 of 2": this call is a call again from What happened?, the agent calling back
/// the customer they just spoke to. Shown while it rings and once connected.
class RedialTag extends StatelessWidget {
  const RedialTag({super.key, required this.number, this.limit});

  /// [CallView.redialNumber] and [CallView.redialLimit].
  final int number;
  final int? limit;

  @override
  Widget build(BuildContext context) {
    return StatusPill(
      StationCopy.callAgainOf(number, limit),
      key: const Key('redial-label'),
      tone: Tone.accent,
      leading: Icon(Icons.replay, size: 14, color: Tone.accent.fg(context.tokens)),
    );
  }
}

/// The customer card (03, 04; it does not move between them): initials, the name (the number
/// leads when there is none), the number, the contact's promise to pay, and three number tiles: the
/// campaign's first two hero fields with a value and the last call's date (a third hero field when
/// there was no call before). On Call coming it adds "What they said last time". A tap opens every
/// field (Details).
///
/// Where new data slots in: the name and place by column role (BE-6), money and dates by column type
/// (BE-6), the masked number (AS9 `phone_display`), and the "Call later · You said you will call at
/// 3:00 PM" tag (`attempt.callback`, BE-4) above the name.
class CustomerCard extends StatelessWidget {
  const CustomerCard({super.key, required this.call, this.lastWords = false});

  final CallView call;

  /// Call coming: "What they said last time".
  final bool lastWords;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final c = context.stateTokens.coming;
    final text = Theme.of(context).textTheme;
    final name = call.displayName?.trim();
    final hasName = name != null && name.isNotEmpty;
    final phone = formatPhone(call.phoneE164);
    final ordered = orderPriorAttempts(call.priorAttempts);
    final last = ordered.firstOrNull;
    final said = ordered.firstWhereOrNull((a) => a.notes != null && a.notes!.trim().isNotEmpty)?.notes?.trim();
    final heroes = call.heroFields.where((f) => f.value.trim().isNotEmpty && f.value.trim() != name).toList(growable: false);
    final tiles = <Widget>[
      for (final f in heroes.take(last == null ? 3 : 2)) NumberTile(label: f.label, value: f.value),
      if (last != null) NumberTile(key: const Key('last-call-tile'), label: StationCopy.lastCall, value: formatDay(last.at)),
    ];
    return Semantics(
      container: true,
      child: Material(
        color: t.bgSecondary,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Radii.lg), side: BorderSide(color: t.border)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: const Key('control-details'),
          onTap: () => showDetailsSheet(context, call),
          child: Padding(
            padding: const EdgeInsets.all(Space.md),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (call.isRedial) ...[
                  Align(alignment: AlignmentDirectional.centerStart, child: RedialTag(number: call.redialNumber!, limit: call.redialLimit)),
                  const SizedBox(height: Space.sm),
                ],
                Row(
                  children: [
                    ExcludeSemantics(
                      child: DecoratedBox(
                        decoration: BoxDecoration(color: c.soft, borderRadius: BorderRadius.circular(Radii.md)),
                        child: SizedBox.square(
                          dimension: 52,
                          child: Center(
                            child: hasName
                                ? Text(_initials(name), style: text.titleLarge!.copyWith(color: c.deep))
                                : Icon(Icons.person_outline, color: c.deep),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: Space.md),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Semantics(
                            header: true,
                            child: Text(hasName ? name : phone, key: const Key('call-headline'), style: text.headlineMedium),
                          ),
                          if (hasName)
                            Row(
                              children: [
                                Icon(Icons.call_outlined, size: 16, color: t.textSecondary),
                                const SizedBox(width: Space.xs),
                                Flexible(child: Text(phone, style: text.bodyMedium!.copyWith(color: t.textSecondary))),
                              ],
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
                if (call.promise != null) ...[const SizedBox(height: Space.sm), PromiseLine(promise: call.promise!)],
                if (tiles.isNotEmpty) ...[const SizedBox(height: Space.md), TileRow(children: tiles)],
                if (lastWords && said != null) ...[
                  const SizedBox(height: Space.sm),
                  DecoratedBox(
                    key: const Key('what-they-said'),
                    decoration: BoxDecoration(color: t.bgPrimary, borderRadius: BorderRadius.circular(Radii.md)),
                    child: Padding(
                      padding: const EdgeInsets.all(Space.sm),
                      child: MergeSemantics(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Text(StationCopy.whatTheySaid, style: text.bodySmall),
                            const SizedBox(height: 2),
                            Text('“$said”', style: text.titleMedium),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  static String _initials(String name) {
    final parts = name.split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
    final first = parts.first.characters.first;
    final second = parts.length > 1 ? parts[1].characters.first : '';
    return (first + second).toUpperCase();
  }
}

/// Last calls (04c): a date chip, what happened, and the note, newest first; this work's own calls
/// before other work's. At most [limit].
class LastCallsCard extends StatelessWidget {
  const LastCallsCard({super.key, required this.attempts, this.limit = 3});

  final List<PriorAttempt> attempts;
  final int limit;

  @override
  Widget build(BuildContext context) {
    if (attempts.isEmpty) return const SizedBox.shrink();
    final c = context.stateTokens.coming;
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final shown = orderPriorAttempts(attempts).take(limit).toList(growable: false);
    return StationCard(
      key: const Key('prior-attempts'),
      icon: Icons.history,
      title: StationCopy.lastCalls,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final (i, a) in shown.indexed) ...[
            if (i > 0) Divider(height: Space.md, color: t.border),
            MergeSemantics(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  DecoratedBox(
                    decoration: BoxDecoration(color: c.soft, borderRadius: BorderRadius.circular(Radii.sm)),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: Space.sm, vertical: Space.xs),
                      child: Text(formatDay(a.at), style: text.titleSmall!.copyWith(color: c.deep)),
                    ),
                  ),
                  const SizedBox(width: Space.md),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(a.outcomeLabel, style: text.titleMedium),
                        if (!a.sameCampaign) Text(StationCopy.otherCampaign(a.campaignName), style: text.bodySmall),
                        if (a.promise != null) Text(a.promise!, key: const Key('prior-promise'), style: text.bodySmall),
                        if (a.notes != null && a.notes!.trim().isNotEmpty) Text('“${a.notes!.trim()}”', style: text.bodyMedium),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}
