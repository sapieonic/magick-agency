import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Info, MessageSquare, Phone, PhoneIncoming, PhoneOff, SearchX } from 'lucide-react';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { useTenant } from '../../contexts/TenantContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import { useCampaignCrumbs } from '../../hooks/useCampaignCrumbs';
import { SOFTPHONE_FLAG, useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { getAgencyCampaign } from '../../api/agencyCampaigns';
import { fetchInboundCallRecordingBlobUrl, getInboundCallLogDetail } from '../../api/agencySpine';
import { errorCode, errorStatus } from '../../utils/agencyErrors';
import { hasPermission } from '../../utils/permissions';
import { AGENCY_ANALYTICS_CAPABILITY, AGENCY_RECORDING_CAPABILITY } from '../../utils/agencyCampaignRecording';
import { ANALYSIS_STATUS_MESSAGES } from '../../utils/vocabulary';
import { softphonePrefillState } from '../../utils/softphone/prefill';
import { campaignCallLogPath } from '../../utils/agency/callLog';
import {
  inboundCallCards,
  inboundCallHeadline,
  inboundCallerTitle,
  inboundIdentityFacts,
  inboundJourneyLines,
  inboundRecordCard,
} from '../../utils/agency/inboundCallPage';
import { CampaignTabs } from '../../components/agency/CampaignTabs';
import { CallDetailView, FactCard } from '../../components/calls/CallDetailView';
import { ListenedToBy } from '../../components/listen/ListenedToBy';
import { VoicemailPlayer } from '../../components/agency/inbound/VoicemailPlayer';
import type { AgencyInboundCallLogDetail } from '../../types/agency-call-log';
import type { AgencyCampaign } from '../../types/agency-campaign';
import attemptStyles from './AgencyAttemptCallPage.module.css';
import styles from './AgencyInboundCallPage.module.css';

const ROLE_LABELS = { agent: 'Agent', customer: 'Customer' };
const ANALYSIS_MESSAGES: Record<string, string> = {
  awaiting_recording: ANALYSIS_STATUS_MESSAGES.awaiting_recording!,
  pending: ANALYSIS_STATUS_MESSAGES.pending!,
  failed: ANALYSIS_STATUS_MESSAGES.failed!,
  expired: ANALYSIS_STATUS_MESSAGES.expired!,
  deleted: ANALYSIS_STATUS_MESSAGES.deleted!,
};

/**
 * `/agency/campaigns/:id/calls/inbound/:callId`: one inbound call of a campaign, for a
 * supervisor (`docs/call-log.md` §4). The Call log's rows open it; inbound calls had no page
 * before it.
 *
 * The same header every call's page has (who, when, what happened, the outcome, the notes, the
 * recording and the summary, through `CallDetailView`), and above it the part only an inbound
 * call has: the caller's path, a line per step ("Rang 3:42:01 PM → Greeting → Waited 0:18 →
 * Priya Nair answered → Ended"), and a voicemail when one was left.
 *
 * The recording, transcript and summary are the route's to give: it is `agency.supervise`, as
 * the Call log is, and strips them by the account's own recording and analysis settings. With no
 * media leg the page shows the record alone and says why from `call_availability`.
 */
export default function AgencyInboundCallPage() {
  const { id: campaignId, callId } = useParams<{ id: string; callId: string }>();
  const { tenantId, accountId, role } = useTenant();
  const { isEnabled } = useGovernance();
  const navigate = useNavigate();
  const softphoneOn = useFeatureFlagEnabled(SOFTPHONE_FLAG);

  const [detail, setDetail] = useState<AgencyInboundCallLogDetail | null>(null);
  const [campaign, setCampaign] = useState<AgencyCampaign | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [terminal, setTerminal] = useState(false);

  const load = useCallback(async () => {
    if (!campaignId || !callId) return;
    setLoading(true);
    setError(null);
    setTerminal(false);
    try {
      setDetail(await getInboundCallLogDetail(campaignId, callId, tenantId ?? undefined, accountId ?? undefined));
    } catch (err) {
      setDetail(null);
      setError(getErrorMessage(err, 'We couldn’t load this call.'));
      setTerminal(errorStatus(err) === 403 || errorStatus(err) === 404 || errorCode(err) === 'inbound_call_not_found');
    } finally {
      setLoading(false);
    }
  }, [campaignId, callId, tenantId, accountId]);

  useEffect(() => { void load(); }, [load]);

  // The campaign, for its name in the trail and its outcome labels. A courtesy: the page reads without it.
  useEffect(() => {
    if (!campaignId) return;
    let live = true;
    getAgencyCampaign(campaignId, tenantId ?? undefined, accountId ?? undefined)
      .then((next) => { if (live) setCampaign(next); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [campaignId, tenantId, accountId]);

  const fetchRecording = useCallback(
    async (tenant: string, account: string | undefined) => (
      campaignId && callId ? fetchInboundCallRecordingBlobUrl(campaignId, callId, tenant, account) : null
    ),
    [campaignId, callId],
  );

  // "Campaigns / <name> / Call log / Call", in the top bar: Call log is the list the reader came from.
  useCampaignCrumbs(campaignId, campaign, 'attempts', [{ label: 'Call' }]);

  const current = detail && detail.inbound.id === callId ? detail : null;
  const cards = useMemo(
    () => (current ? inboundCallCards(current, campaign?.disposition_catalog) : []),
    [current, campaign?.disposition_catalog],
  );
  const journey = useMemo(() => (current ? inboundJourneyLines(current) : []), [current]);

  const tabs = campaignId
    ? <CampaignTabs campaignId={campaignId} active="attempts" role={role} campaignStatus={campaign?.status} />
    : null;

  if (loading) {
    return (
      <div>
        {tabs}
        <LoadingSpinner />
      </div>
    );
  }

  if (error || !current) {
    return (
      <div>
        {tabs}
        {terminal || !error ? (
          <EmptyState
            icon={<SearchX size={28} />}
            title="We can’t show this call"
            description={error ?? 'This call is not in this campaign’s call log.'}
            action={campaignId ? (
              <Link to={campaignCallLogPath(campaignId, 'inbound')} className="btn-secondary">Back to the call log</Link>
            ) : undefined}
          />
        ) : (
          <ErrorAlert message={error} onRetry={() => void load()} />
        )}
      </div>
    );
  }

  const { inbound, call, call_availability: availability } = current;
  const canCallBack = softphoneOn && hasPermission(role, 'agency.softphone.dial') && inbound.phone_e164 !== null;
  const callBack = () => {
    if (!inbound.phone_e164) return;
    navigate('/dialer/phone', {
      state: softphonePrefillState({
        number: inbound.phone_e164,
        campaignId: inbound.campaign_id,
        // Only a missed call has a call back to be linked to it.
        inboundCallId: inbound.follow_up ? inbound.id : null,
      }),
    });
  };

  const top = (
    <>
      <header className={styles.header}>
        <div>
          <h2 className={styles.title} data-testid="inbound-call-caller">
            <PhoneIncoming size={18} aria-hidden="true" />
            {inboundCallerTitle(inbound)}
          </h2>
          <p className={styles.headline} data-testid="inbound-call-headline">{inboundCallHeadline(inbound)}</p>
        </div>
        <div className={styles.actions}>
          {inbound.contact_id && campaignId && (
            <Link to={`/agency/campaigns/${campaignId}/contacts/${inbound.contact_id}`} className="btn-secondary">
              Open contact
            </Link>
          )}
          {canCallBack && (
            <button type="button" className="btn-secondary" onClick={callBack} data-testid="inbound-call-back">
              <Phone size={14} aria-hidden="true" />
              Call back
            </button>
          )}
        </div>
      </header>

      <section className={styles.journey} aria-label="The caller’s path">
        <ol className={styles.steps} data-testid="inbound-call-journey">
          {journey.map((line, index) => (
            <li key={`${line.kind}-${index}`} className={styles.step} data-step={line.kind}>
              <span className={styles.stepTitle}>{line.title}</span>
              {line.detail && <span className={styles.stepDetail}>{line.detail}</span>}
            </li>
          ))}
        </ol>
        {current.voicemail_url && (
          <VoicemailPlayer voicemailUrl={current.voicemail_url} callerLabel={inboundCallerTitle(inbound)} />
        )}
      </section>
    </>
  );

  if (!call) {
    const purged = availability === 'purged';
    return (
      <div>
        {tabs}
        {top}
        <EmptyState
          icon={<PhoneOff size={28} />}
          title={purged ? 'This call’s recording and transcript are no longer available' : 'There is no recording of this call'}
          description={
            purged
              ? 'They passed their retention window and were deleted. The call record below is kept.'
              : 'Nothing was recorded for this call, so there is no recording or transcript. The call record below is all there is.'
          }
        />
        <div className={attemptStyles.attemptRecord}>
          <FactCard card={inboundRecordCard(inbound)} icon={<Info size={16} />} />
          {cards.map((card) => (
            <FactCard key={card.title} card={card} icon={<MessageSquare size={16} />} />
          ))}
          <ListenedToBy sessions={current.listen_sessions} />
        </div>
      </div>
    );
  }

  return (
    <div>
      {tabs}
      {top}
      <CallDetailView
        call={call}
        subtitle={inboundCallHeadline(inbound)}
        roleLabels={ROLE_LABELS}
        identityFacts={inboundIdentityFacts(inbound)}
        identityCards={cards}
        analysisEnabled={isEnabled(AGENCY_ANALYTICS_CAPABILITY)}
        analysisTitle="Call summary"
        analysisMessages={ANALYSIS_MESSAGES}
        retryLabel="Try again"
        recordingEnabled={isEnabled(AGENCY_RECORDING_CAPABILITY)}
        fetchRecording={fetchRecording}
        onRetryAnalysis={undefined}
        onReload={() => void load()}
      />
      <ListenedToBy sessions={current.listen_sessions} />
    </div>
  );
}
