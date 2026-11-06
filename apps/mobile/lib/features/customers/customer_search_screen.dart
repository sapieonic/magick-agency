import 'dart:async';

import 'package:agency_wire/agency_wire.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/routes.dart';
import '../../app/theme/tokens.dart';
import '../../ui/primitives.dart';
import 'customer_history_controller.dart';
import 'customer_history_copy.dart';

/// Customer history's search box, from the Calls tab: a country picker (the
/// platform default, India until it is read), the number box with its
/// always-visible helper text, a live preview of the number the search will
/// run on ("We'll search for +91 98765 43210", from the same rule the server
/// runs), the refusals, and the last five numbers searched on this phone. A
/// found number opens its history ([Routes.customerHistory]); the number
/// itself never goes in a route.
///
/// The refusals follow the console's timing: letters, symbols, a number a
/// spreadsheet shortened and one too long are refused as they are typed; an
/// empty box and a number still too short only once Search was pressed (until
/// the box is emptied again), so nobody is told off for a number half typed.
class CustomerSearchScreen extends ConsumerStatefulWidget {
  const CustomerSearchScreen({super.key});

  @override
  ConsumerState<CustomerSearchScreen> createState() => _CustomerSearchScreenState();
}

class _CustomerSearchScreenState extends ConsumerState<CustomerSearchScreen> {
  final _text = TextEditingController();

  /// Search was pressed since the box was last empty.
  bool _submitted = false;

  @override
  void initState() {
    super.initState();
    // After the first frame: providers are not changed while the tree builds.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _controller.rereadDefaultIfFailed();
    });
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  CustomerHistoryController get _controller => ref.read(customerHistoryControllerProvider.notifier);

  Future<void> _search([String? raw]) async {
    FocusScope.of(context).unfocus();
    setState(() => _submitted = true);
    final found = await _controller.search(raw ?? _text.text);
    if (!found || !mounted) return;
    unawaited(context.push<void>(Routes.customerHistory));
  }

  Future<void> _pickCountry(SearchCountry current) async {
    final picked = await showModalBottomSheet<SearchCountry>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: ListView(
          key: const Key('customer-countries'),
          shrinkWrap: true,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(Space.lg, 0, Space.lg, Space.sm),
              child: Text(CustomerHistoryCopy.pickCountry, style: Theme.of(context).textTheme.titleMedium),
            ),
            for (final c in searchCountries)
              ListTile(
                key: Key('customer-country-${c.iso}'),
                title: Text(c.name),
                trailing: Text('+${c.callingCode}'),
                selected: c == current,
                onTap: () => Navigator.of(context).pop(c),
              ),
          ],
        ),
      ),
    );
    if (picked != null && mounted) {
      _controller.pickCountry(picked);
      setState(() {}); // the preview follows the country
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(customerHistoryControllerProvider);
    final country = s.country;
    final text = Theme.of(context).textTheme;
    final t = context.tokens;
    final parsed = parseSearchNumber(_text.text, country);
    final liveError = switch (parsed) {
      SearchNumberRefused(:final code, :final message)
          when _submitted || (code != CustomerSearchNumberError.empty && code != CustomerSearchNumberError.tooShort) =>
        message,
      _ => null,
    };

    return Scaffold(
      appBar: AppBar(title: Semantics(header: true, child: const Text(CustomerHistoryCopy.searchTitle))),
      body: ListView(
        padding: const EdgeInsets.all(Space.lg),
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                height: 56,
                child: OutlinedButton(
                  key: const Key('customer-country'),
                  onPressed: s.searching ? null : () => unawaited(_pickCountry(country)),
                  child: Semantics(
                    label: '${CustomerHistoryCopy.countryLabel}: ${country.name}',
                    excludeSemantics: true,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [Text('${country.iso} +${country.callingCode}'), const Icon(Icons.arrow_drop_down)],
                    ),
                  ),
                ),
              ),
              const SizedBox(width: Space.sm),
              Expanded(
                child: TextField(
                  key: const Key('customer-number'),
                  controller: _text,
                  autofocus: true,
                  enabled: !s.searching,
                  keyboardType: TextInputType.phone,
                  textInputAction: TextInputAction.search,
                  autocorrect: false,
                  enableSuggestions: false,
                  maxLength: customerSearchValueMax,
                  decoration: InputDecoration(
                    labelText: CustomerHistoryCopy.numberLabel,
                    errorText: liveError ?? s.searchError,
                    errorMaxLines: 3,
                    counterText: '',
                  ),
                  onChanged: (raw) {
                    _controller.editing();
                    setState(() {
                      if (raw.trim().isEmpty) _submitted = false;
                    });
                  },
                  onSubmitted: (_) => unawaited(_search()),
                ),
              ),
            ],
          ),
          const SizedBox(height: Space.sm),
          Text(
            CustomerHistoryCopy.helper(country.callingCode),
            key: const Key('customer-helper'),
            style: text.bodySmall,
          ),
          const SizedBox(height: Space.xs),
          Text(CustomerHistoryCopy.helperOtherCountry, style: text.bodySmall),
          const SizedBox(height: Space.md),
          Semantics(
            liveRegion: true,
            child: switch (parsed) {
              SearchNumberOk(:final formatted) => Text(
                CustomerHistoryCopy.preview(formatted),
                key: const Key('customer-preview'),
                style: text.bodyMedium!.copyWith(color: t.textPrimary, fontWeight: FontWeight.w600),
              ),
              _ => const SizedBox.shrink(),
            },
          ),
          const SizedBox(height: Space.md),
          FilledButton.icon(
            key: const Key('customer-search'),
            onPressed: s.searching ? null : () => unawaited(_search()),
            icon: s.searching
                ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.search),
            label: const Text(CustomerHistoryCopy.search),
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(Space.touch)),
          ),
          if (s.recent.isNotEmpty) ...[
            const SizedBox(height: Space.xl),
            SectionLabel(
              CustomerHistoryCopy.recent,
              trailing: TextButton(
                key: const Key('customer-recent-clear'),
                onPressed: s.searching ? null : () => unawaited(_controller.clearRecent()),
                child: const Text(CustomerHistoryCopy.clearRecent),
              ),
            ),
            for (final r in s.recent)
              ListTile(
                key: Key('customer-recent-${r.e164}'),
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.history),
                title: Text(r.display),
                enabled: !s.searching,
                onTap: () {
                  _text.text = r.e164;
                  unawaited(_search(r.e164));
                },
              ),
          ],
        ],
      ),
    );
  }
}
