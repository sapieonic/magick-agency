import type * as CoreDispatch from '../../src/api/core-dispatch.js';

/**
 * The `core-dispatch.js` module for a suite that replaces `callCore` with a double.
 *
 * `forwardCore` is built over `callCore` inside the module, so replacing `callCore` alone
 * would leave every pass-through route calling the REAL dispatcher (and throwing, with no
 * internal handler instance registered). This rebuilds it over the double with the
 * module's own `forwardCoreVia`, so the pass-through under test is the real one:
 *
 * ```ts
 * vi.mock('../../../src/api/core-dispatch.js', async (importOriginal) =>
 *   (await import('../../helpers/core-dispatch-double.js')).coreDispatchDouble(
 *     await importOriginal(), mocks.proxyToCore));
 * ```
 */
export function coreDispatchDouble(
  actual: typeof CoreDispatch,
  callCore: (req: CoreDispatch.CoreCallRequest) => Promise<CoreDispatch.CoreCallResult>,
): typeof CoreDispatch {
  return { ...actual, callCore, forwardCore: actual.forwardCoreVia(callCore) };
}
