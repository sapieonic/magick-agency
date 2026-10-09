import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Info, MessageSquare, PhoneOff, PhoneMissed, SearchX } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import { getAgencyCampaign } from '../../api/agencyCampaigns';
import {
  fetchAgencyAttemptRecordingBlobUrl,
  getAgencyAttemptCall,
  type AgencyAttemptCallDetail,
} from '../../api/agencySpine';
import { getErrorMessage } from '../../utils/errors';
import {
  AGENCY_ANALYTICS_CAPABILITY,
  AGENCY_RECORDING_CAPABILITY,
} from '../../utils/agencyCampaignRecording';
import { Breadcrumbs } from '../../components/common/Breadcrumbs';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorAlert } from '../../components/common/ErrorAlert';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { CampaignTabs } from '../../components/agency/CampaignTabs';
import {
  CallDetailView,
  FactCard,
  type CallFact,
  type CallFactCard,
} from '../../components/calls/CallDetailView';
import { ANALYSIS_STATUS_MESSAGES } from '../../utils/vocabulary';
import {
  agentCellCopy,
  dispositionLabel,
  formatSpineTimestamp,
  formatTalkTime,
} from '../../utils/agencySpineCopy';
import {
  attemptOutcomeLabel,
  attemptStateLabel,
  type AgencyAttempt,
} from '../../types/agency-spine';
import type { AgencyCampaign, AgencyDispositionEntry } from '../../types/agency-campaign';
import styles from './AgencyAttemptCallPage.module.css';

/**
 * ─── THE AGENCY'S OWN CALL DETAIL ───────────────────────────────────────────
 *
 * The page that did not exist. Clicking a call inside the agency workspace used
 * to navigate to `/app/calls/dialer/history/:id` — out of `AgencyLayout`, into the
 * primary application's shell, gated on the primary application's `calls.dialer`
 * capability, with the campaign context and the list the reader was reading both
 * gone. The link pointed there because that was the only place the endpoint
 * existed (`docs/reference/magickvoice-platform/docs/agency-dialer-design.md` §7b).
 *
 * It renders the shared `CallDetailView`, because the call shape genuinely is the
 * same — one `webrtc_calls` row either way. What is different is everything
 * around it: the endpoint, the capability, the breadcrumb trail back to the
 * campaign, the section bar, the wording — and the facts.
 *
 * ── The facts are the point, and the first version had none of them ────────
 *
 * This page fetched the attempt and used exactly one field off it
 * (`attempt_number`, for the breadcrumb leaf), then rendered the SOFTPHONE's
 * facts card: Provider, and an `Initiated By` that on an agency leg is the
 * dialing session id (core's `agency-dialer.ts` sets `initiatedBy:
 * cmd.sessionId`). So clicking a row in the attempts list landed the supervisor
 * on a page carrying LESS agency information than the row they clicked, plus a
 * raw UUID. Everything they came for — which agent worked it, how it was written
 * up, what the agent typed — was fetched and thrown away.
 *
 * `identityFacts` / `identityCards` are that fixed. The words and the formatters
 * are the attempts list's own (`agencySpineCopy`, `types/agency-spine`), because
 * two screens one click apart describing the same row must not describe it
 * differently — and the softphone's Provider and Initiated By are simply not
 * passed, rather than shown as a UUID.
 *
 * ── The purged call is a first-class state, not an error ───────────────────
 *
 * `agency_call_attempts.webrtc_call_id` is deliberately un-FK'd (core migration
 * 076) because both sides purge on independent retention windows, so an attempt
 * routinely outlives its call. Core answers 200 with `call_availability` rather
 * than 404 precisely so this page can say what happened, and rendering an error
 * here would throw that away — a red alert reads as "something is broken",
 * when the truthful answer is "this aged out, and here is the attempt record
 * that did not".
 *
 * Two absent states, deliberately distinguished. "We never dialled this number"
 * and "we dialled it and the recording has expired" are different answers to a
 * compliance question, and one shared empty state could give neither.
 *
 * ── The facts come off the ATTEMPT, so a missing call cannot take them ─────
 *
 * That empty state used to be the whole page when `call` was null: it promised
 * "the attempt record below is retained" and then rendered nothing below it. Yet
 * §7b's central claim about this surface is that an attempt routinely outlives
 * its call, so `call === null` is not an edge case — it is the steady state for
 * every row older than the call-side retention window, and those are exactly the
 * compliance rows this page was built for. The page fetched the attempt, held the
 * agent, disposition, notes and wrap-up in hand, and showed none of it on the one
 * state where the attempt record is all there is.
 *
 * `agencyIdentityFacts` and `agencyDispositionCard` are pure functions of the
 * ATTEMPT — neither has ever read the call — so both paths feed the same two
 * functions to the same renderer (`FactCard`, exported from the shared view for
 * this). What a missing call now costs the reader is the recording, the
 * transcript and the call row's own timing, and the empty state says so; it no
 * longer costs them the agency's record of the dial.
 *
 * ── Every state renders the trail and the section bar ──────────────────────
 *
 * Loading and error included, which is where the first version dropped both.
 * Master forwards core's `attempt_not_found` verbatim (allow-listed through the
 * error mask on purpose), so following a link to a deleted or renumbered attempt
 * showed the honest sentence — and a single "Retry loading" button that returns
 * the same 404 forever, with the way back computed twelve lines above and never
 * rendered.
 */

/**
 * Speaker labels. Two humans, like the softphone — and unlike the AI call's
 * assistant/user, which is why this is passed rather than defaulted.
 */
const AGENCY_ROLE_LABELS = { agent: 'Agent', customer: 'Customer' };

/**
 * Summary-card copy. The reader here is a supervisor reviewing someone else's
 * conversation, so the wording is the same plain register the softphone uses —
 * shared by reuse of the vocabulary module, not by defaulting.
 */
const AGENCY_ANALYSIS_MESSAGES: Record<string, string> = {
  awaiting_recording: ANALYSIS_STATUS_MESSAGES.awaiting_recording!,
  pending: ANALYSIS_STATUS_MESSAGES.pending!,
  failed: ANALYSIS_STATUS_MESSAGES.failed!,
  expired: ANALYSIS_STATUS_MESSAGES.expired!,
  deleted: ANALYSIS_STATUS_MESSAGES.deleted!,
};

/**
 * Whether an error is one that retrying cannot fix.
 *
 * `attempt_not_found` is master forwarding core's answer for an attempt that is
 * not on this campaign, or an id that is not a UUID — a stale or hand-edited
 * link. A 403 is the `agency.supervise` floor refusing the read, which no number
 * of presses changes either (`RequireCapability` fails open by design, so a
 * reader below the floor does genuinely arrive here). Offering Retry on either
 * offers the same failure again.
 */
function isTerminalLoadError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const shaped = err as { statusCode?: unknown; details?: { code?: unknown } };
  if (shaped.statusCode === 403) return true;
  return shaped.details?.code === 'attempt_not_found';
}

/**
 * The supervisor's facts, in the attempts list's own words.
 *
 * Order is the reading order of the question this page answers: who worked it,
 * what happened, and where it got to. `Agent` is first because it is the field
 * the whole surface exists for, and `agentCellCopy` is reused rather than
 * re-derived — `agent_user_id: null` is ordinary on an abandoned or unanswered
 * attempt and must read as "no agent was free", never as a gap.
 *
 * Deliberately NOT here: the call row's `provider` and `initiated_by` (a session
 * UUID on this product), and the call row's `outcome`, which is the media leg's
 * (`browser_hangup`) rather than the attempt's (`Connected`) — the word the list
 * uses. Talk time is left to the shared Timeline card, which already carries the
 * billed figure; adding `talk_seconds` beside it would be two numbers under two
 * similar labels.
 */
function agencyIdentityFacts(attempt: AgencyAttempt): CallFact[] {
  const agent = agentCellCopy(attempt);
  return [
    { label: 'Agent', value: agent.text, muted: agent.muted },
    {
      label: 'Outcome',
      value: attemptOutcomeLabel(attempt.outcome),
      muted: attempt.outcome === null,
      hint: 'What happened to this dial — the same classification the attempts list shows.',
    },
    { label: 'Where it got to', value: attemptStateLabel(attempt.state) },
  ];
}

/**
 * The write-up, as its own card.
 *
 * Titled `Disposition` because that is the column heading on the attempts list
 * this page is opened from. (The agent's own history panel says "Write-up" for
 * the same field; that surface has a different reader and its own settled
 * vocabulary, and this one has to match the screen a click away.)
 *
 * `notes` earns prose treatment rather than a grid cell: `types/agency-spine.ts`
 * calls it *"frequently the answer to why was this number called four times"*,
 * which makes it the most valuable field on the page and the one a two-column
 * cell would wrap to five words a line. Rendered as TEXT, never as markup.
 */
function agencyDispositionCard(
  attempt: AgencyAttempt,
  catalog: readonly AgencyDispositionEntry[] | undefined,
): CallFactCard {
  /*
    The operator's name for the disposition, with the raw code kept on hover.

    This is the deepest a supervisor can go on one call, and it was the place the
    code was least excusable: the field was labelled "Code" and printed `ptp`, so
    the one screen that exists to explain a single call explained the least. The
    label follows the value — a resolved name earns "Written up as", and "Code"
    stays when `dispositionLabel` could only hand the code back — so the heading
    never promises more than the value delivers.

    Two nearer words were both taken on this very screen, which is why it is this
    one. **"Outcome"** is what campaign Settings calls the concept ("Outcomes
    agents can pick"), but the Call Information card above already spends it on
    the TELEPHONY outcome — Connected, Busy, No answer — and two facts named
    "Outcome" on one screen is worse than any jargon. **"Disposition"** is this
    card's own title, so a fact inside it by that name just repeats the heading.
    "Written up as" also answers to the absent value already in use here, "Not
    written up".
  */
  const label = dispositionLabel(attempt.disposition_code, catalog);
  const resolved = label !== null && label !== attempt.disposition_code;
  const facts: CallFact[] = [
    {
      label: resolved ? 'Written up as' : 'Code',
      value: label ?? 'Not written up',
      muted: attempt.disposition_code === null,
      ...(resolved ? { hint: `Filed as “${attempt.disposition_code}”` } : {}),
    },
    {
      label: 'Filed',
      value: attempt.dispositioned_at
        ? formatSpineTimestamp(attempt.dispositioned_at)
          + (attempt.dispositioned_on_behalf ? ' · on behalf' : '')
        : null,
      ...(attempt.dispositioned_on_behalf
        ? { hint: 'Filed by someone other than the agent on the call' }
        : {}),
    },
  ];

  // Only when one was actually asked for: an absent callback is the ordinary case
  // and a permanent "--" row for it is noise on every other attempt.
  if (attempt.callback_at !== null) {
    facts.push({ label: 'Call back', value: formatSpineTimestamp(attempt.callback_at) });
  }

  facts.push({
    label: 'Wrap-up',
    value: formatTalkTime(attempt.wrapup_seconds),
    mono: true,
    hint: 'How long the agent spent on after-call work before taking the next dial.',
  });

  facts.push({
    label: 'Notes',
    value: attempt.notes ?? 'None',
    muted: attempt.notes === null,
    prose: true,
  });

  return { title: 'Disposition', facts };
}

/**
 * The dial itself, for the page where there is no call row to read it off.
 *
 * Number, when and talk time are deliberately absent from `agencyIdentityFacts`
 * because on the ordinary path the call row already carries all three — the
 * destination in the header, `created_at` and the billed talk time in the shared
 * Timeline card — and repeating them would be two numbers under two similar
 * labels. When the call has been purged or was never placed the attempt row is
 * the only place they survive, and they are the first things asked of a
 * compliance row: which number, when, and did anyone talk.
 *
 * The labels and the columns are the attempts list's, not new ones. `When` is
 * `created_at` and `Talk time` is `talk_seconds` there too, so the reader who
 * clicked a row sees the same two values they were just looking at rather than
 * a second, nearly-identical timestamp to reconcile. Titled `Attempt record`
 * because that is the phrase the empty state above it uses.
 */
function agencyAttemptRecordCard(attempt: AgencyAttempt): CallFactCard {
  const facts: CallFact[] = [
    { label: 'Number', value: attempt.phone_e164, mono: true },
    { label: 'When', value: formatSpineTimestamp(attempt.created_at) },
  ];

  // Only when there was a conversation to time. On an attempt that never reached
  // an agent this is null, and a permanent dash under "Talk time" says nothing
  // the Outcome and state below it do not already say plainly.
  if (attempt.talk_seconds !== null) {
    facts.push({ label: 'Talk time', value: formatTalkTime(attempt.talk_seconds), mono: true });
  }

  facts.push(...agencyIdentityFacts(attempt));
  return { title: 'Attempt record', facts };
}

export default function AgencyAttemptCallPage() {
  const { id: campaignId, attemptId } = useParams<{ id: string; attemptId: string }>();
  const { tenantId, accountId, role } = useTenant();
  const { isEnabled } = useGovernance();

  const [detail, setDetail] = useState<AgencyAttemptCallDetail | null>(null);
  const [campaign, setCampaign] = useState<AgencyCampaign | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Whether pressing Retry could possibly change the answer — see `isTerminalLoadError`. */
  const [terminal, setTerminal] = useState(false);

  const load = useCallback(async () => {
    if (!campaignId || !attemptId) return;
    setLoading(true);
    setError(null);
    setTerminal(false);
    try {
      const next = await getAgencyAttemptCall(
        campaignId, attemptId, tenantId ?? undefined, accountId ?? undefined,
      );
      setDetail(next);
    } catch (err) {
      setError(getErrorMessage(err));
      setTerminal(isTerminalLoadError(err));
    } finally {
      setLoading(false);
    }
  }, [campaignId, attemptId, tenantId, accountId]);

  useEffect(() => { void load(); }, [load]);

  /*
   * The campaign name, for the breadcrumb only. Best-effort on purpose: this page
   * is about the call, and a failed campaign fetch must not cost the reader the
   * call they came to see. The crumb falls back to a placeholder.
   */
  useEffect(() => {
    if (!campaignId) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await getAgencyCampaign(
          campaignId, tenantId ?? undefined, accountId ?? undefined,
        );
        if (!cancelled) setCampaign(next);
      } catch {
        // Breadcrumb decoration only — see above.
      }
    })();
    return () => { cancelled = true; };
  }, [campaignId, tenantId, accountId]);

  const fetchRecording = useCallback(
    async (tenant: string, account: string | undefined) => (
      campaignId && attemptId
        ? fetchAgencyAttemptRecordingBlobUrl(campaignId, attemptId, tenant, account)
        : null
    ),
    [campaignId, attemptId],
  );

  /**
   * The trail back to where the reader came from — which is the whole point of the
   * page existing. `Call attempts` is the list they clicked out of.
   *
   * The campaign crumb is always PRESENT and only its label arrives late. The name
   * comes from its own request, so inserting a third crumb once it landed reflowed
   * the header on every load; a placeholder holds the slot instead.
   *
   * Every href is inside `/agency`. A `/app` link here would be the original bug.
   */
  const breadcrumbs = [
    { label: 'Campaigns', href: '/agency/campaigns' },
    { label: campaign?.name ?? 'Campaign', href: `/agency/campaigns/${campaignId}` },
    { label: 'Call attempts', href: `/agency/campaigns/${campaignId}/attempts` },
  ];

  /*
   * The campaign workspace's section bar, in the same slot as on every sibling
   * screen. It is rendered per PAGE rather than by the layout — the four
   * standalone campaign screens each mount it themselves — so a page that does
   * not render it simply has none, which is what happened here: the reader
   * following a row out of Call attempts lost the Overview / Performance /
   * Agents / Contacts / Call attempts / Activity / Settings bar that every other
   * campaign screen has.
   *
   * `active="attempts"` is stated rather than derived. `CampaignTabs` takes the
   * active section from its caller precisely because only the caller knows, and
   * `campaignPanelFromPath` answers a different question — which PANEL of the
   * detail page a path wants — so it can only ever return `overview`,
   * `performance` or `agents`, never `attempts`.
   */
  const tabs = campaignId
    ? (
      <CampaignTabs
        campaignId={campaignId}
        active="attempts"
        role={role}
        campaignStatus={campaign?.status}
      />
    )
    : null;

  const identityFacts = useMemo(
    () => (detail ? agencyIdentityFacts(detail.attempt) : []),
    [detail],
  );
  /*
    The CATALOG is a dependency, and leaving it out defeated the whole point of
    passing it.

    The attempt and the campaign are two independent requests. Whichever settles
    first wins the first render, and the attempt usually does — so with `[detail]`
    alone this memoised the raw-code fallback (`ptp`) and never recomputed when
    the catalog arrived a moment later. The operator's own label would have
    appeared only on the ordering that happens to be the rarer one.
  */
  const identityCards = useMemo(
    () => (detail ? [agencyDispositionCard(detail.attempt, campaign?.disposition_catalog)] : []),
    [detail, campaign?.disposition_catalog],
  );

  /*
   * Neither state below carries the attempt facts, and that is a limit rather
   * than an omission: one request serves the attempt and its call together, so
   * before it settles there is no attempt to render, and when it fails there is
   * none either — including the 403, where master refused the read and sent no
   * row. The facts appear the moment there is an attempt, call or no call.
   *
   * There is no third case where a record is on screen and a later fetch fails.
   * `load` runs on mount and on a param change; the only caller that could re-run
   * it from a rendered page is the view's `onReload`, which fires solely after an
   * analysis retry — and this page withholds that affordance entirely.
   */
  if (loading) {
    return (
      <div>
        {/* The trail and the bar render through every state: a reader who cannot
            see the page they asked for still needs the way back to the one they
            came from. The leaf is a placeholder because the attempt number is on
            the response that has not arrived. */}
        <Breadcrumbs items={[...breadcrumbs, { label: 'Attempt' }]} />
        {tabs}
        <LoadingSpinner />
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <Breadcrumbs items={[...breadcrumbs, { label: 'Attempt' }]} />
        {tabs}
        {terminal ? (
          /*
            No Retry. The link is stale, or the floor refuses the read, and both
            answer the same way every time; the trail above is the actual remedy,
            which is why rendering it here is the fix rather than a nicety.
          */
          <EmptyState
            icon={<SearchX size={28} />}
            title="We can’t show this call"
            description={`${error} Use the trail above to go back to the campaign’s call `
              + 'attempts — the row you followed may have been renumbered or removed.'}
          />
        ) : (
          <ErrorAlert message={error} onRetry={() => void load()} />
        )}
      </div>
    );
  }

  if (!detail) return null;

  const { attempt, call, call_availability: availability } = detail;
  const attemptLeaf = `Attempt ${attempt.attempt_number}`;

  /*
   * The call is gone (or was never placed). Say which — as an empty state rather
   * than an error, see the header — and then render the attempt's own record,
   * which is the row that is still here.
   *
   * The empty state is now a statement about the RECORDING AND TRANSCRIPT only,
   * because that is all a missing call row costs the reader. It used to be the
   * whole page, and its own copy promised a record below it that did not exist.
   */
  if (!call) {
    const purged = availability === 'purged';
    return (
      <div>
        <Breadcrumbs items={[...breadcrumbs, { label: attemptLeaf }]} />
        {tabs}
        <EmptyState
          icon={purged ? <PhoneOff size={28} /> : <PhoneMissed size={28} />}
          title={purged ? 'This call is no longer available' : 'No call was placed'}
          description={
            purged
              ? `The recording and transcript for this call have passed their `
                + `retention window and been deleted. The attempt record below is `
                + `retained on the agency’s own, longer window.`
              : `This attempt ended before a call was placed — it did not clear a `
                + `pre-dial check, or was abandoned before an agent was bridged. `
                + `There is no recording or transcript because there was never a `
                + `call. The attempt record below is all there is.`
          }
        />
        {/* The same two functions the ordinary path passes to the shared view,
            rendered through the same card. Both read the attempt and nothing
            else, which is why a purged call cannot take them off the page. */}
        <div className={styles.attemptRecord}>
          <FactCard
            card={agencyAttemptRecordCard(attempt)}
            icon={<Info size={16} />}
          />
          {identityCards.map((card) => (
            <FactCard key={card.title} card={card} icon={<MessageSquare size={16} />} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      {tabs}
      <CallDetailView
        call={call}
        breadcrumbs={breadcrumbs}
        leafLabel={attemptLeaf}
        // The ATTEMPT's outcome, not the call row's. `webrtc_calls.outcome` on an
        // agency leg is the media leg's (`browser_hangup`); the attempt's is the
        // word the list uses.
        subtitle={attemptOutcomeLabel(attempt.outcome)}
        // The names for this product's two legs. WHETHER to use them is the
        // view's decision, not this page's — it drops them itself on a failed
        // diarization, for the softphone as well as here.
        roleLabels={AGENCY_ROLE_LABELS}
        identityFacts={identityFacts}
        identityCards={identityCards}
        // The agency's OWN analytics entitlement, not the softphone's. Master
        // withholds the transcript and summary fields for the same capability, so
        // this hides a section that would otherwise render empty.
        analysisEnabled={isEnabled(AGENCY_ANALYTICS_CAPABILITY)}
        analysisTitle="Call summary"
        analysisMessages={AGENCY_ANALYSIS_MESSAGES}
        retryLabel="Try again"
        // The agency's own recording entitlement. Master nulls `recording_url`
        // when it is off, which from inside the view is indistinguishable from a
        // recording still finalising — so without this the page promised "check
        // back soon" for one that is never coming.
        recordingEnabled={isEnabled(AGENCY_RECORDING_CAPABILITY)}
        fetchRecording={fetchRecording}
        // No retry affordance, and passing `undefined` is what withholds it:
        // re-running a summary is a primary-app action on the `calls` table and
        // there is no agency equivalent to call. The shared view ANDs its
        // `canRetry` with the presence of this handler for exactly that reason —
        // omitting the prop used to leave a primary "Try again" wired to
        // `POST /proxy/calls/:id/retry-analysis`, the wrong table, which failed
        // every time it was pressed.
        onRetryAnalysis={undefined}
        onReload={() => void load()}
      />
    </div>
  );
}
