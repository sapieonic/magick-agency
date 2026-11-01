import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/tokens.dart';
import '../../core/api/api_error.dart';
import '../../core/auth/app_gate.dart';
import '../../core/auth/auth_copy.dart';
import '../../core/auth/auth_service.dart';
import '../../ui/primitives.dart';
import 'auth_widgets.dart';

/// `email_unverified`: a password account whose address is not proven yet.
/// The console's wording. Coming back to the app (from the mail app, after
/// clicking the link) checks again on its own.
class VerifyEmailScreen extends ConsumerStatefulWidget {
  const VerifyEmailScreen({super.key});

  @override
  ConsumerState<VerifyEmailScreen> createState() => _VerifyEmailScreenState();
}

class _VerifyEmailScreenState extends ConsumerState<VerifyEmailScreen> {
  late final AppLifecycleListener _lifecycle;

  bool _checking = false;
  bool _resending = false;
  bool _resent = false;
  bool _signingOut = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(onResume: () => unawaited(_check(silent: true)));
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  AppGateNotifier get _gate => ref.read(appGateProvider.notifier);

  String _message(Object e) => switch (e) {
        AuthFailure() => authErrorMessage(e),
        ApiError() => e.userMessage,
        _ => 'Verification check failed',
      };

  Future<void> _check({bool silent = false}) async {
    if (_checking || _signingOut) return;
    setState(() {
      _checking = true;
      if (!silent) _error = null;
    });
    try {
      final ok = await _gate.checkEmailVerified();
      if (!ok && !silent && mounted) {
        setState(() => _error = 'Email not verified yet. Please check your inbox and click the verification link.');
      }
    } catch (e) {
      if (!silent && mounted) setState(() => _error = _message(e));
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  Future<void> _resend() async {
    setState(() {
      _resending = true;
      _error = null;
    });
    try {
      await _gate.resendVerification();
      if (mounted) setState(() => _resent = true);
    } catch (e) {
      if (mounted) setState(() => _error = e is AuthFailure ? authErrorMessage(e) : 'Failed to resend verification email');
    } finally {
      if (mounted) setState(() => _resending = false);
    }
  }

  Future<void> _signOut() async {
    setState(() => _signingOut = true);
    await _gate.signOut();
  }

  @override
  Widget build(BuildContext context) {
    final gate = ref.watch(appGateProvider);
    final email = gate is GateEmailUnverified ? gate.email : '';
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    return AuthLayout(
      title: 'Verify your email',
      children: [
        Text.rich(
          TextSpan(children: [
            const TextSpan(text: 'We sent a verification link to '),
            TextSpan(text: email.isEmpty ? 'your address' : email, style: const TextStyle(fontWeight: FontWeight.w600)),
            const TextSpan(text: '. Click the link in the email, then come back here.'),
          ]),
          style: text.bodyMedium!.copyWith(color: t.textSecondary),
        ),
        const SizedBox(height: Space.xl),
        if (_error != null) ...[FormMessage(_error!, tone: Tone.warn), const SizedBox(height: Space.lg)],
        BusyButton(
          label: 'I’ve verified my email',
          busyLabel: 'Checking…',
          busy: _checking,
          onPressed: _signingOut ? null : _check,
        ),
        const SizedBox(height: Space.md),
        BusyButton(
          label: _resent ? 'Verification email sent!' : 'Resend verification email',
          busyLabel: 'Sending…',
          busy: _resending,
          outlined: true,
          onPressed: _resent || _signingOut ? null : _resend,
        ),
        const SizedBox(height: Space.sm),
        TextButton(
          onPressed: _signingOut ? null : _signOut,
          child: Text(_signingOut ? 'Signing out…' : 'Use a different account'),
        ),
      ],
    );
  }
}
