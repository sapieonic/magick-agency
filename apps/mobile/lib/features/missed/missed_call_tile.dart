import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';

import '../../app/theme/app_theme.dart';
import '../../app/theme/tokens.dart';
import '../../ui/primitives.dart';
import 'missed_calls_copy.dart';

/// One Missed row: who rang (the matched contact's name above their number,
/// or "Number withheld"), a DNC badge
/// (and, under Call back, that calling back asks for a reason: IQ55), why it was missed, when and which number they rang (and the route), the
/// matched campaign and any callback it booked, a voicemail, and the row's
/// actions: Call back and Mark handled while open, Reopen once handled. The
/// console's row, stacked as its phone-width card is.
class MissedCallTile extends StatelessWidget {
  const MissedCallTile({
    super.key,
    required this.call,
    required this.now,
    required this.userId,
    required this.callBackOffered,
    this.onCallBack,
    this.onMarkHandled,
    this.onReopen,
    this.marking = false,
    this.reopening = false,
    this.team = false,
    this.onClaim,
    this.claiming = false,
    this.error,
  });

  final InboundMissedCall call;
  final DateTime now;

  /// The signed-in agent: "You" on a row they handled.
  final String? userId;

  /// The soft phone may start a call for this agent ([callBackOffered] in call_back.dart).
  final bool callBackOffered;
  final VoidCallback? onCallBack;

  /// Null while another row's action of the same kind is in flight.
  final VoidCallback? onMarkHandled;
  final VoidCallback? onReopen;
  final bool marking;
  final bool reopening;

  /// A Team row (IQ49): nobody's yet, so its one action is Claim (no Call
  /// back, no Mark handled until it is the agent's own).
  final bool team;

  /// Null while another row's Claim is in flight, or once this row's was
  /// refused as no longer there to claim.
  final VoidCallback? onClaim;
  final bool claiming;

  /// This row's last refusal.
  final String? error;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final text = Theme.of(context).textTheme;
    final small = text.bodySmall!;
    final callbackBooked = MissedCopy.callbackBooked(call, now);
    final caller = MissedCopy.caller(call);
    final name = MissedCopy.name(call);
    return DecoratedBox(
      key: ValueKey('missed-row-${call.id}'),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: t.border)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: Space.lg, vertical: Space.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            // IQ54: the matched contact's name above the number. One line, cut short with an
            // ellipsis when it must be: the number below never is.
            if (name != null) ...[
              Text(
                name,
                key: const Key('missed-name'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: text.titleSmall!.copyWith(color: t.textPrimary),
              ),
              const SizedBox(height: 2),
            ],
            // The caller, the DNC badge and the reason pill share a line when
            // they fit, the pill at the line's end; when they do not (a 360 dp
            // phone with DNC and a long reason, or large text) the pill, then
            // the badge, go below, so the number is never cut short to make
            // room for them.
            SizedBox(
              width: double.infinity,
              child: Wrap(
                key: const Key('missed-head'),
                alignment: WrapAlignment.spaceBetween,
                crossAxisAlignment: WrapCrossAlignment.center,
                spacing: Space.sm,
                runSpacing: Space.xs,
                children: [
                  Wrap(
                    spacing: Space.sm,
                    runSpacing: Space.xs,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Text(
                        caller,
                        key: const Key('missed-caller'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: call.isWithheld
                            ? text.titleSmall!.copyWith(color: t.textMuted)
                            : monoStyle(context, size: 15, color: t.textPrimary),
                      ),
                      if (call.callerDnc)
                        Tooltip(
                          message: MissedCopy.dncHint,
                          child: Semantics(
                            label: MissedCopy.dncHint,
                            excludeSemantics: true,
                            child: const StatusPill(MissedCopy.dncBadge, key: Key('missed-dnc'), tone: Tone.danger),
                          ),
                        ),
                    ],
                  ),
                  StatusPill(
                    MissedCopy.whyMissed(call),
                    key: const Key('missed-reason'),
                    tone: call.isOpen ? Tone.warn : Tone.neutral,
                  ),
                ],
              ),
            ),
            const SizedBox(height: Space.xs),
            Text(
              '${MissedCopy.when(call, now)} · ${MissedCopy.rang(call)}',
              key: const Key('missed-meta'),
              style: small,
            ),
            const SizedBox(height: 2),
            Text(
              [call.matchedCampaignName ?? MissedCopy.notMatched, ?callbackBooked].join(' · '),
              key: const Key('missed-campaign'),
              style: small.copyWith(color: call.matchedCampaignName == null ? t.textMuted : t.textSecondary),
            ),
            if (call.hasVoicemail) ...[
              const SizedBox(height: Space.xs),
              Row(
                key: const Key('missed-voicemail'),
                children: [
                  Icon(Icons.voicemail, size: 16, color: t.textSecondary),
                  const SizedBox(width: Space.xs),
                  Flexible(
                    child: Text(
                      '${MissedCopy.voicemail} · ${MissedCopy.voicemailOnConsole}',
                      style: small.copyWith(color: t.textSecondary),
                    ),
                  ),
                ],
              ),
            ],
            if (!call.isOpen) ...[
              const SizedBox(height: Space.xs),
              Text(
                [
                  MissedCopy.handledLabel(call, userId),
                  if (call.handledAt case final at?) MissedCopy.whenAt(at, now),
                ].join(' · '),
                key: const Key('missed-handled'),
                style: small.copyWith(color: t.textSecondary),
              ),
              if (call.handledReason == InboundHandledReason.reached)
                Text(MissedCopy.reachedNote, key: const Key('missed-reached'), style: small.copyWith(color: t.textMuted)),
            ],
            const SizedBox(height: Space.sm),
            Wrap(
              spacing: Space.sm,
              runSpacing: Space.xs,
              children: team
                  ? [
                      FilledButton.tonalIcon(
                        key: const Key('missed-claim'),
                        onPressed: onClaim,
                        icon: const Icon(Icons.person_add_alt_1_outlined, size: 18),
                        label: Semantics(
                          label: MissedCopy.claimLabel(call),
                          excludeSemantics: true,
                          child: Text(claiming ? MissedCopy.claiming : MissedCopy.claim),
                        ),
                      ),
                    ]
                  : call.isOpen
                  ? [
                      if (callBackOffered)
                        OutlinedButton.icon(
                          key: const Key('missed-call-back'),
                          onPressed: call.isWithheld ? null : onCallBack,
                          icon: const Icon(Icons.call, size: 18),
                          label: Semantics(
                            label: call.isWithheld ? MissedCopy.callBackWithheldLabel : MissedCopy.callBackLabel(caller, name: name),
                            excludeSemantics: true,
                            child: const Text(MissedCopy.callBack),
                          ),
                        ),
                      OutlinedButton.icon(
                        key: const Key('missed-mark-handled'),
                        onPressed: onMarkHandled,
                        icon: const Icon(Icons.check, size: 18),
                        label: Text(marking ? MissedCopy.marking : MissedCopy.markHandled),
                      ),
                    ]
                  : [
                      TextButton.icon(
                        key: const Key('missed-reopen'),
                        onPressed: onReopen,
                        icon: const Icon(Icons.replay, size: 18),
                        label: Text(reopening ? MissedCopy.reopening : MissedCopy.reopen),
                      ),
                    ],
            ),
            if (!team && call.isOpen && callBackOffered && call.isWithheld)
              Text(MissedCopy.withheldCallBack, key: const Key('missed-withheld-note'), style: small.copyWith(color: t.textMuted)),
            // IQ55: calling a DNC number back still goes through the soft phone's DNC note
            // and override (SP1), and the row says so before the agent presses Call back.
            if (!team && call.isOpen && callBackOffered && call.callerDnc && !call.isWithheld)
              Padding(
                padding: const EdgeInsets.only(top: Space.xs),
                child: Text(
                  MissedCopy.dncCallBackNote,
                  key: const Key('missed-dnc-note'),
                  style: small.copyWith(color: t.textSecondary),
                ),
              ),
            if (error != null)
              Padding(
                padding: const EdgeInsets.only(top: Space.xs),
                child: Semantics(
                  liveRegion: true,
                  child: Text(error!, key: const Key('missed-row-error'), style: small.copyWith(color: t.danger)),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
