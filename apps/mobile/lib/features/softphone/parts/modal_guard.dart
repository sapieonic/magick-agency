import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/theme/tokens.dart';
import '../../../core/softphone/softphone_view.dart';
import '../softphone_copy.dart';

/// Whether a soft-phone dialog or sheet still belongs on screen, given the view
/// as it is now.
typedef SoftphoneModalScope = bool Function(SoftphoneView view);

/// About one call: holds while [callId] is still the call on screen. The call
/// settling, or another replacing it, closes the dialog, so a question about
/// one customer is never answered about the next.
SoftphoneModalScope sameSoftphoneCall(String? callId) =>
    (v) => v.callId == callId;

/// Closes the dialog or sheet it sits in once [scope] stops holding (the
/// station's `StationModalGuard`, on the soft phone's view). Closing answers
/// nothing: the caller gets null.
class SoftphoneModalGuard extends ConsumerStatefulWidget {
  const SoftphoneModalGuard({super.key, required this.scope, required this.child});

  final SoftphoneModalScope scope;
  final Widget child;

  @override
  ConsumerState<SoftphoneModalGuard> createState() => _SoftphoneModalGuardState();
}

class _SoftphoneModalGuardState extends ConsumerState<SoftphoneModalGuard> {
  bool _closing = false;

  @override
  void initState() {
    super.initState();
    // Immediately too: the view may have moved on while the route was opening.
    ref.listenManual<bool>(softphoneViewProvider.select(widget.scope), (_, holds) {
      if (!holds) _close();
    }, fireImmediately: true);
  }

  void _close() {
    if (_closing) return;
    _closing = true;
    // Not inside the build or notification that told us.
    Future.microtask(() {
      if (!mounted) return;
      final route = ModalRoute.of(context);
      if (route == null || !route.isActive) return;
      final navigator = Navigator.of(context);
      route.isCurrent ? navigator.pop() : navigator.removeRoute(route);
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// A yes/no dialog, closed (answered "no") once [scope] stops holding.
/// [danger] paints the confirm action as destructive.
Future<bool> softphoneConfirm(
  BuildContext context, {
  required String title,
  required String message,
  required String confirm,
  String cancel = SoftphoneCopy.cancel,
  bool danger = false,
  SoftphoneModalScope? scope,
}) async {
  final t = context.tokens;
  final ok = await showDialog<bool>(
    context: context,
    builder: (context) {
      final dialog = AlertDialog(
        title: Text(title),
        content: SingleChildScrollView(child: Text(message)),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: Text(cancel)),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            style: danger ? FilledButton.styleFrom(backgroundColor: t.dangerDeep, foregroundColor: t.onAccent) : null,
            child: Text(confirm),
          ),
        ],
      );
      return scope == null ? dialog : SoftphoneModalGuard(scope: scope, child: dialog);
    },
  );
  return ok ?? false;
}
