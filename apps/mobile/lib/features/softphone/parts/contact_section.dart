import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/softphone/softphone_view.dart';
import '../../../ui/primitives.dart';
import '../../station/parts/contact_details.dart';
import '../softphone_copy.dart';

/// The roster contact the dialled number matched, drawn as the station's
/// screen pop draws one (hero fields, prior attempts, the rest folded away),
/// and whether this call's outcome settles that contact.
///
/// Every value is operator-uploaded file content and is rendered as plain text.
class ContactSection extends ConsumerWidget {
  const ContactSection({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final contact = ref.watch(softphoneViewProvider.select((v) => v.contact));
    final callId = ref.watch(softphoneViewProvider.select((v) => v.callId));
    if (contact == null) return const SizedBox.shrink();
    final text = Theme.of(context).textTheme;
    return AppCard(
      key: const Key('roster-contact'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            spacing: Space.sm,
            runSpacing: Space.xs,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              const StatusPill(SoftphoneCopy.onTheRoster, tone: Tone.ok),
              Text(SoftphoneCopy.rosterContact(contact.campaignName), style: text.bodySmall),
            ],
          ),
          if (contact.heroFields.isNotEmpty) ...[
            const SizedBox(height: Space.md),
            HeroFieldsGrid(fields: contact.heroFields, configured: contact.heroesConfigured),
          ],
          if (contact.priorAttempts.isNotEmpty) ...[
            const SizedBox(height: Space.md),
            // All of them: the station's "+n more in Details" has no Details here.
            PriorAttemptsCard(attempts: contact.priorAttempts),
          ],
          if (contact.otherFields.isNotEmpty) ...[
            const SizedBox(height: Space.md),
            MoreDetails(key: ValueKey('more-$callId'), fields: contact.otherFields),
          ],
          const SizedBox(height: Space.sm),
          Text(contact.claimed ? SoftphoneCopy.claimed : SoftphoneCopy.notClaimed, key: const Key('contact-claim'), style: text.bodySmall),
        ],
      ),
    );
  }
}
