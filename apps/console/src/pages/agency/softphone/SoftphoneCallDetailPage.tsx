import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Info, MessageSquare, PhoneMissed, PhoneOff, SearchX } from 'lucide-react';
import { Breadcrumbs } from '@magick-agency/web-ui/components/Breadcrumbs';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { useTenant } from '../../../contexts/TenantContext';
import { useGovernance } from '../../../contexts/GovernanceContext';
import { fetchManualCallRecordingBlobUrl, getManualCall, getSoftphoneBootstrap } from '../../../api/softphone';
import { errorCode, errorStatus } from '../../../utils/agencyErrors';
import { AGENCY_ANALYTICS_CAPABILITY, AGENCY_RECORDING_CAPABILITY } from '../../../utils/agencyCampaignRecording';
import { CallDetailView, FactCard, type CallFact, type CallFactCard } from '../../../components/calls/CallDetailView';
import { ANALYSIS_STATUS_MESSAGES } from '../../../utils/vocabulary';
import { formatSpineTimestamp, formatTalkTime } from '../../../utils/agencySpineCopy';
import { attemptOutcomeLabel } from '../../../types/agency-spine';
import { catalogForCall, loggedToLabel, manualCallOutcome } from '../../../utils/softphone/callLabels';
import { fieldLabel, formatFieldValue } from '../../../utils/softphone/callFields';
import { callEndSummary } from '../../../utils/softphone/callState';
import { formatDialNumber } from '../../../utils/softphone/phoneInput';
import type {
  AgencyCallField,
  AgencyManualCall,
  AgencyManualCallDetail,
  AgencyManualCallOverrides,
  AgencySoftphoneBootstrap,
} from '../../../types/softphone';
import styles from '../AgencyAttemptCallPage.module.css';

const ROLE_LABELS = { agent: 'Agent', customer: 'Customer' };
const ANALYSIS_MESSAGES: Record<string, string> = {
  awaiting_recording: ANALYSIS_STATUS_MESSAGES.awaiting_recording!,
  pending: ANALYSIS_STATUS_MESSAGES.pending!,
  failed: ANALYSIS_STATUS_MESSAGES.failed!,
  expired: ANALYSIS_STATUS_MESSAGES.expired!,
  deleted: ANALYSIS_STATUS_MESSAGES.deleted!,
};

const CONTACT_STATE_LABELS: Record<string, string> = {
  pending: 'Waiting to be called',
  in_flight: 'Being called',
  connected: 'Connected, awaiting its outcome',
  completed: 'Completed',
  exhausted: 'Out of attempts',
  suppressed: 'Do not call',
};

/** The facts that say whose call it was and where it was logged. */
export function manualIdentityFacts(call: AgencyManualCall): CallFact[] {
  return [
    { label: 'Agent', value: call.agent_name ?? 'Former member', muted: call.agent_name === null },
    { label: 'Logged to', value: loggedToLabel(call), muted: call.tag === null },
    {
      label: 'What happened',
      value: call.outcome ? attemptOutcomeLabel(call.outcome) : call.state === 'ended' ? callEndSummary(call) : 'On a call now',
      hint: 'What the line did — the same classification a campaign call gets.',
    },
  ];
}

/** The outcome the agent saved, labelled as the agent's. */
export function manualOutcomeCard(call: AgencyManualCall, bootstrap: AgencySoftphoneBootstrap | null): CallFactCard {
  const outcome = manualCallOutcome(call, catalogForCall(call, bootstrap));
  const facts: CallFact[] = [
    {
      label: 'Outcome',
      value: call.disposition_code ? outcome.text : outcome.kind === 'awaiting' ? 'No outcome yet' : 'Not written up',
      muted: call.disposition_code === null,
      ...(call.disposition_code && outcome.text !== call.disposition_code ? { hint: `Filed as “${call.disposition_code}”` } : {}),
    },
    {
      label: 'Saved',
      value: call.dispositioned_at
        ? `${formatSpineTimestamp(call.dispositioned_at)}${call.dispositioned_on_behalf ? ' · by a supervisor, on the agent’s behalf' : ''}`
        : null,
    },
  ];
  if (call.callback_at) facts.push({ label: 'Call back', value: formatSpineTimestamp(call.callback_at) });
  facts.push({ label: 'Notes', value: call.notes ?? 'None', muted: call.notes === null, prose: true });
  return { title: 'Outcome', facts, source: 'Agent' };
}

/** The call details the agent entered, by the account's field labels; keys since removed still show. */
export function manualFieldsCard(call: AgencyManualCall, fields: readonly AgencyCallField[]): CallFactCard | null {
  const keys = [
    ...fields.map((f) => f.key),
    ...Object.keys(call.fields).filter((k) => !fields.some((f) => f.key === k)),
  ];
  if (keys.length === 0) return null;
  const facts: CallFact[] = keys.map((key) => {
    const field = fields.find((f) => f.key === key);
    const value = formatFieldValue(field, call.fields[key]);
    return { label: fieldLabel(fields, key), value: value ?? 'Not filled in', muted: value === null };
  });
  return { title: 'Call details', facts, source: 'Agent' };
}

/** The agent's reasons for calling through a refusal (SP1, SP2) — only when one was used. */
export function manualOverridesCard(overrides: AgencyManualCallOverrides): CallFactCard | null {
  const facts: CallFact[] = [];
  if (overrides.dnc_note) {
    facts.push({ label: 'Called through Do Not Call', value: overrides.dnc_note, prose: true });
    if (overrides.dnc_entry_id) facts.push({ label: 'DNC entry', value: overrides.dnc_entry_id, mono: true });
  }
  if (overrides.hours_note) {
    facts.push({ label: 'Called outside calling hours', value: overrides.hours_note, prose: true });
  }
  return facts.length > 0 ? { title: 'Overrides', facts, source: 'Agent' } : null;
}

function contactCard(call: AgencyManualCall): CallFactCard | null {
  if (!call.contact) return null;
  return {
    title: 'Roster contact',
    facts: [
      { label: 'Now', value: CONTACT_STATE_LABELS[call.contact.state] ?? call.contact.state },
      {
        label: 'This call',
        value: call.contact.claimed ? 'Settled the contact with its outcome' : 'Linked only — the campaign was not waiting on it',
      },
    ],
  };
}

function recordCard(call: AgencyManualCall): CallFactCard {
  const facts: CallFact[] = [
    { label: 'Number', value: formatDialNumber(call.destination_e164), mono: true },
    { label: 'Caller ID', value: formatDialNumber(call.caller_id), mono: true },
    { label: 'When', value: formatSpineTimestamp(call.created_at) },
  ];
  if (call.talk_seconds !== null) facts.push({ label: 'Talk time', value: formatTalkTime(call.talk_seconds), mono: true });
  return { title: 'Call record', facts };
}

/**
 * `/agency/softphone/calls/:callId` — one soft-phone call, for a supervisor.
 *
 * The campaign call's detail (`CallDetailView`): recording, summary, sentiment,
 * custom dimensions, transcript — plus what only a manual call has: the agent's
 * call details and outcome, each labelled **Agent**, beside the analysis labelled
 * **AI**, and the agent's override notes when a DNC entry or a closed calling
 * window was dialled through. A call that never got a media leg (refused, or
 * failed before dialling) shows its record without the media sections.
 */
export default function SoftphoneCallDetailPage() {
  const { callId } = useParams<{ callId: string }>();
  const { tenantId, accountId } = useTenant();
  const { isEnabled } = useGovernance();
  const [detail, setDetail] = useState<AgencyManualCallDetail | null>(null);
  const [bootstrap, setBootstrap] = useState<AgencySoftphoneBootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [terminal, setTerminal] = useState(false);

  const load = useCallback(async () => {
    if (!callId) return;
    setLoading(true);
    setError(null);
    setTerminal(false);
    try {
      setDetail(await getManualCall(callId, tenantId ?? undefined, accountId ?? undefined));
    } catch (err) {
      setError(getErrorMessage(err, 'We couldn’t load this call.'));
      setTerminal(errorStatus(err) === 403 || errorStatus(err) === 404 || errorCode(err) === 'call_not_found');
    } finally {
      setLoading(false);
    }
  }, [callId, tenantId, accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!tenantId || !accountId) return;
    getSoftphoneBootstrap(tenantId, accountId)
      .then(setBootstrap)
      .catch(() => setBootstrap(null));
  }, [tenantId, accountId]);

  const fetchRecording = useCallback(
    async (tenant: string, account: string | undefined) =>
      callId ? fetchManualCallRecordingBlobUrl(callId, tenant, account) : null,
    [callId],
  );

  const cards = useMemo(() => {
    if (!detail) return [];
    const list: CallFactCard[] = [manualOutcomeCard(detail.call, bootstrap)];
    const fields = manualFieldsCard(detail.call, bootstrap?.call_fields ?? []);
    if (fields) list.push(fields);
    const overrides = manualOverridesCard(detail.overrides);
    if (overrides) list.push(overrides);
    const contact = contactCard(detail.call);
    if (contact) list.push(contact);
    return list;
  }, [detail, bootstrap]);

  const breadcrumbs = useMemo(() => {
    const trail: Array<{ label: string; href?: string }> = [{ label: 'Soft-phone calls', href: '/agency/softphone' }];
    const tag = detail?.call.tag;
    if (tag) trail.push({ label: tag.campaign_name, href: `/agency/campaigns/${tag.campaign_id}/manual-calls` });
    return trail;
  }, [detail]);

  if (loading) {
    return (
      <div>
        <Breadcrumbs items={[...breadcrumbs, { label: 'Call' }]} />
        <LoadingSpinner />
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <Breadcrumbs items={[...breadcrumbs, { label: 'Call' }]} />
        {terminal ? (
          <EmptyState
            icon={<SearchX size={28} />}
            title="We can’t show this call"
            description={`${error} Use the trail above to go back to the soft-phone calls.`}
          />
        ) : (
          <ErrorAlert message={error} onRetry={() => void load()} />
        )}
      </div>
    );
  }

  if (!detail) return null;
  const { call, media, call_availability: availability } = detail;
  const leaf = formatSpineTimestamp(call.created_at);

  if (!media) {
    const purged = availability === 'purged';
    return (
      <div>
        <Breadcrumbs items={[...breadcrumbs, { label: leaf }]} />
        <EmptyState
          icon={purged ? <PhoneOff size={28} /> : <PhoneMissed size={28} />}
          title={purged ? 'This call’s recording and transcript are no longer available' : 'No call was placed'}
          description={
            purged
              ? 'They passed their retention window and were deleted. The call record and the agent’s notes below are kept.'
              : 'This dial ended before a call was placed, so there is no recording or transcript. The record below is all there is.'
          }
        />
        <div className={styles.attemptRecord}>
          <FactCard card={recordCard(call)} icon={<Info size={16} />} />
          {cards.map((card) => (
            <FactCard key={card.title} card={card} icon={<MessageSquare size={16} />} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <CallDetailView
      call={media}
      breadcrumbs={breadcrumbs}
      leafLabel={leaf}
      subtitle={`Soft phone · ${loggedToLabel(call)}`}
      roleLabels={ROLE_LABELS}
      identityFacts={manualIdentityFacts(call)}
      identityCards={cards}
      analysisEnabled={isEnabled(AGENCY_ANALYTICS_CAPABILITY)}
      analysisTitle="Call summary"
      analysisMessages={ANALYSIS_MESSAGES}
      analysisSource="AI"
      retryLabel="Try again"
      recordingEnabled={isEnabled(AGENCY_RECORDING_CAPABILITY)}
      fetchRecording={fetchRecording}
      onRetryAnalysis={undefined}
      onReload={() => void load()}
    />
  );
}
