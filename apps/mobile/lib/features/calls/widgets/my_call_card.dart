import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';

import '../../../app/theme/app_theme.dart';
import '../../../app/theme/tokens.dart';
import '../../../ui/primitives.dart';
import '../my_calls_copy.dart';

/// The colour a call type carries, as the console's Type column does: the
/// dialler the accent, the soft phone info, inbound success.
Color callTypeColor(AppTokens t, CallLogType type) => switch (type) {
      CallLogType.dialler => t.accent,
      CallLogType.softPhone => t.info,
      CallLogType.inbound => t.success,
      CallLogType.unknown => t.textMuted,
    };

/// One call on My calls, as a card (`docs/call-log.md` §7): the type top left
/// in its colour and when on the right, who the call was with, then the
/// campaign, what happened and the talk time. A missed call still to follow
/// up carries Call back and Mark handled.
///
/// The number is shown as it arrived: where the call's campaign hides
/// numbers from agents the server has already masked it.
class MyCallCard extends StatelessWidget {
  const MyCallCard({
    super.key,
    required this.row,
    required this.now,
    this.callBackOffered = false,
    this.onCallBack,
    this.onMarkHandled,
    this.marking = false,
    this.opening = false,
    this.error,
  });

  final MyCallRow row;
  final DateTime now;

  /// The soft phone may start a call for this agent.
  final bool callBackOffered;

  /// Null while another row's action is in flight.
  final VoidCallback? onCallBack;
  final VoidCallback? onMarkHandled;
  final bool marking;

  /// This row's Call back is reading the number for the pad.
  final bool opening;
  final String? error;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final typeLine = MyCallsCopy.typeLine(row);
    final when = MyCallsCopy.when(row.createdAt, now);
    final who = MyCallsCopy.who(row);
    final meta = MyCallsCopy.meta(row);
    final calledBack = MyCallsCopy.calledBack(row, now);
    final toFollowUp = row.isToFollowUp;
    final named = row.customerName != null;
    final notes = row.notes?.replaceAll(RegExp(r'\s+'), ' ').trim();
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.sm),
      child: AppCard(
        color: toFollowUp ? t.warningSubtle : null,
        borderColor: toFollowUp ? t.warning : null,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            MergeSemantics(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      DecoratedBox(
                        decoration: BoxDecoration(color: callTypeColor(t, row.type), shape: BoxShape.circle),
                        child: const SizedBox.square(dimension: 8),
                      ),
                      const SizedBox(width: Space.xs),
                      Expanded(
                        child: Text(
                          typeLine,
                          key: Key('my-call-type-${row.id}'),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: text.labelMedium!.copyWith(color: t.textSecondary, fontWeight: FontWeight.w600),
                        ),
                      ),
                      const SizedBox(width: Space.sm),
                      Text(when, style: text.labelMedium),
                    ],
                  ),
                  const SizedBox(height: Space.xs),
                  Text(
                    who,
                    key: Key('my-call-who-${row.id}'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: named
                        ? text.titleSmall
                        : monoStyle(context, size: 15, color: row.phone == null ? t.textMuted : t.textPrimary),
                  ),
                  // A named customer's number sits under the name, as the agent may see it.
                  if (named && row.phone != null)
                    Text(
                      MyCallsCopy.number(row),
                      key: Key('my-call-number-${row.id}'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: monoStyle(context, size: 13, color: t.textSecondary),
                    ),
                  const SizedBox(height: 2),
                  Text(
                    meta,
                    key: Key('my-call-meta-${row.id}'),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: text.bodySmall,
                  ),
                  if (calledBack != null)
                    Text(calledBack, key: Key('my-call-called-back-${row.id}'), style: text.bodySmall),
                  if (notes != null && notes.isNotEmpty)
                    Text(
                      notes,
                      key: Key('my-call-notes-${row.id}'),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: text.bodySmall!.copyWith(color: t.textMuted),
                    ),
                ],
              ),
            ),
            if (toFollowUp) ...[
              const SizedBox(height: Space.sm),
              Wrap(
                spacing: Space.sm,
                runSpacing: Space.xs,
                children: [
                  if (callBackOffered && row.phone != null)
                    FilledButton(
                      key: Key('my-call-back-${row.id}'),
                      onPressed: onCallBack,
                      child: Text(opening ? MyCallsCopy.opening : MyCallsCopy.callBack),
                    ),
                  OutlinedButton(
                    key: Key('my-call-handled-${row.id}'),
                    onPressed: onMarkHandled,
                    child: Text(marking ? MyCallsCopy.marking : MyCallsCopy.markHandled),
                  ),
                ],
              ),
            ],
            if (error != null) ...[
              const SizedBox(height: Space.xs),
              Semantics(
                liveRegion: true,
                child: Text(
                  error!,
                  key: Key('my-call-error-${row.id}'),
                  style: text.bodySmall!.copyWith(color: t.danger),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// A callback the agent booked that is due today or late: "Callback due" and
/// "Late by 2 hours" (or "Due 4:00 PM"), the customer, then the campaign and
/// when it was booked for.
class CallbackDueCard extends StatelessWidget {
  const CallbackDueCard({super.key, required this.callback, required this.now});

  final MyCallbackDue callback;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final late = callback.dueAt.isBefore(now);
    return Padding(
      padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.sm),
      child: MergeSemantics(
        child: AppCard(
          key: Key('my-callback-${callback.contactId}'),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      MyCallsCopy.callbackDue,
                      style: text.labelMedium!.copyWith(color: t.warning, fontWeight: FontWeight.w600),
                    ),
                  ),
                  Text(
                    MyCallsCopy.dueLine(callback, now),
                    key: Key('my-callback-due-${callback.contactId}'),
                    style: text.labelMedium!.copyWith(
                      color: late ? t.danger : t.textSecondary,
                      fontWeight: late ? FontWeight.w600 : FontWeight.w400,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: Space.xs),
              Text(
                callback.customerName ?? MyCallsCopy.aCustomer,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: text.titleSmall,
              ),
              const SizedBox(height: 2),
              Text(
                MyCallsCopy.bookedLine(callback, now),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: text.bodySmall,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
