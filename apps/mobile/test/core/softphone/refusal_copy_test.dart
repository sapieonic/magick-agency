import 'package:agency_wire/agency_wire.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:magick_agency_agent/core/api/api_error.dart';
import 'package:magick_agency_agent/core/softphone/refusal_copy.dart';

/// The console's refusal-copy table (`softphoneFields.test.ts` "refusal copy"),
/// with the app's ways out where the console names a page.
void main() {
  ErrorBody body(String code, [String message = 'The server’s words']) =>
      ErrorBody.fromJson({'error': 'Conflict', 'code': code, 'message': message});

  test('has a sentence for every soft-phone code', () {
    for (final code in SoftphoneErrorCode.values) {
      if (code == SoftphoneErrorCode.unknown) continue;
      expect(softphoneRefusalCopy[code], matches(RegExp(r'\S')), reason: code.wire);
    }
  });

  test('gives the refusals an agent can hit by mistake a next step, not just a fact', () {
    expect(softphoneRefusalCopy[SoftphoneErrorCode.wrongSessionKind], contains('Close the soft phone, then join the campaign'));
    expect(softphoneRefusalCopy[SoftphoneErrorCode.fieldsInvalid], contains('marked in Call details'));
  });

  test('contact assignment: a strict campaign’s contact of another agent, in the console’s words', () {
    expect(refusalCopy(body('contact_assigned_elsewhere')), 'This number belongs to another agent on this campaign.');
  });

  test('never sends an agent to a page the app does not have', () {
    for (final text in softphoneRefusalCopy.values) {
      expect(text, isNot(contains('Reload the page')));
      expect(text, isNot(contains('browser')));
    }
  });

  test('a status change the server did not take is not a call that was not placed', () {
    final refusal = body('dial_failed');
    expect(refusalCopy(refusal), contains('call couldn’t be placed'));
    expect(
      refusalCopy(refusal, context: SoftphoneRefusalContext.status),
      'Couldn’t change your status just now; nothing changed. Try again.',
    );
    expect(refusalCopy(refusal, context: SoftphoneRefusalContext.status), isNot(matches(RegExp('call|dialled', caseSensitive: false))));
    // Codes the status context does not reword keep their one sentence.
    expect(
      refusalCopy(body('session_not_found'), context: SoftphoneRefusalContext.status),
      softphoneRefusalCopy[SoftphoneErrorCode.sessionNotFound],
    );
  });

  test('a code this build does not know shows the server’s own sentence', () {
    expect(refusalCopy(body('boom'), context: SoftphoneRefusalContext.status), 'The server’s words');
    expect(refusalCopy(body('boom', '')), isNotEmpty);
  });

  group('softphoneErrorCopy', () {
    test('a soft-phone refusal reads through the table', () {
      const e = ApiHttpError(status: 409, code: 'outcome_pending', message: 'x', body: {'code': 'outcome_pending', 'message': 'x'}, requestId: null);
      expect(softphoneErrorCopy(e), softphoneRefusalCopy[SoftphoneErrorCode.outcomePending]);
    });

    test('anything else reads as the API layer words it', () {
      expect(softphoneErrorCopy(const ApiNetworkError('offline')), const ApiNetworkError('offline').userMessage);
      const plain = ApiHttpError(status: 400, code: 'validation_failed', message: 'Bad number.', body: {'message': 'Bad number.'}, requestId: null);
      expect(softphoneErrorCopy(plain), 'Bad number.');
      expect(softphoneErrorCopy(StateError('x')), isNotEmpty);
    });
  });
}
