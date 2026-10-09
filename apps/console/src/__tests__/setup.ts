import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { resetLiveSessionForTests } from '../utils/agencyLiveSession';

/**
 * Global unmount between test cases. **Do not delete this file.**
 *
 * ── Why it is needed, given the library already does this ────────────────────
 * `@testing-library/react` registers its own `afterEach(cleanup)` — but only
 * behind a guard that checks whether `afterEach` exists **as a global**
 * (`node_modules/@testing-library/react/dist/index.js`). This suite runs without
 * `globals: true` and every test imports `describe`/`it`/`expect`/`afterEach`
 * explicitly from `'vitest'`, so `globalThis.afterEach` is `undefined` and that
 * registration silently never happens. The library's auto-cleanup has therefore
 * been **inert for the entire life of this repo**, with no warning and nothing in
 * the output to suggest it.
 *
 * The consequence is not a leak in the memory sense — it is cross-test
 * contamination. Every `render()` and `renderHook()` stayed mounted for the rest
 * of its file: effects kept running, intervals kept firing, and pending timers
 * kept resolving inside *later* tests' windows. Most `src/__tests__/pages/*`
 * files call `cleanup()` by hand; most `src/__tests__/hooks/*` did not.
 *
 * ── The concrete instance this was traced from ───────────────────────────────
 * `hooks/useAgencyStation.test.ts` has a case that drops the socket with code
 * 1006 and asserts the hook reports `reconnecting`. That schedules a 500ms
 * reconnect. With the hook still mounted, the timer fired during the *next*
 * `describe` and opened a second `FakeSocket` — which then became `latest()`, the
 * socket the heartbeat tests assert `sent[0]` on. Those tests were reading a
 * socket they never created, from a test that had already finished.
 *
 * ── Why not `globals: true` ──────────────────────────────────────────────────
 * Setting it would satisfy the library's guard, but it changes name resolution
 * for all ~330 test files at once and makes every explicit `'vitest'` import
 * redundant-but-shadowing. `setupFiles` fixes the actual problem — no global
 * `afterEach` — and touches nothing else.
 *
 * This file is **not itself collected as a test**: `include` is
 * `src/**\/*.test.ts(x)` and this is `setup.ts`.
 */
afterEach(() => {
  cleanup();
  resetLiveSessionForTests();
});
