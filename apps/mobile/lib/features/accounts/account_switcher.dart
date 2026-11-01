import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/tokens.dart';
import '../../core/api/api_error.dart';
import '../../core/auth/app_gate.dart';
import '../../core/session/account_choice.dart';
import '../../core/station/station_signals.dart';

/// Why switching account is refused right now, or null when it is not. The
/// station belongs to the account it was opened in.
String? switchBlockedReason(StationSignals signals) {
  if (signals.callActive) return 'Finish this call first — this call is still on your screen.';
  if (signals.onDuty) return 'You’re on duty in this account. Leave the station before switching.';
  return null;
}

/// One account row: account name over its workspace, a tick on the current one.
class AccountTile extends StatelessWidget {
  const AccountTile({super.key, required this.choice, required this.selected, required this.busy, required this.onTap});

  final AccountChoice choice;
  final bool selected;
  final bool busy;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return ListTile(
      minTileHeight: Space.touch + 8,
      onTap: onTap,
      selected: selected,
      title: Text(choice.accountName),
      subtitle: choice.tenantName.isEmpty ? null : Text(choice.tenantName),
      trailing: busy
          ? const SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2))
          : selected
              ? Icon(Icons.check, color: t.accentHover, semanticLabel: 'Current account')
              : const Icon(Icons.chevron_right),
    );
  }
}

/// The account switcher, as a bottom sheet (from Me and from the campaign
/// list's header). Resolves when the switch is done or the sheet is closed.
Future<void> showAccountSwitcher(BuildContext context) => showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => const _AccountSheet(),
    );

class _AccountSheet extends ConsumerStatefulWidget {
  const _AccountSheet();

  @override
  ConsumerState<_AccountSheet> createState() => _AccountSheetState();
}

class _AccountSheetState extends ConsumerState<_AccountSheet> {
  AccountChoice? _switching;
  String? _error;

  Future<void> _switch(AccountChoice choice) async {
    setState(() {
      _switching = choice;
      _error = null;
    });
    try {
      await ref.read(appGateProvider.notifier).switchAccount(choice);
      if (mounted) Navigator.of(context).pop();
    } on ApiError catch (e) {
      ref.read(appGateProvider.notifier).reportError(e);
      if (mounted) setState(() => _error = e.userMessage);
    } on StateError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _switching = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final gate = ref.watch(appGateProvider);
    final blocked = switchBlockedReason(ref.watch(stationSignalsProvider));
    final text = Theme.of(context).textTheme;
    if (gate is! GateReady) return const SizedBox.shrink();
    return SingleChildScrollView(
      padding: const EdgeInsets.only(bottom: Space.lg),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.sm),
            child: Semantics(header: true, child: Text('Switch account', style: text.titleLarge)),
          ),
          if (blocked != null || _error != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.lg, vertical: Space.sm),
              child: Semantics(
                liveRegion: true,
                child: Text(
                  _error ?? blocked!,
                  style: text.bodyMedium!.copyWith(color: _error != null ? context.tokens.danger : context.tokens.warning),
                ),
              ),
            ),
          for (final choice in gate.accounts)
            AccountTile(
              choice: choice,
              selected: choice.accountId == gate.accountId && choice.tenantId == gate.tenantId,
              busy: _switching == choice,
              onTap: blocked != null || _switching != null || (choice.accountId == gate.accountId && choice.tenantId == gate.tenantId)
                  ? null
                  : () => _switch(choice),
            ),
        ],
      ),
    );
  }
}
