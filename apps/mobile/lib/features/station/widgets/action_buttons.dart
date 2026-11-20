import 'package:flutter/material.dart';

import '../../../app/theme/tokens.dart';

/// What a station button means, by colour (design-spec §1): green goes forward, red stops, amber
/// is the break, plain is anything else.
enum ActionKind { go, stop, rest, plain }

/// The one main action of a station screen (AS1): full width at the bottom, 64 dp, in thumb reach.
/// It never moves while a state is on screen. [busy] shows a spinner and the in-flight words; a
/// null [onPressed] fades it (only Save on What happened? is ever shown that way, spec §6.1).
class MainActionButton extends StatelessWidget {
  const MainActionButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.kind = ActionKind.go,
    this.busy = false,
    this.dimmed = false,
    this.semanticsLabel,
  });

  final String label;
  final IconData? icon;
  final VoidCallback? onPressed;
  final ActionKind kind;
  final bool busy;

  /// Shown faded though it can be pressed: Save before the form is ready (spec §6.1), whose press
  /// says what is missing.
  final bool dimmed;
  final String? semanticsLabel;

  @override
  Widget build(BuildContext context) {
    final s = context.stateTokens;
    final t = context.tokens;
    final (Color bg, Color fg) = switch (kind) {
      ActionKind.go => (s.go, s.onAction),
      ActionKind.stop => (s.stop, s.onAction),
      ActionKind.rest => (s.onBreak.band, s.onBreak.ink),
      ActionKind.plain => (t.bgTertiary, t.textPrimary),
    };
    final enabled = onPressed != null && !busy;
    final text = Theme.of(context).textTheme;
    return Semantics(
      button: true,
      enabled: enabled,
      label: semanticsLabel ?? label,
      excludeSemantics: true,
      onTap: enabled ? onPressed : null,
      child: Opacity(
        opacity: (onPressed == null && !busy) || dimmed ? 0.5 : 1,
        child: FilledButton(
          onPressed: enabled ? onPressed : null,
          style: FilledButton.styleFrom(
            minimumSize: const Size.fromHeight(64),
            backgroundColor: bg,
            foregroundColor: fg,
            disabledBackgroundColor: bg,
            disabledForegroundColor: fg,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Radii.lg)),
            textStyle: text.titleLarge,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (busy)
                SizedBox.square(dimension: 20, child: CircularProgressIndicator(strokeWidth: 2.5, color: fg))
              else if (icon != null)
                Icon(icon, size: 26, color: fg),
              if (busy || icon != null) const SizedBox(width: Space.sm),
              Flexible(
                child: Text(
                  label,
                  textAlign: TextAlign.center,
                  style: text.titleLarge!.copyWith(color: fg, fontSize: 20),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A secondary action beside or under the main one: outlined, 52 dp.
class SecondaryActionButton extends StatelessWidget {
  const SecondaryActionButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.busy = false,
    this.active = false,
    this.danger = false,
    this.toggled,
    this.semanticsLabel,
  });

  final String label;
  final IconData? icon;
  final VoidCallback? onPressed;
  final bool busy;

  /// Toggled on (Mute while muted): the amber of "needs attention".
  final bool active;
  final bool danger;

  /// A switch to a screen reader (Mute): on or off; null for a plain button.
  final bool? toggled;
  final String? semanticsLabel;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final s = context.stateTokens;
    final fg = danger ? s.problem.deep : (active ? s.onBreak.ink : t.textPrimary);
    final text = Theme.of(context).textTheme;
    final enabled = !busy && onPressed != null;
    return Semantics(
      button: true,
      enabled: enabled,
      toggled: toggled,
      label: semanticsLabel ?? label,
      excludeSemantics: true,
      onTap: enabled ? onPressed : null,
      child: OutlinedButton(
      onPressed: busy ? null : onPressed,
      style: OutlinedButton.styleFrom(
        minimumSize: const Size.fromHeight(52),
        backgroundColor: active ? s.onBreak.band : t.bgSecondary,
        foregroundColor: fg,
        side: BorderSide(color: active ? s.onBreak.band : (danger ? s.problem.deep.withValues(alpha: 0.5) : t.borderStrong), width: 1.5),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Radii.lg)),
        padding: const EdgeInsets.symmetric(horizontal: Space.md, vertical: Space.sm),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (busy)
            SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2, color: fg))
          else if (icon != null)
            Icon(icon, size: 22, color: fg),
          if (busy || icon != null) const SizedBox(width: Space.sm),
          Flexible(
            child: Text(label, textAlign: TextAlign.center, style: text.labelLarge!.copyWith(color: fg, fontSize: 16)),
          ),
        ],
      ),
      ),
    );
  }
}

/// A quiet text action under the main one ("Finish work for today").
class QuietActionButton extends StatelessWidget {
  const QuietActionButton({super.key, required this.label, required this.onPressed, this.icon, this.busy = false});

  final String label;
  final IconData? icon;
  final VoidCallback? onPressed;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return TextButton(
      onPressed: busy ? null : onPressed,
      style: TextButton.styleFrom(foregroundColor: t.textSecondary, minimumSize: const Size.fromHeight(48)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (busy)
            SizedBox.square(dimension: 16, child: CircularProgressIndicator(strokeWidth: 2, color: t.textSecondary))
          else if (icon != null)
            Icon(icon, size: 20),
          if (busy || icon != null) const SizedBox(width: Space.sm),
          Flexible(child: Text(label, textAlign: TextAlign.center)),
        ],
      ),
    );
  }
}
