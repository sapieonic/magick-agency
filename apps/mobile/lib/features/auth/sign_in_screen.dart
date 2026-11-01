import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme/tokens.dart';
import '../../core/api/api_error.dart';
import '../../core/auth/app_gate.dart';
import '../../core/auth/auth_copy.dart';
import '../../core/auth/auth_service.dart';
import '../../ui/primitives.dart';
import 'auth_widgets.dart';

/// The agent's front door (mock 1): email + password, or Google. There is no
/// sign-up: an agent gets in through their supervisor's invitation. A
/// refused session (`no_membership`, `email_unverified`) moves the gate, and
/// the router shows that screen.
class SignInScreen extends ConsumerStatefulWidget {
  const SignInScreen({super.key});

  @override
  ConsumerState<SignInScreen> createState() => _SignInScreenState();
}

enum _Busy { none, email, google, reset }

class _SignInScreenState extends ConsumerState<SignInScreen> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _resetEmail = TextEditingController();
  final _passwordFocus = FocusNode();

  _Busy _busy = _Busy.none;
  String? _error;
  bool _obscure = true;
  bool _resetting = false;
  bool _resetSent = false;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _resetEmail.dispose();
    _passwordFocus.dispose();
    super.dispose();
  }

  AppGateNotifier get _gate => ref.read(appGateProvider.notifier);

  String _messageFor(Object e, AuthAction action) => switch (e) {
        AuthFailure() => authErrorMessage(e, action: action),
        ApiError() => e.userMessage,
        _ => 'That did not work. Try again.',
      };

  Future<void> _run(_Busy which, Future<void> Function() body, {AuthAction action = AuthAction.signIn}) async {
    if (_busy != _Busy.none) return;
    setState(() {
      _busy = which;
      _error = null;
    });
    try {
      await body();
    } on AuthFailure catch (e) {
      // Closing the Google sheet is a choice, not a failure.
      if (mounted && e.code != AuthFailure.cancelled) setState(() => _error = _messageFor(e, action));
    } catch (e) {
      if (mounted) setState(() => _error = _messageFor(e, action));
    } finally {
      if (mounted) setState(() => _busy = _Busy.none);
    }
  }

  Future<void> _signIn() async {
    final email = _email.text.trim();
    final password = _password.text;
    if (email.isEmpty || password.isEmpty) {
      setState(() => _error = 'Enter your email and password.');
      return;
    }
    TextInput.finishAutofillContext();
    await _run(_Busy.email, () => _gate.signInWithEmail(email, password));
  }

  Future<void> _google() => _run(_Busy.google, _gate.signInWithGoogle);

  Future<void> _sendReset() async {
    final email = _resetEmail.text.trim();
    if (email.isEmpty) {
      setState(() => _error = 'Please enter your email address');
      return;
    }
    await _run(_Busy.reset, () async {
      await _gate.sendPasswordReset(email);
      if (mounted) setState(() => _resetSent = true);
    }, action: AuthAction.passwordReset);
  }

  void _openReset() => setState(() {
        _resetting = true;
        _resetSent = false;
        _error = null;
        _resetEmail.text = _email.text.trim();
      });

  void _closeReset() => setState(() {
        _resetting = false;
        _resetSent = false;
        _error = null;
      });

  @override
  Widget build(BuildContext context) {
    final gate = ref.watch(appGateProvider);
    final notice = gate is GateSignedOut ? gate.notice : null;
    return _resetting ? _buildReset(context) : _buildSignIn(context, notice);
  }

  Widget _buildSignIn(BuildContext context, String? notice) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final busy = _busy != _Busy.none;
    return AuthLayout(
      title: 'Sign in',
      subtitle: 'Magick Agency · for agents',
      children: [
        if (notice != null && _error == null) ...[FormMessage(notice, tone: Tone.warn), const SizedBox(height: Space.lg)],
        AutofillGroup(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                key: const Key('sign-in-email'),
                controller: _email,
                enabled: !busy,
                keyboardType: TextInputType.emailAddress,
                autocorrect: false,
                textInputAction: TextInputAction.next,
                autofillHints: const [AutofillHints.email, AutofillHints.username],
                decoration: const InputDecoration(labelText: 'Email', hintText: 'you@agency.com'),
                onSubmitted: (_) => _passwordFocus.requestFocus(),
              ),
              const SizedBox(height: Space.md),
              TextField(
                key: const Key('sign-in-password'),
                controller: _password,
                focusNode: _passwordFocus,
                enabled: !busy,
                obscureText: _obscure,
                autocorrect: false,
                enableSuggestions: false,
                textInputAction: TextInputAction.done,
                autofillHints: const [AutofillHints.password],
                decoration: InputDecoration(
                  labelText: 'Password',
                  suffixIcon: IconButton(
                    tooltip: _obscure ? 'Show password' : 'Hide password',
                    icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                    onPressed: () => setState(() => _obscure = !_obscure),
                  ),
                ),
                onSubmitted: (_) => _signIn(),
              ),
            ],
          ),
        ),
        const SizedBox(height: Space.lg),
        if (_error != null) ...[FormMessage(_error!), const SizedBox(height: Space.lg)],
        BusyButton(
          label: 'Sign in',
          busyLabel: 'Please wait…',
          busy: _busy == _Busy.email,
          onPressed: busy ? null : _signIn,
        ),
        const OrDivider(),
        BusyButton(
          label: 'Continue with Google',
          busyLabel: 'Waiting for Google…',
          busy: _busy == _Busy.google,
          outlined: true,
          leading: const GoogleMark(),
          onPressed: busy ? null : _google,
        ),
        const SizedBox(height: Space.xl),
        Wrap(
          alignment: WrapAlignment.center,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text('Forgot your password?', style: text.bodyMedium!.copyWith(color: t.textSecondary)),
            TextButton(onPressed: busy ? null : _openReset, child: const Text('Reset it')),
          ],
        ),
        Text(
          'No account? Ask your supervisor for an invite.',
          textAlign: TextAlign.center,
          style: text.bodySmall,
        ),
      ],
    );
  }

  Widget _buildReset(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final busy = _busy != _Busy.none;
    if (_resetSent) {
      return AuthLayout(
        title: 'Check your inbox',
        children: [
          Semantics(
            liveRegion: true,
            child: Text(
              'We sent a password reset link to ${_resetEmail.text.trim()}. Check your inbox and follow the link to reset it.',
              style: text.bodyMedium,
            ),
          ),
          const SizedBox(height: Space.xl),
          FilledButton(onPressed: _closeReset, child: const Text('Back to sign in')),
        ],
      );
    }
    return AuthLayout(
      title: 'Reset your password',
      children: [
        Text(
          'Enter the email address your supervisor invited and we’ll send you a link to reset your password.',
          style: text.bodyMedium,
        ),
        const SizedBox(height: Space.lg),
        TextField(
          key: const Key('reset-email'),
          controller: _resetEmail,
          enabled: !busy,
          autofocus: true,
          keyboardType: TextInputType.emailAddress,
          autocorrect: false,
          autofillHints: const [AutofillHints.email],
          textInputAction: TextInputAction.send,
          decoration: const InputDecoration(labelText: 'Email', hintText: 'you@agency.com'),
          onSubmitted: (_) => _sendReset(),
        ),
        const SizedBox(height: Space.lg),
        if (_error != null) ...[FormMessage(_error!), const SizedBox(height: Space.lg)],
        BusyButton(label: 'Send reset link', busyLabel: 'Sending…', busy: _busy == _Busy.reset, onPressed: _sendReset),
        const SizedBox(height: Space.sm),
        TextButton(onPressed: busy ? null : _closeReset, child: const Text('Back to sign in')),
      ],
    );
  }
}
