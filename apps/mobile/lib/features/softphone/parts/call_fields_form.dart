import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/softphone/softphone_view.dart';
import '../../../ui/primitives.dart';
import '../softphone_copy.dart';

/// The account's call details, drawn from their declared types: text, number,
/// choice, yes/no and date. A type this build does not know is shown read-only,
/// never dropped.
///
/// A required field carries a visible `*` and says "required" to a screen
/// reader; its error sits under it, read with the field. Required fields may be
/// empty while the call is live: the rule bites at Save. Every change goes to
/// [SoftphoneActions.setFieldValue] (the core debounces the save); the values
/// shown are the view's, except in a text box the agent is typing in.
///
/// The panel keys this on the call, so a new call starts with fresh boxes.
class CallFieldsForm extends ConsumerWidget {
  const CallFieldsForm({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(softphoneViewProvider.select((v) => (fields: v.fields, editable: v.fieldsEditable)));
    // No fields is said nowhere: the set may still be loading, and "none" would be untrue.
    if (s.fields.isEmpty) return const SizedBox.shrink();
    final text = Theme.of(context).textTheme;
    return Column(
      key: const Key('call-fields'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SectionLabel(SoftphoneCopy.callDetails),
        Text(SoftphoneCopy.callDetailsHint, style: text.labelSmall),
        for (final f in s.fields) ...[
          const SizedBox(height: Space.md),
          _FieldInput(key: ValueKey('field-${f.key}'), field: f, enabled: s.editable),
        ],
      ],
    );
  }
}

/// The field's label with its required marker: `*` to the eye, "required" to
/// the ear.
Widget _label(BuildContext context, SoftphoneFieldView f) {
  if (!f.required) return Text(f.label);
  return Semantics(
    label: '${f.label}, ${SoftphoneCopy.required}',
    excludeSemantics: true,
    child: Text.rich(
      TextSpan(
        children: [
          TextSpan(text: f.label),
          TextSpan(
            text: ' *',
            style: TextStyle(color: context.tokens.danger),
          ),
        ],
      ),
    ),
  );
}

/// What a yes/no detail nobody has answered says, in the console's words.
const _notAnswered = 'Not answered';

class _FieldInput extends ConsumerStatefulWidget {
  const _FieldInput({super.key, required this.field, required this.enabled});

  final SoftphoneFieldView field;
  final bool enabled;

  @override
  ConsumerState<_FieldInput> createState() => _FieldInputState();
}

class _FieldInputState extends ConsumerState<_FieldInput> {
  late final TextEditingController _text = TextEditingController(text: _shown(widget.field.value));
  final _focus = FocusNode();

  static String _shown(Object? value) => value == null ? '' : '$value';

  @override
  void didUpdateWidget(_FieldInput old) {
    super.didUpdateWidget(old);
    // The server's value (a hydrate, a reload) reaches the box only while the
    // agent is not typing in it: mid-word it would move their cursor.
    final shown = _shown(widget.field.value);
    if (!_focus.hasFocus && shown != _text.text && _parse(_text.text) != widget.field.value) {
      _text.value = TextEditingValue(
        text: shown,
        selection: TextSelection.collapsed(offset: shown.length),
      );
    }
  }

  @override
  void dispose() {
    _text.dispose();
    _focus.dispose();
    super.dispose();
  }

  /// What a text box's content means for this field: empty is null; a number
  /// that does not parse stays as typed, so the field can say what is wrong
  /// with it rather than go blank under the agent's cursor.
  Object? _parse(String raw) {
    if (raw.trim().isEmpty) return null;
    if (widget.field.type == SoftphoneFieldType.number) return num.tryParse(raw.trim()) ?? raw;
    return raw;
  }

  void _set(Object? value) => ref.read(softphoneActionsProvider).setFieldValue(widget.field.key, value);

  @override
  Widget build(BuildContext context) {
    final f = widget.field;
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final enabled = widget.enabled;

    switch (f.type) {
      case SoftphoneFieldType.text:
      case SoftphoneFieldType.number:
        return TextField(
          key: Key('call-field-${f.key}'),
          controller: _text,
          focusNode: _focus,
          enabled: enabled,
          keyboardType: f.type == SoftphoneFieldType.number
              ? const TextInputType.numberWithOptions(decimal: true, signed: true)
              : TextInputType.text,
          textCapitalization: f.type == SoftphoneFieldType.text ? TextCapitalization.sentences : TextCapitalization.none,
          inputFormatters: f.type == SoftphoneFieldType.number ? [FilteringTextInputFormatter.allow(RegExp(r'[0-9.\-]'))] : null,
          onChanged: (raw) => _set(_parse(raw)),
          decoration: InputDecoration(label: _label(context, f), errorText: f.error, errorMaxLines: 4),
        );
      case SoftphoneFieldType.choice:
        final value = f.value is String && f.options.contains(f.value) ? f.value! as String : null;
        return InputDecorator(
          decoration: InputDecoration(
            label: _label(context, f),
            errorText: f.error,
            errorMaxLines: 4,
            enabled: enabled,
            contentPadding: const EdgeInsets.symmetric(horizontal: Space.md, vertical: Space.xs),
          ),
          child: DropdownButtonHideUnderline(
            child: DropdownButton<String?>(
              key: Key('call-field-${f.key}'),
              value: value,
              isExpanded: true,
              items: [
                const DropdownMenuItem<String?>(value: null, child: Text(SoftphoneCopy.choose)),
                for (final o in f.options)
                  DropdownMenuItem<String?>(
                    value: o,
                    child: Text(o, overflow: TextOverflow.ellipsis),
                  ),
              ],
              onChanged: enabled ? _set : null,
            ),
          ),
        );
      case SoftphoneFieldType.boolean:
        final on = f.value == true;
        // Unset is not No: a required yes/no nobody has answered blocks Save,
        // and reading "No" the agent would not see why.
        final answer = f.value == null ? _notAnswered : (on ? SoftphoneCopy.yes : SoftphoneCopy.no);
        return InputDecorator(
          decoration: InputDecoration(
            errorText: f.error,
            errorMaxLines: 4,
            enabled: enabled,
            border: InputBorder.none,
            enabledBorder: InputBorder.none,
            disabledBorder: InputBorder.none,
            filled: false,
            contentPadding: EdgeInsets.zero,
          ),
          child: MergeSemantics(
            child: SwitchListTile(
              key: Key('call-field-${f.key}'),
              contentPadding: EdgeInsets.zero,
              title: _label(context, f),
              subtitle: Text(answer),
              value: on,
              onChanged: enabled ? _set : null,
            ),
          ),
        );
      case SoftphoneFieldType.date:
        final value = f.value is String ? f.value! as String : null;
        return InputDecorator(
          decoration: InputDecoration(
            label: _label(context, f),
            errorText: f.error,
            errorMaxLines: 4,
            enabled: enabled,
            contentPadding: const EdgeInsetsDirectional.only(start: Space.md, top: Space.xs, bottom: Space.xs),
          ),
          child: Row(
            children: [
              Expanded(
                child: TextButton(
                  key: Key('call-field-${f.key}'),
                  style: TextButton.styleFrom(
                    alignment: AlignmentDirectional.centerStart,
                    padding: EdgeInsets.zero,
                    foregroundColor: t.textPrimary,
                  ),
                  onPressed: enabled ? () => _pickDate(context, value) : null,
                  child: Text(value ?? SoftphoneCopy.pickDate),
                ),
              ),
              if (value != null)
                IconButton(tooltip: SoftphoneCopy.clearDate, onPressed: enabled ? () => _set(null) : null, icon: const Icon(Icons.close)),
            ],
          ),
        );
      case SoftphoneFieldType.unsupported:
        return InputDecorator(
          decoration: InputDecoration(label: _label(context, f), helperText: SoftphoneCopy.unsupportedField, enabled: false),
          child: Text(_shown(f.value).isEmpty ? '—' : _shown(f.value), key: Key('call-field-${f.key}'), style: text.bodyMedium),
        );
    }
  }

  Future<void> _pickDate(BuildContext context, String? current) async {
    final now = DateTime.now();
    final initial = current == null ? now : (DateTime.tryParse(current) ?? now);
    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(now.year - 100),
      lastDate: DateTime(now.year + 50),
      helpText: widget.field.label,
    );
    if (picked == null || !mounted) return;
    String two(int n) => n.toString().padLeft(2, '0');
    _set('${picked.year}-${two(picked.month)}-${two(picked.day)}');
  }
}
