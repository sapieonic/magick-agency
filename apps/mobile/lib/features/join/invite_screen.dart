import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../app/routes.dart';
import '../../app/theme/tokens.dart';
import '../../core/auth/app_gate.dart';
import '../../core/station/station_signals.dart';
import '../../ui/primitives.dart';
import '../auth/auth_widgets.dart';
import 'invite_controller.dart';
import 'invite_copy.dart';

/// `/agency/join/:token` (mock 2): the emailed invitation, opened in the app
/// through App Links / Universal Links. Look it up, get a sign-in (Google or a
/// password at the invited address), claim it; the gate takes it from there.
class InviteScreen extends ConsumerWidget {
  const InviteScreen({super.key, required this.token});

  final String token;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = inviteControllerProvider(token);
    final state = ref.watch(provider);

    // The router leaves a ready gate, and one still choosing an account, on
    // this page (an invite link must open for someone signed in, and may add
    // the account they are about to pick), so the page moves on once its claim
    // is in: to the campaigns, or to the account picker when the new workspace
    // is one of several. Either can land second, so both are watched.
    void moveOnIfReady() {
      if (ref.read(provider).phase != InvitePhase.done) return;
      switch (ref.read(appGateProvider)) {
        case GateReady():
          context.go(Routes.home);
        case GateNeedsAccount():
          context.go(Routes.accounts);
        default:
          break;
      }
    }

    ref.listen<AppGate>(appGateProvider, (_, _) => moveOnIfReady());
    ref.listen<InvitePhase>(provider.select((s) => s.phase), (_, _) => moveOnIfReady());

    return switch (state.phase) {
      InvitePhase.loading => const _Loading(),
      InvitePhase.unavailable => _Unavailable(copy: unavailableCopy(state.status ?? InviteStatus.notFound)),
      InvitePhase.unreachable => _Unreachable(
          message: state.unreachableMessage ?? '',
          onRetry: ref.read(provider.notifier).load,
        ),
      InvitePhase.wrongApp => AuthLayout(
          title: wrongAppTitle,
          eyebrow: const StatusPill('Invitation', tone: Tone.accent),
          showLogo: false,
          children: [
            Text(wrongAppBody(roleLabel(state.invite!)), style: Theme.of(context).textTheme.bodyMedium),
            const SizedBox(height: Space.xl),
            const InviteExit(),
          ],
        ),
      InvitePhase.done => const _Loading(message: 'Signing you in…'),
      InvitePhase.pending => _InviteCard(token: token, state: state),
    };
  }
}

class _Loading extends StatelessWidget {
  const _Loading({this.message = 'Opening your invitation…'});
  final String message;

  @override
  Widget build(BuildContext context) => AuthLayout(
        title: 'Invitation',
        showLogo: false,
        children: [
          Semantics(
            liveRegion: true,
            child: Row(
              children: [
                const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2)),
                const SizedBox(width: Space.md),
                Expanded(child: Text(message, style: Theme.of(context).textTheme.bodyMedium)),
              ],
            ),
          ),
        ],
      );
}

class _Unavailable extends StatelessWidget {
  const _Unavailable({required this.copy});
  final UnavailableCopy copy;

  @override
  Widget build(BuildContext context) => AuthLayout(
        title: copy.title,
        eyebrow: const StatusPill('Invitation', tone: Tone.accent),
        showLogo: false,
        children: [
          Text(copy.body, style: Theme.of(context).textTheme.bodyMedium),
          const SizedBox(height: Space.xl),
          // Signing in is the remedy for some; every one of them needs a way out.
          InviteExit(primary: copy.offersSignIn),
        ],
      );
}

class _Unreachable extends StatelessWidget {
  const _Unreachable({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => AuthLayout(
        title: unreachableTitle,
        eyebrow: const StatusPill('Invitation', tone: Tone.accent),
        showLogo: false,
        children: [
          Text(unreachableBody, style: Theme.of(context).textTheme.bodyMedium),
          if (message.isNotEmpty) ...[const SizedBox(height: Space.lg), FormMessage(message, tone: Tone.warn)],
          const SizedBox(height: Space.xl),
          FilledButton(
            onPressed: onRetry,
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
            child: const Text('Try again'),
          ),
          const SizedBox(height: Space.sm),
          const InviteExit(),
        ],
      );
}

/// The way off the invite page (a deep link has no back, and iOS no back
/// button): to sign-in when nobody is signed in, else back into the app (the
/// gate takes it from there: the campaigns, the account picker, ...).
class InviteExit extends ConsumerWidget {
  const InviteExit({super.key, this.primary = false});

  /// A filled button when leaving is the page's main action.
  final bool primary;

  static const signInLabel = 'Go to sign in';
  static const backLabel = 'Back to the app';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final gate = ref.watch(appGateProvider);
    final signedOut = gate is GateSignedOut || gate is GateLoading;
    final label = signedOut ? signInLabel : backLabel;
    void leave() => context.go(signedOut ? Routes.signIn : Routes.home);
    const size = Size.fromHeight(52);
    return primary
        ? FilledButton(onPressed: leave, style: FilledButton.styleFrom(minimumSize: size), child: Text(label))
        : OutlinedButton(onPressed: leave, style: OutlinedButton.styleFrom(minimumSize: size), child: Text(label));
  }
}

class _InviteCard extends ConsumerWidget {
  const _InviteCard({required this.token, required this.state});

  final String token;
  final InviteState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final invite = state.invite!;
    final controller = ref.read(inviteControllerProvider(token).notifier);
    // The live station's campaign while on duty, else null.
    final onDuty = ref.watch(stationSignalsProvider.select((s) => s.onDuty ? s.campaignId : null));
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    final busy = state.busy != InviteBusy.none;
    final role = roleLabel(invite);

    return AuthLayout(
      title: 'You’ve been set up as ${withArticle(role)}',
      eyebrow: const StatusPill('Invitation', tone: Tone.accent),
      showLogo: false,
      children: [
        AppCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (invite.tenantName != null) _DetailRow(label: 'Workspace', value: invite.tenantName!),
              if (invite.inviterName != null) _DetailRow(label: 'Invited by', value: invite.inviterName!),
              _DetailRow(label: 'Expires', value: DateFormat('d MMM, HH:mm').format(invite.expiresAt.toLocal())),
              const SizedBox(height: Space.sm),
              Row(
                children: [
                  Icon(Icons.mail_outline, size: 16, color: t.textMuted),
                  const SizedBox(width: Space.sm),
                  Expanded(child: Text(invite.email, style: text.titleSmall)),
                ],
              ),
            ],
          ),
        ),
        const SizedBox(height: Space.xl),
        if (onDuty != null) ...[
          const FormMessage('You’re on duty. Leave the station before accepting an invitation.', tone: Tone.warn),
          const SizedBox(height: Space.md),
          FilledButton(
            onPressed: () => context.go(Routes.station(onDuty)),
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
            child: const Text('Back to your station'),
          ),
        ] else if (state.addressRequired)
          _AddressRequired(
            invitedAs: invite.email,
            signedInAs: state.addressRequiredSignedInAs,
            onRetry: controller.retryWithInvitedAddress,
          )
        else if (state.mismatch)
          _Mismatch(
            signedInAs: state.mismatchEmail ?? 'that Google account',
            invitedAs: invite.email,
            busy: state.busy,
            onConfirm: controller.confirmMismatch,
            onDecline: controller.declineMismatch,
          )
        else ...[
          BusyButton(
            label: 'Continue with Google',
            busyLabel: 'Waiting for Google…',
            busy: state.busy == InviteBusy.google,
            leading: const GoogleMark(),
            onPressed: busy ? null : controller.continueWithGoogle,
          ),
          const SizedBox(height: Space.md),
          if (state.showPassword) ...[
            const OrDivider(label: 'or with a password'),
            _PasswordForm(
              email: invite.email,
              existing: state.existingPassword,
              busy: state.busy == InviteBusy.create || state.busy == InviteBusy.signIn,
              enabled: !busy,
              onSubmit: controller.submitPassword,
            ),
          ] else
            OutlinedButton(
              onPressed: busy ? null : controller.revealPassword,
              style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(52)),
              child: const Text('Create a password'),
            ),
        ],
        if (state.error != null) ...[
          const SizedBox(height: Space.lg),
          FormMessage(state.error!),
          if (state.errorOffersSignIn)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(onPressed: busy ? null : () => context.go(Routes.signIn), child: const Text('Go to sign in')),
            ),
        ],
        const SizedBox(height: Space.xxl),
        const SectionLabel('What happens next'),
        const SizedBox(height: Space.sm),
        const _Step(n: 1, title: 'Set up how you sign in', desc: 'A Google account or a password — whichever you will still have in six months.'),
        const _Step(n: 2, title: 'Allow the microphone', desc: 'The app asks once, before your first shift, so customers can hear you.'),
        const _Step(
          n: 3,
          title: 'Your campaigns appear',
          desc: 'Your supervisor decides which lists you work; they show up here as they are assigned.',
        ),
        const SizedBox(height: Space.md),
        Wrap(
          alignment: WrapAlignment.center,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text('Already set up?', style: text.bodyMedium!.copyWith(color: t.textSecondary)),
            TextButton(onPressed: busy ? null : () => context.go(Routes.signIn), child: const Text('Sign in instead')),
          ],
        ),
      ],
    );
  }
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Space.xs),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 96, child: Text(label, style: text.bodySmall)),
          Expanded(child: Text(value, style: text.bodyMedium)),
        ],
      ),
    );
  }
}

class _Step extends StatelessWidget {
  const _Step({required this.n, required this.title, required this.desc});
  final int n;
  final String title;
  final String desc;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: Space.sm),
      child: MergeSemantics(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            CircleAvatar(
              radius: 12,
              backgroundColor: t.accentSubtle,
              child: Text('$n', style: text.labelMedium!.copyWith(color: t.accentHover)),
            ),
            const SizedBox(width: Space.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [Text(title, style: text.titleSmall), Text(desc, style: text.bodySmall)],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Mismatch extends StatelessWidget {
  const _Mismatch({
    required this.signedInAs,
    required this.invitedAs,
    required this.busy,
    required this.onConfirm,
    required this.onDecline,
  });

  final String signedInAs;
  final String invitedAs;
  final InviteBusy busy;
  final VoidCallback onConfirm;
  final VoidCallback onDecline;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    const strong = TextStyle(fontWeight: FontWeight.w600);
    return AppCard(
      borderColor: context.tokens.warning,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(header: true, liveRegion: true, child: Text('That is a different address', style: text.titleMedium)),
          const SizedBox(height: Space.sm),
          Text.rich(
            TextSpan(children: [
              const TextSpan(text: 'You signed in as '),
              TextSpan(text: signedInAs, style: strong),
              const TextSpan(text: '. This invitation was sent to '),
              TextSpan(text: invitedAs, style: strong),
              const TextSpan(text: '.'),
            ]),
            style: text.bodyMedium,
          ),
          const SizedBox(height: Space.sm),
          Text(
            'You can use this Google account anyway — it will become how you sign in, and the invitation will still be '
            'claimed. Only do it if the account is yours.',
            style: text.bodyMedium,
          ),
          const SizedBox(height: Space.lg),
          BusyButton(
            label: 'Use this account',
            busyLabel: 'Linking…',
            busy: busy == InviteBusy.confirm,
            onPressed: busy == InviteBusy.none ? onConfirm : null,
          ),
          const SizedBox(height: Space.sm),
          BusyButton(
            label: 'Use a different account',
            busyLabel: 'Signing out…',
            busy: busy == InviteBusy.decline,
            outlined: true,
            onPressed: busy == InviteBusy.none ? onDecline : null,
          ),
        ],
      ),
    );
  }
}

class _AddressRequired extends StatelessWidget {
  const _AddressRequired({required this.invitedAs, required this.signedInAs, required this.onRetry});

  final String invitedAs;
  final String? signedInAs;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    const strong = TextStyle(fontWeight: FontWeight.w600);
    return AppCard(
      borderColor: context.tokens.warning,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Semantics(
            header: true,
            liveRegion: true,
            child: Text('Use the address this invitation was sent to', style: text.titleMedium),
          ),
          const SizedBox(height: Space.sm),
          Text.rich(
            TextSpan(children: [
              const TextSpan(text: 'This invitation must be accepted with '),
              TextSpan(text: invitedAs, style: strong),
              const TextSpan(text: '.'),
              if (signedInAs != null) ...[
                const TextSpan(text: ' You signed in as '),
                TextSpan(text: signedInAs, style: strong),
                const TextSpan(text: ', so we have signed you out of it.'),
              ] else
                const TextSpan(text: ' We have signed you out of the account you used.'),
            ]),
            style: text.bodyMedium,
          ),
          const SizedBox(height: Space.sm),
          Text(
            'Continue with Google using that address, or create a password — the password form is already set to it.',
            style: text.bodyMedium,
          ),
          const SizedBox(height: Space.lg),
          FilledButton(
            onPressed: onRetry,
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
            child: const Text('Try again with that address'),
          ),
        ],
      ),
    );
  }
}

/// The password half. The address is the invited one and read-only: it is
/// the value that must not drift.
class _PasswordForm extends StatefulWidget {
  const _PasswordForm({
    required this.email,
    required this.existing,
    required this.busy,
    required this.enabled,
    required this.onSubmit,
  });

  final String email;
  final bool existing;
  final bool busy;
  final bool enabled;
  final Future<void> Function(String password) onSubmit;

  @override
  State<_PasswordForm> createState() => _PasswordFormState();
}

class _PasswordFormState extends State<_PasswordForm> {
  final _password = TextEditingController();
  final _focus = FocusNode();
  bool _obscure = true;

  @override
  void initState() {
    super.initState();
    _password.addListener(_onChanged);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focus.requestFocus();
    });
  }

  @override
  void didUpdateWidget(covariant _PasswordForm old) {
    super.didUpdateWidget(old);
    // Flipped to "you already have a password": start that field afresh.
    if (widget.existing && !old.existing) {
      _password.clear();
      _focus.requestFocus();
    }
  }

  void _onChanged() {
    if (!widget.existing) setState(() {});
  }

  @override
  void dispose() {
    _password.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _submit() => widget.onSubmit(_password.text);

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    final assessment = assessPassword(_password.text, widget.email);
    final typed = _password.text.isNotEmpty;
    return AutofillGroup(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextFormField(
            key: const Key('invite-email'),
            initialValue: widget.email,
            readOnly: true,
            autofillHints: const [AutofillHints.username],
            decoration: const InputDecoration(
              labelText: 'Your address',
              helperText: 'This is the address the invitation was sent to, so it cannot be changed here.',
              helperMaxLines: 3,
            ),
          ),
          const SizedBox(height: Space.md),
          TextField(
            key: const Key('invite-password'),
            controller: _password,
            focusNode: _focus,
            enabled: widget.enabled,
            obscureText: _obscure,
            autocorrect: false,
            enableSuggestions: false,
            autofillHints: [widget.existing ? AutofillHints.password : AutofillHints.newPassword],
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _submit(),
            decoration: InputDecoration(
              labelText: widget.existing ? 'Your password' : 'Choose a password',
              suffixIcon: IconButton(
                tooltip: _obscure ? 'Show password' : 'Hide password',
                icon: Icon(_obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                onPressed: () => setState(() => _obscure = !_obscure),
              ),
            ),
          ),
          const SizedBox(height: Space.sm),
          if (widget.existing)
            Text(
              'This address already has a password on Magick Agency. Enter it and we will add this workspace to it.',
              style: text.bodySmall,
            )
          else ...[
            ExcludeSemantics(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(Radii.pill),
                child: LinearProgressIndicator(
                  value: assessment.score / 4,
                  minHeight: 4,
                  backgroundColor: t.bgTertiary,
                  color: switch (assessment.score) { 0 || 1 => t.danger, 2 => t.warning, _ => t.success },
                ),
              ),
            ),
            const SizedBox(height: Space.xs),
            Semantics(
              liveRegion: true,
              child: Text(
                [
                  if (typed) strengthLabels[assessment.score],
                  if (assessment.blocker != null && typed) assessment.blocker! else assessment.hint,
                ].join(' · '),
                style: text.bodySmall,
              ),
            ),
          ],
          const SizedBox(height: Space.lg),
          BusyButton(
            label: widget.existing ? 'Sign in and join' : 'Create my sign-in',
            busyLabel: 'Joining…',
            busy: widget.busy,
            onPressed: widget.enabled ? _submit : null,
          ),
        ],
      ),
    );
  }
}
