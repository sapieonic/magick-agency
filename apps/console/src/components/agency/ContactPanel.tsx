import { heroesWereConfigured, type ResolvedContext } from '../../utils/agencyContext';
import { resolveReleaseCopy, releaseShape, releaseAccount } from '../../utils/agencyReleaseCopy';
import {
  DIALLING_HEADLINE,
  DIALLING_HINT,
  IDLE_PAUSED_HINT,
  IDLE_WAITING_HINT,
  unansweredLine,
  waitingHeadline,
} from '../../utils/agencyStationIdle';
import type { DialActivityDisplay } from '../../hooks/useDialActivityDisplay';
import { redialTag } from '../../utils/agencyRedialCopy';
import type {
  AgencyMissedRelease,
  AgencyReservedAttempt,
  AgencySessionBootstrap,
  AgencyStationReleasedFrame,
} from '../../types/agency';
import styles from './AgentStation.module.css';

/**
 * Column 1 — who is on the line: the dialled number, the attempt, the hero
 * fields. With no contact on screen, the idle panel and its account of the last
 * call in their place.
 */
export function ContactPanel({
  attempt,
  resolved,
  contextDisplay,
  dialing,
  release,
  missedRelease,
  lostDisposition,
  dialActivity = null,
}: {
  /** The contact on screen — `live`'s, or the one retained through wrap-up. */
  attempt: AgencyReservedAttempt | null;
  resolved: ResolvedContext | null;
  contextDisplay: AgencySessionBootstrap['context_display'] | undefined;
  dialing: boolean;
  release: AgencyStationReleasedFrame | null;
  missedRelease: AgencyMissedRelease | null;
  lostDisposition: string | null;
  /** Late binding's hidden dials, smoothed (`useDialActivityDisplay`); null for today's copy. */
  dialActivity?: DialActivityDisplay | null;
}) {
  return (
    <>
      {attempt && resolved ? (
        <>
          <p className={styles.dialled}>{attempt.phone_e164}</p>
          <p className={styles.attemptMeta}>
            Attempt {attempt.attempt_number}
            {/* A wrap-up redial keeps its tag through the call and its own wrap-up. */}
            {attempt.redial ? (
              <span data-testid="contact-redial-tag"> · {redialTag(attempt.redial)}</span>
            ) : null}
          </p>
          {resolved.hero.length > 0 ? (
            <dl className={styles.heroList}>
              {resolved.hero.map((field) => (
                <div key={field.label} className={styles.heroField}>
                  <dt className={styles.heroLabel}>{field.label}</dt>
                  <dd className={styles.heroValue}>{field.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {!heroesWereConfigured(contextDisplay) && resolved.hero.length > 0 ? (
            // Show the heuristic's output AS a heuristic — an agent must not
            // come to trust four guessed fields as the operator's choice.
            <p className={styles.autoSelected}>auto-selected</p>
          ) : null}
        </>
      ) : (
        <IdlePanel
          dialing={dialing}
          release={release}
          missedRelease={missedRelease}
          lostDisposition={lostDisposition}
          dialActivity={dialActivity}
        />
      )}
    </>
  );
}

export function IdlePanel({
  dialing,
  release,
  missedRelease,
  lostDisposition,
  dialActivity = null,
}: {
  dialing: boolean;
  release: AgencyStationReleasedFrame | null;
  missedRelease: AgencyMissedRelease | null;
  lostDisposition: string | null;
  /**
   * Late binding's hidden dials, or null. Only ever set while the agent is available with the
   * campaign dialling and nothing on screen (the page's condition), so it changes the resting
   * copy and nothing that outranks it: a release or a missed release still comes first.
   */
  dialActivity?: DialActivityDisplay | null;
}) {
  const diallingNow = dialActivity?.dialling === true;
  const unanswered = dialActivity ? unansweredLine(dialActivity.unansweredInARow) : null;
  const headline = dialing ? waitingHeadline(diallingNow) : 'No calls will come through right now.';
  return (
    <div className={styles.releasePanel}>
      {release && releaseShape(release) === 'dim_and_clear' ? (
        <>
          <p className={styles.releaseHeadline}>{resolveReleaseCopy(release).headline}</p>
          <p className={styles.releaseSubtext}>{resolveReleaseCopy(release).subtext}</p>
        </>
      ) : release ? (
        /*
          ── A release that no wrap-up ever explained ──────────────
          `releaseShape` is `wrapup` here, so the release copy belonged in the
          wrap-up rail — and this panel only renders once there is no attempt on
          screen, which means that wrap-up is over or never began. The station
          clears `release` when a wrap-up genuinely ends (see its `agent_state`
          handler), so reaching this branch means it never did: the API took the
          early return that skips both the `agent_state{wrapup}` and `wrapup`
          frames, and without this the agent's screen goes from a live call
          straight to the resting "Waiting for a call" with no account of the
          call they were just on. That reads as data loss, which is the same
          failure the missed-release notice beside it exists to prevent.

          The server's own sentence, not the copy table's headline: on this path
          there is no wrap-up to name and no disposition left to pick, so the
          wrap-up-shaped copy would be two false statements. See
          `releaseAccount`.
        */
        <>
          <p className={styles.releaseHeadline} data-testid="unexplained-release">
            {releaseAccount(release)}
          </p>
          <p className={styles.releaseSubtext}>{headline}</p>
        </>
      ) : missedRelease ? (
        /*
          The call that ended while the agent's socket was away (`ready`'s
          `missed_release`). Rendered here, in the idle slot, and prefixed so it
          cannot be mistaken for something that just happened — the agent has been
          staring at a reconnect spinner and needs to know the call is over, not to
          be told a fresh one ended.

          **The API hands this over exactly once**: `takeMissedRelease` clears as it
          reads, so if the console does not put it on screen the record of the call
          the agent was on is gone for good, and an empty station after a drop
          reads as data loss.

          It keeps the slot while a hidden dial rings (it outranks the resting copy), so the
          dial is said in a line under it, as the unexplained release says it in its subtext:
          otherwise the rail would say "Dialling a customer…" and this panel nothing.
        */
        <>
          <p className={styles.releaseHeadline} data-testid="missed-release">
            While you were disconnected: {resolveReleaseCopy(missedRelease).headline}
          </p>
          <p className={styles.releaseSubtext}>{resolveReleaseCopy(missedRelease).subtext}</p>
          {diallingNow ? (
            <p className={styles.idleUnanswered} data-testid="missed-release-dialling">{DIALLING_HEADLINE}</p>
          ) : null}
        </>
      ) : (
        /*
          The resting copy. On a late-binding account a dial may be ringing for this agent that
          they are shown only if it is answered: then it says so, and how the last ones went,
          so a quiet screen does not read as a stuck one. Not a live region: the rail is the
          station's status region and already says "Dialling a customer…"; the count line
          changes with every unanswered dial and must not be read out each time.
        */
        <>
          <p className={styles.idleHeadline} data-testid="idle-headline">{headline}</p>
          {unanswered ? (
            <p className={styles.idleUnanswered} data-testid="idle-unanswered">{unanswered}</p>
          ) : null}
          <p className={styles.idleHint}>
            {diallingNow ? DIALLING_HINT : dialing ? IDLE_WAITING_HINT : IDLE_PAUSED_HINT}
          </p>
        </>
      )}
      {/*
        A disposition whose response outlived its attempt. One non-blocking line,
        here in the idle slot and only after the next call completes — never a
        toast, never the rail, and it must not steal focus: an alert about
        customer A while the agent is talking to customer B is worse than the loss
        it reports.
      */}
      {lostDisposition ? <p className={styles.lostDisposition}>{lostDisposition}</p> : null}
    </div>
  );
}
