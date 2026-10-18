import { useCallback, useMemo } from 'react';
import {
  groupPriorAttempts,
  priorDispositionIsRaw,
  priorDispositionLabel,
} from '../../utils/agencyPriorAttempts';
import type { AgencyDisposition, AgencyReservedAttempt } from '../../types/agency';
import styles from './AgentStation.module.css';

/*
 * `resolveDispositionLabel` used to live in `AgentConsolePage` and rendered an unrecognised code
 * as the literal words "Unknown outcome". That was defensible while prior
 * attempts could only come from THIS campaign — an unknown code then really was
 * a stale console. Once history spans a retry lineage it is routine: the parent
 * campaign's catalog is not on this bootstrap and must not be (the agent role
 * holds four `agency.*` permissions and nothing that reads another campaign's
 * configuration), so a code the parent had and the child does not is a code this
 * console structurally cannot name. "Unknown outcome" then reads as "the write-up
 * was lost" about a write-up that is intact.
 *
 * The rule and the reasoning moved to `utils/agencyPriorAttempts.ts`, beside the
 * grouping that makes the campaign name visible next to the raw code.
 */

/** The contact's earlier attempts, grouped by the campaign each came from. */
export function PriorAttemptsList({
  attempt,
  currentCatalog,
}: {
  attempt: AgencyReservedAttempt;
  /** THIS campaign's `disposition_catalog`, from the bootstrap. */
  currentCatalog: AgencyDisposition[] | undefined;
}) {
  /**
   * The catalog a prior attempt's disposition may be resolved through — THIS
   * campaign's for this campaign's attempts, and nothing at all for an
   * ancestor's.
   *
   * Disposition codes are campaign-local: each campaign carries its own
   * `disposition_catalog`, and a retry may have been authored with a different
   * one from its parent. Resolving an ancestor's code through the child's
   * catalog therefore prints THIS campaign's label as the historical write-up —
   * "Callback" where the parent's catalog said "Wrong number" — which is worse
   * than the raw code, because it is a plausible sentence that is false. The
   * agent is reading this panel precisely to know what happened LAST time.
   *
   * The raw-code fallback is already the designed answer for a code the catalog
   * does not carry (`data-unlabelled` styles it as a slug rather than passing an
   * enum off as prose), so an ancestor group simply takes that path.
   */
  const priorCatalog = useCallback(
    (isCurrent: boolean) => (isCurrent ? currentCatalog : undefined),
    [currentCatalog],
  );

  /**
   * Prior attempts, split by the campaign each one came from.
   *
   * Memoised on the attempt, not on the array: `prior_attempts` arrives as part
   * of one `reserved` frame and never changes for the life of that attempt, so
   * this runs once per call — which matters because everything on this panel is
   * computed while a customer is already ringing.
   *
   * The bootstrap supplies the fallback identity for a group with no campaign
   * of its own; see `groupPriorAttempts` for why that is "this campaign" rather
   * than a placeholder.
   */
  const priorGroups = useMemo(
    () => groupPriorAttempts(attempt.prior_attempts, attempt.campaign_id, attempt.campaign_name),
    [attempt],
  );

  return (
    <>
      {attempt.prior_attempts.length > 0 ? (
        /*
          ── Grouped by campaign, this one first ────────────────────
          The API's read is lineage-scoped now: a contact retried from an
          earlier campaign carries that campaign's attempts here too.
          A flat list of them is unreadable, because `attempt_number`
          is per-campaign and RESETS — two passes would each show an
          "attempt 1" and nothing would say which pass either belonged
          to. The campaign name is what makes the history legible, and
          it is also the only thing about an ancestor campaign the
          agent is given: no stats, no connect
          rate, no roster counts, no agent roster.

          The heading count stays the TOTAL across groups, because it
          is capped at 20 across the whole lineage and a per-group
          count would not add up to what the agent can see.
        */
        <section className={styles.priorAttempts} data-testid="prior-attempts">
          <h2 className={styles.sectionTitle}>
            Prior attempts ({attempt.prior_attempts.length})
          </h2>
          {priorGroups.map((group) => (
            <div
              key={group.campaignId}
              className={styles.priorGroup}
              data-testid={`prior-group-${group.campaignId}`}
              data-current={String(group.isCurrent)}
            >
              <h3 className={styles.priorGroupTitle}>
                {/*
                  "This campaign" rather than its name for the group
                  the agent is signed into: the name is already in the
                  station header two inches up, and repeating it here
                  makes the one group that is NOT theirs harder to
                  pick out — which is the whole point of the split.
                */}
                <span className={styles.priorGroupName}>
                  {group.isCurrent ? 'This campaign' : group.campaignName}
                </span>
                <span className={styles.priorGroupCount}>{group.attempts.length}</span>
              </h3>
              <ul className={styles.priorList}>
                {group.attempts.map((prior) => (
                  /*
                    Keyed on campaign + number, never on the number
                    alone: it is unique per contact row and a lineage
                    carries one row per campaign, so two groups
                    legitimately both hold an "attempt 1".
                  */
                  <li
                    key={`${group.campaignId}:${prior.attempt_number}`}
                    className={styles.priorItem}
                  >
                    <span
                      className={styles.priorOutcome}
                      /*
                        Set when the code could not be named — see
                        `priorDispositionLabel`. It styles the value as
                        the code it is rather than passing an enum off
                        as prose, and the campaign name above it is the
                        explanation for why there is no label.
                      */
                      data-unlabelled={
                        priorDispositionIsRaw(
                          prior.disposition_code,
                          priorCatalog(group.isCurrent),
                        ) || undefined
                      }
                    >
                      {priorDispositionLabel(
                        prior.disposition_code,
                        priorCatalog(group.isCurrent),
                      )}
                    </span>
                    {prior.notes ? (
                      <span className={styles.priorNote}>{prior.notes}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}
