import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/app_theme.dart';
import '../../../app/theme/tokens.dart';
import '../../../core/softphone/softphone_view.dart';
import '../softphone_copy.dart';

/// Treats an edit that inserts two or more characters at once as a paste.
///
/// A keyboard types one character per edit; a paste, an autofill or an IME
/// committing a copied number lands several at once. Those are handed to
/// [onPaste] whole (the core cleans `tel:` links, `+91`, `00`, a trunk `0`,
/// `(0)`, spaces and dashes the way a pasted number means them) and the edit
/// itself is refused: the field then shows what the core made of it. A
/// one-character edit, and every deletion, passes through as typing.
class PasteAsNumberFormatter extends TextInputFormatter {
  PasteAsNumberFormatter(this.onPaste);

  final ValueChanged<String> onPaste;

  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) {
    final inserted = insertedText(oldValue, newValue);
    if (inserted.length < 2) return newValue;
    onPaste(inserted);
    return oldValue;
  }

  /// What an edit added. Read from the selection when the edit is an insert
  /// over it (a paste replaces the selection and leaves the caret after what
  /// it put in), else the new text between the unchanged head and tail.
  static String insertedText(TextEditingValue oldValue, TextEditingValue newValue) {
    final a = oldValue.text;
    final b = newValue.text;
    final sel = oldValue.selection;
    if (sel.isValid && newValue.selection.isValid && newValue.selection.isCollapsed) {
      final start = sel.start;
      final end = sel.end;
      final caret = newValue.selection.end;
      if (start <= end &&
          end <= a.length &&
          caret >= start &&
          caret <= b.length &&
          b.length - (caret - start) == a.length - (end - start) &&
          b.startsWith(a.substring(0, start)) &&
          b.endsWith(a.substring(end))) {
        return b.substring(start, caret);
      }
    }
    var head = 0;
    while (head < a.length && head < b.length && a.codeUnitAt(head) == b.codeUnitAt(head)) {
      head++;
    }
    var tail = 0;
    while (tail < a.length - head && tail < b.length - head && a.codeUnitAt(a.length - 1 - tail) == b.codeUnitAt(b.length - 1 - tail)) {
      tail++;
    }
    return b.substring(head, b.length - tail);
  }
}

/// The number to call: a real text field (typing, selecting and the phone's
/// own paste all work) whose value is the core's, with the country-code chip
/// in front of a number typed without one, and Delete beside it (hold to
/// clear).
///
/// The keyboard's action key calls. A paste, from the keyboard's clipboard
/// strip or the field's own menu, goes to [SoftphoneActions.pasteNumber] whole.
class NumberField extends ConsumerStatefulWidget {
  const NumberField({super.key, required this.onSubmit});

  /// The keyboard's Go: the panel's guarded dial.
  final VoidCallback onSubmit;

  @override
  ConsumerState<NumberField> createState() => _NumberFieldState();
}

class _NumberFieldState extends ConsumerState<NumberField> {
  late final TextEditingController _controller = TextEditingController(text: ref.read(softphoneViewProvider).number);
  late final _formatter = PasteAsNumberFormatter((raw) => ref.read(softphoneActionsProvider).pasteNumber(raw));

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _sync(String number) {
    if (number == _controller.text) return;
    // The core's value wins (a key, a paste, a redial): the caret goes to the end,
    // where the next digit belongs.
    _controller.value = TextEditingValue(
      text: number,
      selection: TextSelection.collapsed(offset: number.length),
    );
  }

  /// Typing: the core keeps only what can be dialled. A character it drops (a
  /// dash, a space, a second `+`, a digit past the limit) leaves the number as
  /// it was, so the view does not change and [_sync] never runs: put the
  /// core's number back here, or the field would show a character that is
  /// not dialled. The caret stays where the agent was typing.
  void _typed(String value) {
    ref.read(softphoneActionsProvider).setNumber(value);
    final number = ref.read(softphoneViewProvider).number;
    if (number == _controller.text) return;
    final dropped = value.length - number.length;
    final caret = (_controller.selection.isValid ? _controller.selection.extentOffset : value.length) - dropped;
    _controller.value = TextEditingValue(
      text: number,
      selection: TextSelection.collapsed(offset: caret.clamp(0, number.length)),
    );
  }

  Future<void> _pasteFromClipboard() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final raw = data?.text;
    if (raw == null || raw.isEmpty || !mounted) return;
    ref.read(softphoneActionsProvider).pasteNumber(raw);
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(softphoneViewProvider.select((v) => (number: v.number, country: v.countryCode, enabled: v.dialPadEnabled)));
    ref.listen(softphoneViewProvider.select((v) => v.number), (_, next) => _sync(next));
    final t = context.tokens;
    final actions = ref.read(softphoneActionsProvider);
    final showCountry = !s.number.startsWith('+');

    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Expanded(
          child: TextField(
            key: const Key('dial-number'),
            controller: _controller,
            enabled: s.enabled,
            keyboardType: TextInputType.phone,
            textInputAction: TextInputAction.go,
            autocorrect: false,
            enableSuggestions: false,
            inputFormatters: [_formatter],
            style: monoStyle(context, size: 22, color: t.textPrimary),
            onChanged: _typed,
            onSubmitted: (_) => widget.onSubmit(),
            contextMenuBuilder: (context, editable) {
              // The menu's Paste goes through the same cleaning as any paste,
              // even when the clipboard holds a single character.
              final items = [
                for (final item in editable.contextMenuButtonItems)
                  if (item.type == ContextMenuButtonType.paste)
                    item.copyWith(
                      onPressed: () {
                        ContextMenuController.removeAny();
                        unawaited(_pasteFromClipboard());
                      },
                    )
                  else
                    item,
              ];
              return AdaptiveTextSelectionToolbar.buttonItems(anchors: editable.contextMenuAnchors, buttonItems: items);
            },
            decoration: InputDecoration(
              labelText: SoftphoneCopy.numberLabel,
              hintText: SoftphoneCopy.numberHint,
              prefixIcon: showCountry
                  ? Tooltip(
                      message: SoftphoneCopy.countryCodeHint,
                      child: Padding(
                        padding: const EdgeInsetsDirectional.only(start: Space.md, end: Space.sm),
                        child: Text(s.country, key: const Key('country-code'), style: monoStyle(context, size: 18)),
                      ),
                    )
                  : null,
              prefixIconConstraints: const BoxConstraints(minWidth: 0, minHeight: 0),
            ),
          ),
        ),
        const SizedBox(width: Space.xs),
        _DeleteKey(enabled: s.enabled && s.number.isNotEmpty, onDelete: actions.backspace, onClear: actions.clearNumber),
      ],
    );
  }
}

/// Delete: a tap removes the last character, a hold clears the number. Not an
/// [IconButton]: its tooltip takes the long press for itself.
class _DeleteKey extends StatelessWidget {
  const _DeleteKey({required this.enabled, required this.onDelete, required this.onClear});

  final bool enabled;
  final VoidCallback onDelete;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Semantics(
      button: true,
      enabled: enabled,
      label: SoftphoneCopy.deleteDigit,
      hint: SoftphoneCopy.deleteDigitHint,
      excludeSemantics: true,
      onTap: enabled ? onDelete : null,
      onLongPress: enabled ? onClear : null,
      child: Material(
        type: MaterialType.transparency,
        shape: const CircleBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: const Key('dial-backspace'),
          onTap: enabled ? onDelete : null,
          onLongPress: enabled ? onClear : null,
          child: SizedBox.square(
            dimension: Space.touch,
            child: Icon(Icons.backspace_outlined, color: enabled ? t.textSecondary : t.textMuted),
          ),
        ),
      ),
    );
  }
}
