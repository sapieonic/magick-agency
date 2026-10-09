import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `saveAttemptNotes` — the guard moved INSIDE the client (§A.13.7).
 *
 * The hazard is specific: **`notes: ''` clears the attempt's notes wholesale**,
 * because the request replaces rather than merges. `mayAutosave()` has existed
 * since Phase 1 and the rule was "call it before every send" — with nothing
 * enforcing it. These tests hold the enforcement rather than the rule.
 *
 * The load-bearing assertion in every refusal case below is on **`apiFetch`**, not
 * on the return value: a version that returned `{saved:false}` *and* sent the
 * request would satisfy any assertion about the outcome shape while still wiping
 * the server copy.
 */

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../../api/client', () => ({ apiFetch: mocks.apiFetch }));

import { saveAttemptNotes } from '../../api/agency';
import type { AutosaveGuardInput } from '../../utils/agencyNotes';

const ATTEMPT = 'attempt-a';
const TENANT = 't1';

function request(overrides: Partial<AutosaveGuardInput> = {}): AutosaveGuardInput {
  return {
    hydrated: true,
    notes: 'customer asked for a callback',
    editSource: 'agent_edit',
    attemptId: ATTEMPT,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.apiFetch.mockResolvedValue({
    attempt_id: ATTEMPT,
    notes: 'customer asked for a callback',
    updated_at: '2026-08-11T14:32:00.000Z',
  });
});

describe('the destructive call cannot be made unguarded', () => {
  it('sends nothing at all before hydration completes', () => {
    // A save racing the restore-from-local step sends `''` and wipes the server
    // copy — the agent then watches their notes vanish from a field they were
    // reading.
    return saveAttemptNotes(request({ hydrated: false, notes: '' }), TENANT).then((outcome) => {
      expect(mocks.apiFetch).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ saved: false, refusal: 'not_hydrated' });
    });
  });

  it('sends nothing before hydration even when the text is non-empty', () => {
    // Hydration gates ALL saves. A non-empty pre-hydration value is whatever the
    // component happened to mount with, not the agent's text.
    return saveAttemptNotes(request({ hydrated: false }), TENANT).then((outcome) => {
      expect(mocks.apiFetch).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ saved: false, refusal: 'not_hydrated' });
    });
  });

  it.each(['hydration', 'mount', 'reset', 'attempt_switch'] as const)(
    'refuses an empty save caused by %s rather than by the agent',
    async (editSource) => {
      const outcome = await saveAttemptNotes(request({ notes: '', editSource }), TENANT);
      expect(mocks.apiFetch).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ saved: false, refusal: 'empty_without_agent_provenance' });
    },
  );

  it('refuses a whitespace-only save without agent provenance', () => {
    // Whitespace clears just as destructively as an empty string.
    return saveAttemptNotes(request({ notes: '   ', editSource: 'mount' }), TENANT).then(() => {
      expect(mocks.apiFetch).not.toHaveBeenCalled();
    });
  });

  it('carries a greppable diagnostic naming the attempt and the cause', () => {
    // "The notes I typed disappeared" is a support question; this is the answer.
    return saveAttemptNotes(request({ notes: '', editSource: 'reset' }), TENANT).then((outcome) => {
      expect(outcome.saved).toBe(false);
      if (outcome.saved) return;
      expect(outcome.diagnostic).toContain(ATTEMPT);
      expect(outcome.diagnostic).toContain('reset');
    });
  });
});

describe('the asymmetry is preserved — provenance gates ONLY the empty save', () => {
  it('lets a hydrated non-empty save through without agent provenance', () => {
    // This is the case a blanket "require provenance" would break: flushing
    // hydrated local text up to a server that never received it, which is the
    // entire reason the local buffer exists. A non-empty save cannot destroy
    // anything — worst case it writes text the agent typed.
    return saveAttemptNotes(request({ editSource: 'hydration' }), TENANT).then((outcome) => {
      expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
      expect(outcome.saved).toBe(true);
    });
  });

  it('lets a real clear through when the agent did it', () => {
    // The empty string is a legitimate value. A blanket rejection would mean an
    // agent who deletes a mistaken note can never remove it from the server.
    return saveAttemptNotes(request({ notes: '', editSource: 'agent_edit' }), TENANT).then((outcome) => {
      expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
      const [, options] = mocks.apiFetch.mock.calls[0]!;
      expect(JSON.parse(options.body as string)).toEqual({ notes: '' });
      expect(outcome.saved).toBe(true);
    });
  });
});

describe('the wire shape', () => {
  it('POSTs to the attempt’s notes route with the tenant forwarded', async () => {
    await saveAttemptNotes(request(), TENANT);
    const [url, options, tenantId] = mocks.apiFetch.mock.calls[0]!;
    expect(url).toContain(`/proxy/agency/attempts/${ATTEMPT}/notes`);
    expect(options.method).toBe('POST');
    expect(tenantId).toBe(TENANT);
  });

  it('sends exactly the string that was checked', () => {
    // One object rather than `(attemptId, notes, guard)`: with the payload and the
    // checked value as separate parameters they can disagree — check one string,
    // send another — and the call site would look perfectly correct.
    return saveAttemptNotes(request({ notes: 'the one true value' }), TENANT).then(() => {
      const [, options] = mocks.apiFetch.mock.calls[0]!;
      expect(JSON.parse(options.body as string)).toEqual({ notes: 'the one true value' });
    });
  });

  it('propagates a server failure rather than swallowing it as a refusal', async () => {
    // A refusal is the guard declining to destroy data; a 500 is a failure the
    // status line has to report as "not saved". Collapsing them would render a
    // real failure as a benign skip.
    mocks.apiFetch.mockRejectedValueOnce(new Error('503'));
    await expect(saveAttemptNotes(request(), TENANT)).rejects.toThrow('503');
  });
});

describe('foreign-write detection compares the echo against what was SENT', () => {
  it('reports a foreign write when the echo differs', async () => {
    // A supervisor writing `on_behalf` while the agent types is a supported
    // operation, not an anomaly.
    mocks.apiFetch.mockResolvedValueOnce({
      attempt_id: ATTEMPT,
      notes: 'supervisor rewrote this',
      updated_at: '2026-08-11T14:32:00.000Z',
    });
    const outcome = await saveAttemptNotes(request({ notes: 'agent wrote this' }), TENANT);
    expect(outcome).toMatchObject({ saved: true, foreignWrite: true, sentNotes: 'agent wrote this' });
  });

  it('reports no foreign write when the echo matches', async () => {
    const outcome = await saveAttemptNotes(request(), TENANT);
    expect(outcome).toMatchObject({ saved: true, foreignWrite: false });
  });

  it('does not compare against the live field — the caller never gets the chance', async () => {
    // Comparing to the current field value reports a foreign write on every save
    // that overlapped a keystroke, which is most of them during active typing, and
    // the notice fires constantly for a condition that never occurred. The
    // comparison is computed here, so there is no live field in scope to get wrong.
    mocks.apiFetch.mockResolvedValueOnce({
      attempt_id: ATTEMPT,
      notes: 'first sentence',
      updated_at: '2026-08-11T14:32:00.000Z',
    });
    const outcome = await saveAttemptNotes(request({ notes: 'first sentence' }), TENANT);
    // The agent has since typed more, but this save is about what it sent.
    expect(outcome).toMatchObject({ foreignWrite: false, sentNotes: 'first sentence' });
  });

  it('hands back updated_at from the server for the falsifiable readout', async () => {
    // "Saved 14:32" must come from what the SERVER recorded, never local time: an
    // agent whose latest sentence did not land sees a timestamp that has stopped
    // advancing. A locally-generated "Saved just now" would keep claiming success
    // no matter what was stored.
    const outcome = await saveAttemptNotes(request(), TENANT);
    expect(outcome.saved).toBe(true);
    if (!outcome.saved) return;
    expect(outcome.response.updated_at).toBe('2026-08-11T14:32:00.000Z');
  });
});
