import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/tokens.dart';
import '../../core/api/api_error.dart';
import '../../core/auth/app_gate.dart';
import '../../core/session/account_choice.dart';
import '../auth/auth_widgets.dart';
import 'account_switcher.dart';

/// Signed in with several accounts and no remembered one (or none at all):
/// the agent picks where to work. The choice is remembered on this device.
class AccountPickerScreen extends ConsumerStatefulWidget {
  const AccountPickerScreen({super.key});

  @override
  ConsumerState<AccountPickerScreen> createState() => _AccountPickerScreenState();
}

class _AccountPickerScreenState extends ConsumerState<AccountPickerScreen> {
  AccountChoice? _picking;
  bool _reloading = false;
  bool _signingOut = false;
  String? _error;

  AppGateNotifier get _gate => ref.read(appGateProvider.notifier);

  Future<void> _pick(AccountChoice choice) async {
    setState(() {
      _picking = choice;
      _error = null;
    });
    try {
      await _gate.selectAccount(choice);
    } finally {
      if (mounted) setState(() => _picking = null);
    }
  }

  Future<void> _reload() async {
    setState(() {
      _reloading = true;
      _error = null;
    });
    try {
      await _gate.reloadAccounts();
    } on ApiError catch (e) {
      _gate.reportError(e);
      if (mounted) setState(() => _error = e.userMessage);
    } finally {
      if (mounted) setState(() => _reloading = false);
    }
  }

  Future<void> _signOut() async {
    setState(() => _signingOut = true);
    try {
      await _gate.signOut();
    } finally {
      // Signed out, this screen is gone; a sign-out held for a call (or one
      // that failed) must not leave the button stuck on "Signing out…".
      if (mounted) setState(() => _signingOut = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final gate = ref.watch(appGateProvider);
    final choices = gate is GateNeedsAccount ? gate.choices : const <AccountChoice>[];
    final text = Theme.of(context).textTheme;
    final muted = text.bodyMedium!.copyWith(color: context.tokens.textSecondary);

    final signOut = TextButton(
      onPressed: _signingOut ? null : _signOut,
      child: Text(_signingOut ? 'Signing out…' : 'Sign out'),
    );

    if (choices.isEmpty) {
      return AuthLayout(
        title: 'No account to work in yet',
        children: [
          Text(
            'You’re signed in, but you haven’t been added to an account yet. Ask your supervisor to add you to one.',
            style: muted,
          ),
          const SizedBox(height: Space.xl),
          if (_error != null) ...[FormMessage(_error!), const SizedBox(height: Space.lg)],
          BusyButton(label: 'Try again', busyLabel: 'Checking…', busy: _reloading, onPressed: _reload),
          const SizedBox(height: Space.sm),
          signOut,
        ],
      );
    }

    return AuthLayout(
      title: 'Choose an account',
      subtitle: 'You work in more than one. Pick the one for this shift — you can switch later from Me.',
      children: [
        Card(
          clipBehavior: Clip.antiAlias,
          child: Column(
            children: [
              for (var i = 0; i < choices.length; i++) ...[
                if (i > 0) const Divider(),
                AccountTile(
                  choice: choices[i],
                  selected: false,
                  busy: _picking == choices[i],
                  onTap: _picking == null ? () => _pick(choices[i]) : null,
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: Space.lg),
        signOut,
      ],
    );
  }
}
