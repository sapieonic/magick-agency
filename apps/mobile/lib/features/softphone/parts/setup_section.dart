import 'package:collection/collection.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/softphone/softphone_view.dart';
import '../softphone_copy.dart';

/// "Log to" and "Call from": where the call is logged and the number it shows.
///
/// Both are written onto the call when it is placed and cannot change after
/// (caller ID, recording and summary profile come with the tag), so once a call
/// is placed, or in finish mode, the pickers stay where they are, disabled,
/// and say "Fixed for this call". A closed calling window under a tag reads
/// "(campaign time) · may need a reason": the dial checks the contact's own
/// timezone when the number is on the roster, so this can only say "may".
class SetupSection extends ConsumerWidget {
  const SetupSection({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(
      softphoneViewProvider.select(
        (v) => (
          campaigns: v.campaigns,
          tag: v.tagCampaignId,
          callerIds: v.callerIds,
          callerId: v.callerId,
          editable: v.setupEditable,
          onScreen: v.callOnScreen,
        ),
      ),
    );
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    final actions = ref.read(softphoneActionsProvider);
    final tag = s.campaigns.firstWhereOrNull((c) => c.campaignId == s.tag);

    return Column(
      key: const Key('softphone-setup'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SetupPicker<String?>(
          key: const Key('log-to'),
          label: SoftphoneCopy.logTo,
          value: tag?.campaignId,
          items: [const (value: null, label: SoftphoneCopy.notLogged), for (final c in s.campaigns) (value: c.campaignId, label: c.name)],
          onChanged: s.editable ? actions.setTag : null,
        ),
        const SizedBox(height: Space.xs),
        Text(tag == null ? SoftphoneCopy.usesUntagged : SoftphoneCopy.usesCampaign, style: text.bodySmall),
        if (tag?.windowNote case final note?) ...[
          const SizedBox(height: Space.xs),
          Text(
            note,
            key: const Key('window-closed'),
            style: text.bodySmall!.copyWith(color: t.warning),
          ),
        ],
        if (tag?.analysisProfileName case final profile?) ...[
          const SizedBox(height: Space.xs),
          Text(SoftphoneCopy.summarisedWith(profile), style: text.bodySmall),
        ],
        const SizedBox(height: Space.md),
        SetupPicker<String?>(
          key: const Key('caller-id'),
          label: SoftphoneCopy.callFrom,
          value: s.callerIds.any((c) => c.value == s.callerId) ? s.callerId : null,
          items: [
            if (s.callerIds.isEmpty) const (value: null, label: SoftphoneCopy.noNumbers),
            for (final c in s.callerIds) (value: c.value, label: c.label),
          ],
          onChanged: s.editable && s.callerIds.isNotEmpty
              ? (id) {
                  if (id != null) actions.setCallerId(id);
                }
              : null,
        ),
        const SizedBox(height: Space.xs),
        Text(tag == null ? SoftphoneCopy.fromAccountNumbers : SoftphoneCopy.fromCampaignNumbers(tag.name), style: text.bodySmall),
        if (!s.editable && s.onScreen) ...[
          const SizedBox(height: Space.xs),
          Text(SoftphoneCopy.fixedForThisCall, key: const Key('setup-fixed'), style: text.labelSmall),
        ],
      ],
    );
  }
}

/// A labelled picker whose value is the view's, never its own: the core owns
/// the draft, so a redial that changes the tag shows here at once. Disabled
/// (null [onChanged]) it still shows the value, so the agent sees what the
/// call was placed with.
class SetupPicker<T> extends StatelessWidget {
  const SetupPicker({super.key, required this.label, required this.value, required this.items, required this.onChanged});

  final String label;
  final T value;
  final List<({T value, String label})> items;
  final ValueChanged<T>? onChanged;

  @override
  Widget build(BuildContext context) {
    final enabled = onChanged != null;
    return InputDecorator(
      decoration: InputDecoration(
        labelText: label,
        enabled: enabled,
        contentPadding: const EdgeInsets.symmetric(horizontal: Space.md, vertical: Space.xs),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<T>(
          value: value,
          isExpanded: true,
          isDense: false,
          items: [
            for (final i in items)
              DropdownMenuItem<T>(
                value: i.value,
                child: Text(i.label, overflow: TextOverflow.ellipsis),
              ),
          ],
          onChanged: enabled ? (v) => onChanged!(v as T) : null,
        ),
      ),
    );
  }
}
