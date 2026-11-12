import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/tokens.dart';
import '../../core/auth/app_gate.dart';
import 'auth_widgets.dart';

/// `403 no_membership`: Firebase signed the person in, the agency has no
/// user, stub or invite for that identity. Almost always the wrong address
/// (personal instead of work, or the other way round), so the copy is about
/// the address and the one action signs out to try another (console:
/// `AgencyLoginPage`'s `UnrecognisedAccount`).
class NoMembershipScreen extends ConsumerStatefulWidget {
  const NoMembershipScreen({super.key});

  @override
  ConsumerState<NoMembershipScreen> createState() => _NoMembershipScreenState();
}

class _NoMembershipScreenState extends ConsumerState<NoMembershipScreen> {
  bool _signingOut = false;

  Future<void> _signOut() async {
    setState(() => _signingOut = true);
    await ref.read(appGateProvider.notifier).signOut();
  }

  @override
  Widget build(BuildContext context) {
    final gate = ref.watch(appGateProvider);
    final email = gate is GateNoMembership ? gate.email : null;
    final body = Theme.of(context).textTheme.bodyMedium!.copyWith(color: context.tokens.textSecondary);
    return AuthLayout(
      title: 'We don’t recognise that account',
      children: [
        Text.rich(
          TextSpan(children: [
            if (email != null) ...[
              TextSpan(text: email, style: const TextStyle(fontWeight: FontWeight.w600)),
              const TextSpan(text: ' isn’t'),
            ] else
              const TextSpan(text: 'That address isn’t'),
            const TextSpan(
              text: ' in an organisation on the Agency Dialer yet. Sign-in is matched on the exact address your supervisor invited, '
                  'so this usually means the invite went somewhere else — a work address rather than a personal one, '
                  'or the other way round.',
            ),
          ]),
          style: body,
        ),
        const SizedBox(height: Space.md),
        Text(
          'Check the invite you were sent and try that address. If you can’t find it, ask your supervisor to '
          're-send it and to confirm which address they used.',
          style: body,
        ),
        const SizedBox(height: Space.xl),
        BusyButton(
          label: 'Try a different account',
          busyLabel: 'Signing out…',
          busy: _signingOut,
          onPressed: _signOut,
        ),
      ],
    );
  }
}
