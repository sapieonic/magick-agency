import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/app_theme.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/softphone/softphone_view.dart';
import '../softphone_copy.dart';

/// The keys in a phone's order, and the letters a handset prints under them.
/// `0` carries the `+` (long-press, as on a handset).
const dialKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
const dialKeyLetters = {
  '1': '',
  '2': 'ABC',
  '3': 'DEF',
  '4': 'GHI',
  '5': 'JKL',
  '6': 'MNO',
  '7': 'PQRS',
  '8': 'TUV',
  '9': 'WXYZ',
  '*': '',
  '0': '+',
  '#': '',
};

/// The keypad: twelve keys, each at least 56 dp tall (above the 48 dp target),
/// writing into the same number as the field. Long-press `0` for `+`.
///
/// Its text scales up to 150%: the digits are already large, and at 200% on a
/// small phone the letters would push the pad off the screen. The keys' labels
/// for a screen reader ("2 ABC") do not depend on it.
class DialPad extends ConsumerWidget {
  const DialPad({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final enabled = ref.watch(softphoneViewProvider.select((v) => v.dialPadEnabled));
    final actions = ref.read(softphoneActionsProvider);
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: 1.5,
      child: Semantics(
        key: const Key('dial-pad'),
        container: true,
        label: SoftphoneCopy.keypad,
        child: Column(
          children: [
            for (var row = 0; row < 4; row++) ...[
              if (row > 0) const SizedBox(height: Space.sm),
              Row(
                children: [
                  for (var col = 0; col < 3; col++) ...[
                    if (col > 0) const SizedBox(width: Space.sm),
                    Expanded(
                      child: _DialKey(digit: dialKeys[row * 3 + col], onPressed: enabled ? actions.pressKey : null),
                    ),
                  ],
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _DialKey extends StatelessWidget {
  const _DialKey({required this.digit, required this.onPressed});

  final String digit;
  final ValueChanged<String>? onPressed;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final letters = dialKeyLetters[digit] ?? '';
    final enabled = onPressed != null;
    final fg = enabled ? t.textPrimary : t.textMuted;
    final zero = digit == '0';

    void press(String key) {
      unawaited(HapticFeedback.selectionClick());
      onPressed?.call(key);
    }

    return Semantics(
      button: true,
      enabled: enabled,
      label: letters.isEmpty || zero ? digit : '$digit $letters',
      hint: zero ? SoftphoneCopy.zeroHint : null,
      excludeSemantics: true,
      onTap: enabled ? () => press(digit) : null,
      onLongPress: enabled && zero ? () => press('+') : null,
      child: Material(
        color: t.bgTertiary,
        borderRadius: BorderRadius.circular(Radii.md),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: Key('dial-key-$digit'),
          onTap: enabled ? () => press(digit) : null,
          onLongPress: enabled && zero ? () => press('+') : null,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 56),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: Space.xs),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    digit,
                    style: monoStyle(context, size: 22, weight: FontWeight.w600, color: fg),
                  ),
                  if (letters.isNotEmpty) Text(letters, style: text.labelSmall!.copyWith(color: t.textMuted, letterSpacing: 1.2)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
