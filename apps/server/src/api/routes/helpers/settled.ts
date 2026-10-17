/**
 * The value of a settled read, or its rejection rethrown unchanged.
 *
 * For a route that starts two independent reads together (`Promise.allSettled`) and
 * then answers from them IN ITS OWN ORDER: reading the results one at a time with this
 * keeps the error precedence of the sequential version — the first read's refusal or
 * throw still wins over anything the second one did, because the second result is only
 * looked at once the first has passed. `Promise.all` would instead surface whichever
 * rejection happened first in time.
 */
export function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}
