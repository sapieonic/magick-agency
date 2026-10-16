import { useCallback, useState } from 'react';
import { markContactDnc } from '../../../api/agency';
import { useLatestRef } from '../../../hooks/useLatestRef';
import { dncFailureCopy, dncOutcomeCopy, type DncScope } from '../../../utils/agencyDncCopy';
import { errorCode } from '../../../utils/agencyErrors';
import { trackAgencyDncMarked, trackAgencyDncFailed } from '../../../analytics/events';
import type { AgencyActionErrorCode, AgencySessionBootstrap } from '../../../types/agency';

/**
 * Marking the contact on screen Do Not Call: the request, and its result.
 *
 * Split out of `AgentConsolePage`. `DncControl` owns the dialog; this owns what
 * confirming it does and what the control then says.
 */
export interface DncAction {
  inFlight: boolean;
  outcome: string | null;
  failure: string | null;
  confirm: (scope: DncScope, origin: 'shortcut' | 'click') => void;
}

interface DncResult {
  /** The attempt the result is about. Shown only while that contact is on screen. */
  attemptId: string | null;
  inFlight: boolean;
  outcome: string | null;
  failure: string | null;
}

const NO_RESULT: DncResult = { attemptId: null, inFlight: false, outcome: null, failure: null };

export function useDncAction({
  liveAttemptId,
  panelAttemptId,
  bootstrap,
  tenantId,
  accountId,
}: {
  /** The request is made for the call that is live. */
  liveAttemptId: string | null;
  /** The contact on screen — `live`'s, or the one retained through wrap-up. */
  panelAttemptId: string | null;
  bootstrap: AgencySessionBootstrap | null;
  tenantId: string | null;
  accountId: string | null;
}): DncAction {
  /**
   * A new **contact** clears the previous one's DNC result — it was about
   * someone else.
   *
   * The result is tagged with its attempt and read only while the **panel's**
   * attempt is that one, which replaces an effect that reset it on every change
   * of the panel's attempt. Keyed on the panel and not on `live`: `released`
   * sets `live` to null, so keyed on `live?.attempt.attempt_id` this cleared the
   * moment the customer hung up, while the panel still showed that same contact
   * for the whole wrap-up window. "Added to Do Not Call" vanished from under the
   * agent at exactly the moment they were deciding what to write in the note —
   * the console saying less than it knew about a compliance action it had already
   * taken.
   *
   * `inFlight` goes with it, and it has to: on a `released` with
   * `requires_disposition: false` nothing is retained, the panel's attempt goes
   * to null, and the request's handlers *do* return early — so reading the result
   * through the tag is what frees the control in that case. Where the panel is
   * retained the request's own `finally` clears it, because the guard agrees the
   * panel has not moved.
   */
  const [result, setResult] = useState<DncResult>(NO_RESULT);
  const current = result.attemptId !== null && result.attemptId === panelAttemptId ? result : NO_RESULT;

  /**
   * The **panel's** attempt as of now, for the responses to check themselves
   * against.
   *
   * A different notion of "the current attempt" from the hang-up's, because the
   * two answer different questions: a hang-up failure is about a call that is
   * still up, so it dies with `live`; a DNC result is about a *contact*, and the
   * contact stays on screen for the whole wrap-up window. Each piece of state is
   * guarded by the attempt whose lifetime matches it, and the guard and the tag
   * read the same attempt — the guard boundary and the reset boundary are the
   * same boundary. If they were not, the handlers would return early at hangup
   * while the result stayed shown, nothing would clear `inFlight`, and the
   * control would sit disabled reading "Marking…" for the whole wrap-up window.
   */
  const panelAttemptRef = useLatestRef(panelAttemptId);

  /**
   * Mark the contact on the line Do Not Call, scoped to whichever of
   * the two choices the agent made in the dialog.
   *
   * The request asserts `scope`, not a campaign id — the API already knows the
   * campaign from the attempt it is looking at, so this console has nothing to
   * name. `scope === 'campaign'` (the default) is sent explicitly rather than by
   * omission, so the request is self-describing in a log or a test even though
   * absent `scope` means the same thing server-side. `scope === 'tenant'` is the
   * escalation, floored server-side at `agency.dnc.manage`.
   *
   * Fired only from the confirmation dialog — there is no path from a single key
   * or a single click to the request. The outcome copy is scoped to *both* which
   * choice was made and what the response actually promised: on the tenant-wide
   * escalation, `dnc_recorded: false` means that wider list write is still in
   * flight, and claiming it anyway is the overstatement forbids.
   *
   * **No retry.** A retry landing after a new `reserved` would suppress a
   * different customer — the same hazard refuses for the hang-up.
   */
  const confirm = useCallback(
    (scope: DncScope, origin: 'shortcut' | 'click') => {
      const attemptId = liveAttemptId;
      if (!attemptId) return;
      setResult({ attemptId, inFlight: true, outcome: null, failure: null });
      /** Applies only while the result is still about this attempt. */
      const update = (changes: Partial<DncResult>) =>
        setResult((prev) => (prev.attemptId === attemptId ? { ...prev, ...changes } : prev));
      markContactDnc(
        attemptId,
        { scope },
        tenantId ?? undefined,
        accountId ?? undefined,
      )
        .then((response) => {
          // Same stale guard as the hang-up, and for a sharper reason: a response
          // resolving after the next `reserved` would re-paint the previous
          // contact's DNC result onto the new call. "Added to Do Not Call" shown
          // against the customer now on the line is a claim about the wrong person.
          //
          // The guard reads the **panel's** attempt and not `live`'s.
          // `live` has a writer this used to ignore — `released` clears it — so
          // keyed on `live` all three of these handlers returned early at hangup,
          // for a contact still on screen and about to be dispositioned. That lost
          // the confirmation the agent had just earned and, because `finally` went
          // with it, left `inFlight` stuck true: a control reading "Marking…"
          // and disabled for the whole wrap-up window. The panel's attempt still
          // moves on the next `reserved`, so the wrong-person guarantee above is
          // unchanged — it is the *only* thing that moves it.
          if (panelAttemptRef.current !== attemptId) return;
          update({ outcome: dncOutcomeCopy(response, scope) });
          trackAgencyDncMarked({
            campaign_id: bootstrap?.campaign_id ?? '',
            scope,
            dnc_recorded: response.dnc_recorded,
            opened_via: origin,
          });
        })
        .catch((err: unknown) => {
          if (panelAttemptRef.current !== attemptId) return;
          update({ failure: dncFailureCopy(err) });
          // Same structured-code read as the hang-up.
          const code = errorCode(err);
          trackAgencyDncFailed({
            campaign_id: bootstrap?.campaign_id ?? '',
            scope,
            code: code as AgencyActionErrorCode | null,
          });
        })
        .finally(() => {
          if (panelAttemptRef.current !== attemptId) return;
          update({ inFlight: false });
        });
    },
    [liveAttemptId, tenantId, accountId, bootstrap, panelAttemptRef],
  );

  return { inFlight: current.inFlight, outcome: current.outcome, failure: current.failure, confirm };
}
