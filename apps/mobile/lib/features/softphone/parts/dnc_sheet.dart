import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/softphone/softphone_view.dart';
import '../softphone_copy.dart';
import 'modal_guard.dart';

/// Mark DNC: a confirm sheet that states the number and where the mark reaches
/// ("for Q4 Renewals" / "for this account") before the agent commits. It is
/// rare, compliance-bearing and not undone from the app, so it asks.
///
/// About the call it was opened on: the sheet closes when that call leaves the
/// screen, and the mark names that call ([SoftphoneActions.markDnc]'s
/// `callId`), so the core marks nothing if another call is on screen by then.
Future<void> showDncSheet(BuildContext context) async {
  final container = ProviderScope.containerOf(context, listen: false);
  final actions = container.read(softphoneActionsProvider);
  final view = container.read(softphoneViewProvider);
  final callId = view.callId;
  if (callId == null || !view.dncEnabled) return;
  final number = view.numberDisplay.isEmpty ? view.number : view.numberDisplay;
  final scope = sameSoftphoneCall(callId);
  final ok = await showModalBottomSheet<bool>(
    context: context,
    useSafeArea: true,
    isScrollControlled: true,
    builder: (context) {
      final t = context.tokens;
      final text = Theme.of(context).textTheme;
      return SoftphoneModalGuard(
        scope: scope,
        child: SingleChildScrollView(
          key: const Key('dnc-sheet'),
          padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Semantics(header: true, child: Text(SoftphoneCopy.dncTitle, style: text.titleLarge)),
              const SizedBox(height: Space.sm),
              Text(SoftphoneCopy.dncMessage(number, view.dncScopeLabel), key: const Key('dnc-message'), style: text.bodyMedium),
              const SizedBox(height: Space.lg),
              FilledButton(
                key: const Key('dnc-confirm'),
                onPressed: () => Navigator.of(context).pop(true),
                style: FilledButton.styleFrom(backgroundColor: t.dangerDeep, foregroundColor: t.onAccent),
                child: const Text(SoftphoneCopy.dncConfirm),
              ),
              const SizedBox(height: Space.sm),
              OutlinedButton(
                key: const Key('dnc-cancel'),
                onPressed: () => Navigator.of(context).pop(false),
                child: const Text(SoftphoneCopy.cancel),
              ),
            ],
          ),
        ),
      );
    },
  );
  if (ok == true) await actions.markDnc(callId: callId);
}
