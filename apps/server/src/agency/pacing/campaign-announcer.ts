/**
 * What the agents on a campaign are told about whether it is dialing: the
 * `campaign_state` broadcasts, and the two latches (`flagGated`, `reportedStuck`)
 * that make each suppression report once and recovery report only when nothing
 * else still blocks. Split out of `pacing-engine.ts`, which owns when these are
 * called; its log lines keep the engine's component name.
 */
import { createChildLogger } from '@magick-agency/observability';
import type { AgencyCampaignChangeReason } from '@magick-agency/contracts/agency';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import type { StationRegistry } from '../station-registry.js';
import { campaignMessageFor, isDialingStatus } from '../outcome-classifier.js';

const log = createChildLogger({ component: 'agency-pacing-engine' });

export class CampaignAnnouncer {
  constructor(private readonly stations: Pick<StationRegistry, 'broadcast'>) {}

  /**
   * Whether the flag has already been reported as off for a campaign.
   *
   * The supervise pass runs every 2s, so an unguarded line would emit ~43k times a
   * day for one switched-off campaign. Cleared when the campaign comes back, so
   * switching a tenant off, on and off again is reported both times.
   */
  readonly flagGated = new Set<string>();

  /**
   * **The one answer to "would this campaign place a call right now?"**
   *
   * Returns the blocking reason, or `null` when nothing is in the way.
   *
   * ── Why this is derived in one place instead of cross-checked in several ────
   *
   * There are two independent suppressions — `flagGated` and `reportedStuck` — and
   * each used to announce its own recovery without consulting the other. Two bugs
   * fell straight out of that, and they are the same bug:
   *
   *   * the dialer flag returning fired `resumed`/`dialing: true` on a campaign
   *     still halted for unusable caller IDs, and the next tick's
   *     `noteMisconfigured` was a no-op because that latch was still set — so the
   *     console kept `dialing: true` forever while nothing was dialed;
   *   * `clearStuck` runs on any tick the empty-pool guard did not return early
   *     from, and that guard is gated on `status === 'running'` — so a campaign
   *     that moved to `stopping` (still led, still ticked at 4 Hz while it drains)
   *     or was briefly ticked while `paused` cleared the latch and broadcast
   *     `resumed`/`dialing: true` on a campaign that will never dial again.
   *
   * Adding a cross-check to each site fixes today's pair and drifts apart the day a
   * third suppression appears — which is how the second one got here. So the
   * predicate is derived from the whole state, every announcement is clamped
   * against it below, and a new latch is one line HERE rather than N new
   * cross-checks. The status is part of it deliberately: `dialing` must never be
   * true for a status that cannot dial, whoever asked for it.
   */
  notDialingBecause(campaign: AgencyCampaignRecord): string | null {
    if (!isDialingStatus(campaign.status)) return `the campaign is ${campaign.status}`;
    if (this.flagGated.has(campaign.id)) return 'the dialer is disabled for this account';
    if (this.reportedStuck.has(campaign.id)) return 'the campaign still cannot dial';
    return null;
  }

  /**
   * Broadcast a campaign-state change to every agent working it.
   *
   * `dialing` is normally derived from the status, but a campaign can be `running`
   * and **not** dialing — a misconfiguration halt, or the tenant's dialer flag
   * switched off. `isDialingStatus` would answer `true` for both, which is the
   * console lie this override exists to prevent: `dialing` is documented as "the
   * single boolean the console should drive its idle state from".
   *
   * **`dialing: true` is a CLAIM, and it is checked here rather than trusted.** Both
   * the explicit override and the status-derived default are clamped against
   * `notDialingBecause`, so no call site — including one written later, by someone
   * who does not know about a latch — can announce that a campaign is dialing when
   * the engine will not dial it. A caller that asked for `false` is never
   * second-guessed: suppression is only ever tightened.
   */
  announceCampaignState(
    campaign: AgencyCampaignRecord,
    reason: AgencyCampaignChangeReason,
    opts: { dialing?: boolean } = {},
  ): void {
    const claimed = opts.dialing ?? isDialingStatus(campaign.status);
    const blockedBy = claimed ? this.notDialingBecause(campaign) : null;
    if (blockedBy) {
      // Warn, not debug: a clamped frame means a call site and the engine disagreed
      // about whether calls are going out, and that disagreement is the entire class
      // of defect here. Silently correcting it would hide the next one.
      log.warn(
        { campaignId: campaign.id, status: campaign.status, reason, blockedBy },
        'Refused to announce dialing:true — the campaign would not dial',
      );
    }
    const sent = this.stations.broadcast(campaign.id, {
      event: 'campaign_state',
      campaign_id: campaign.id,
      status: campaign.status,
      reason,
      dialing: claimed && !blockedBy,
      message: campaignMessageFor(reason),
    });
    log.info({ campaignId: campaign.id, status: campaign.status, reason, agents: sent }, 'Announced agency campaign state');
  }

  /**
   * Campaigns already reported as unable to dial, so the report happens once.
   *
   * The tick runs at 4 Hz and the supervise pass at 0.5 Hz, so every "this campaign
   * cannot dial" line needs a latch or it becomes hundreds of thousands of
   * identical lines a day — the same reason the flag gate has one. Cleared when the
   * campaign can dial again, so a fixed-then-rebroken campaign reports twice.
   */
  readonly reportedStuck = new Set<string>();

  /**
   * Report a `running` campaign that structurally cannot dial — once per episode,
   * to the log AND to every agent watching it.
   *
   * The agents are the point. A supervisor at least has the campaign row and the
   * `agency_tick_idle_total` series; an agent has a console showing a Running badge
   * and `dialing: true`, waiting for a call that is never coming. Without the frame
   * this is the same "healthy-looking campaign that dials nothing" shape the rest of
   * this work exists to eliminate, with a server-side log as its only symptom.
   */
  noteMisconfigured(campaign: AgencyCampaignRecord, what: string): void {
    if (this.reportedStuck.has(campaign.id)) return;
    this.reportedStuck.add(campaign.id);
    log.error(
      { campaignId: campaign.id, tenantId: campaign.tenant_id, accountId: campaign.account_id },
      `Agency campaign ${what}`,
    );
    // `auto_paused` is the closest existing reason and its copy ("paused
    // automatically") is honest here: the engine has stopped producing calls
    // without a supervisor asking. A dedicated reason would need a matching arm in
    // every console's switch, and `message` already carries the fallback copy.
    this.announceCampaignState(campaign, 'auto_paused', { dialing: false });
  }

  /**
   * The campaign can dial again — let the next failure report itself.
   *
   * **Reached on a `stopping` or briefly-`paused` tick too**, because the empty-pool
   * guard above it returns early only while `status === 'running'`. Clearing the
   * latch there is deliberate and is the safe direction: the alternative — keeping
   * it — means a campaign that resumes still broken finds `noteMisconfigured`
   * latched, emits no halt frame and no error log, and the console is left with
   * whatever the status change said. Clearing it costs one re-report on the next
   * `running` tick if the pool is still empty, which is exactly the
   * "fixed-then-rebroken reports twice" behaviour this latch documents.
   *
   * What must NOT happen there is the resume frame, since nothing verified the pool
   * and the campaign is draining or paused anyway. That is `announceDialingResumed`'s
   * job now, not this call site's — see `notDialingBecause`.
   */
  clearStuck(campaign: AgencyCampaignRecord): void {
    if (!this.reportedStuck.delete(campaign.id)) return;
    // ── The recovery frame, which did not exist ───────────────────────────────
    // We told every joined agent `dialing: false`, and `campaign_state` is the ONLY
    // frame carrying `dialing`, so nothing else can ever undo that. The
    // status-change detector in `tickOnce` cannot either: the status never left
    // `running`, so there is no change for it to notice. Without this the console
    // reads auto-paused indefinitely while calls are routed to it.
    this.announceDialingResumed(campaign, 'caller IDs restored');
  }

  /**
   * Tell agents dialing has restarted after we told them it stopped.
   *
   * Fires only when a suppression was actually announced, so an ordinary tick never
   * broadcasts. `dialing` is passed explicitly rather than left to
   * `isDialingStatus`: the whole class of bug here is a `dialing` boolean derived
   * from a status that did not change.
   *
   * ── One suppression clearing is not recovery ────────────────────────────────
   *
   * Both callers clear THEIR OWN latch and then ask for this frame, which is right —
   * the condition they own really is over. What is not right is announcing recovery
   * on that basis alone: the caller-ID halt and the dialer flag are independent, so
   * the last one to clear is the one that means anything, and the campaign may also
   * have left `running` in the meantime. Asking `notDialingBecause` makes the frame
   * fire on the transition to actually-dialing rather than on any transition
   * towards it — and the order the suppressions clear in stops mattering, because
   * whichever clears last finds nothing else blocking and announces.
   *
   * Suppressed rather than downgraded to `dialing: false`: a `resumed` frame that
   * says "not dialing" carries contradictory copy, and the frame the console still
   * needs — the honest halt — was already sent by whichever suppression is still in
   * force. There is nothing to correct, so there is nothing to say.
   */
  announceDialingResumed(campaign: AgencyCampaignRecord, why: string): void {
    const blockedBy = this.notDialingBecause(campaign);
    if (blockedBy) {
      log.info(
        { campaignId: campaign.id, tenantId: campaign.tenant_id, accountId: campaign.account_id, blockedBy },
        `Agency campaign recovered one condition (${why}) but still will not dial — no resume frame sent`,
      );
      return;
    }
    log.info(
      { campaignId: campaign.id, tenantId: campaign.tenant_id, accountId: campaign.account_id },
      `Agency campaign can dial again (${why}) — telling agents`,
    );
    this.announceCampaignState(campaign, 'resumed', { dialing: true });
  }
}
