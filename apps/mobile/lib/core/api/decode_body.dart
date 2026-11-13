import 'api_error.dart';

/// Decodes an answer [body] read from [path] with [decode]. A body that is not the contract's
/// shape (not an object, a missing or mistyped field, a value that does not parse) is an
/// [ApiDecodeError], not a crash on the UI isolate.
T decodeBody<T>(String path, Object? body, T Function(Map<String, Object?>) decode) {
  if (body is! Map<String, Object?>) throw ApiDecodeError(path, 'expected a JSON object');
  try {
    return decode(body);
  } on FormatException catch (e) {
    // The wire types' own WireFormatException included.
    throw ApiDecodeError(path, e);
  } on TypeError catch (e) {
    throw ApiDecodeError(path, e);
  }
}
