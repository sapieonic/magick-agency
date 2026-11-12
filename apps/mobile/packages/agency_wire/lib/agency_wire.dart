/// Wire types for the Magick Agency agent app: the station socket, the
/// session and action routes, the soft phone, the agent's own reads, customer
/// history (with its search-box number rule), the platform shapes, and Mode B's
/// push devices and ring routes.
///
/// Hand-written against `packages/contracts/src`; every type names the
/// TypeScript type it mirrors. Drift guards: `packages/contracts/fixtures/agent/`.
library;

export 'src/actions.dart';
export 'src/assignment.dart';
export 'src/customer_history.dart';
export 'src/customer_search_number.dart';
export 'src/enums.dart' hide wireIndex;
export 'src/errors.dart';
export 'src/inbound.dart';
export 'src/json.dart' show WireFormatException;
export 'src/platform.dart';
export 'src/push_devices.dart';
export 'src/reads.dart';
export 'src/session.dart';
export 'src/softphone.dart';
export 'src/station.dart';
