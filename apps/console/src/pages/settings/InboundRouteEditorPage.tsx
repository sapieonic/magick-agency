import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { useTenant } from '../../contexts/TenantContext';
import { usePermission } from '../../hooks/usePermission';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { INBOUND_FLAG } from '../../utils/inbound/inboundFlag';
import { useCallAnalysisProfiles } from '../../hooks/useCallAnalysisProfiles';
import {
  createInboundRoute,
  getInboundRoute,
  listInboundClips,
  listInboundNumbers,
  updateInboundRoute,
} from '../../api/inbound';
import { listAgencyCampaigns } from '../../api/agencyCampaigns';
import { CapabilityUnavailable } from '../../components/common/CapabilityUnavailable';
import { DispositionCatalogEditor } from '../campaigns/agency/DispositionCatalogEditor';
import { useConfigFieldErrors } from '../campaigns/agency/configFieldErrors';
import { DEFAULT_DISPOSITIONS } from '../../utils/agencyCampaignConfigForm';
import { formatDialNumber } from '../../utils/softphone/phoneInput';
import { UNANSWERED_LEAD, WRAPUP_FIELD, inboundRefusalCopy } from '../../utils/inbound/inboundCopy';
import {
  configFromDraft,
  createRequestFromDraft,
  draftChanged,
  draftFromRoute,
  newRouteDraft,
  numberAvailability,
  offeredUnconnectedActions,
  patchFromDraft,
  routeErrorsFromDetails,
  validateRouteDraft,
  type InboundRouteDraft,
} from '../../utils/inbound/routeForm';
import {
  AGENCY_INBOUND_AVAILABLE_ACTIONS,
  AGENCY_INBOUND_ROUTE_LIMITS as L,
  inboundRouteWarnings,
  type AgencyInboundClipOption,
  type AgencyInboundNumberOption,
  type AgencyInboundRoute,
  type AgencyInboundRouteWarning,
} from '../../types/inbound';
import type { AgencyCampaign } from '../../types/agency-campaign';
import styles from '../../components/agency/inbound/Inbound.module.css';
import { ActionChoice, NumberField, RouteWarnings } from './inbound-route/fields';
import { HolidaysCard, OpeningHoursCard } from './inbound-route/RouteHoursCards';
import { RouteClipsCard } from './inbound-route/RouteClipsCard';
import { RouteRoutingCard } from './inbound-route/RouteRoutingCard';

const COMMON_TIMEZONES = [
  'Europe/London', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'America/New_York', 'America/Chicago',
  'America/Los_Angeles', 'Australia/Sydney', 'UTC',
];

/**
 * Settings → Inbound calls → a route (`/app/inbound/new`, `/app/inbound/:routeId`;
 * `docs/inbound.md` §8.1): name and time zone, the numbers it answers, weekly hours (overnight
 * stretches included) and holidays, the clips callers hear, routing to the caller's agent (IB2),
 * queue limits (§5.1), the wrap-up window of every call on it (IQ52), what happens when nobody
 * answers (IB3), recording (IB7) and the outcomes for callers matched to no campaign.
 *
 * The cards are in `./inbound-route/` (hours and holidays, what callers hear with its previews and
 * the recordings, who answers); this page holds the draft, the loads and the save, and the
 * smaller cards. Every rule is in `utils/inbound/routeForm.ts`; the server judges the whole route again and its
 * `inbound_route_invalid` details land on the same fields. A save of an existing route sends
 * only what changed. What happens to a call nobody answers is offered from the server's own list
 * (`AGENCY_INBOUND_AVAILABLE_ACTIONS`): while that is callback alone there is no choice to make
 * and the card says so; voicemail is offered the moment the list includes it.
 *
 * A new route starts open Monday to Friday, 09:00–17:30. What callers hear: each message is the
 * account's recording chosen for it, else our standard recording (the hold, the built-in tone);
 * recordings are uploaded and deleted here (`InboundRecordingsPanel`), and the selects follow the
 * list. The route's warnings (`inboundRouteWarnings`, the server's own) are shown live beside
 * the field they are about: no opening hours, a call recorded unannounced, and, for the whole
 * route, a deployment that cannot put callers through (`connects_agents`, from the recordings'
 * read).
 */
export default function InboundRouteEditorPage() {
  const { routeId } = useParams<{ routeId: string }>();
  const isNew = !routeId;
  const navigate = useNavigate();
  const { tenantId, accountId } = useTenant();
  const { showToast } = useToast();
  const canWrite = usePermission('agency.inbound.write');
  const flagOn = useFeatureFlagEnabled(INBOUND_FLAG);
  const mayReadProfiles = usePermission('agency.analysis_profiles.read');
  const { profiles } = useCallAnalysisProfiles({ enabled: mayReadProfiles && canWrite && flagOn });

  const [saved, setSaved] = useState<AgencyInboundRoute | null>(null);
  const [draft, setDraft] = useState<InboundRouteDraft | null>(isNew ? newRouteDraft() : null);
  const [numbers, setNumbers] = useState<AgencyInboundNumberOption[]>([]);
  const [clips, setClips] = useState<AgencyInboundClipOption[]>([]);
  const [uploadAvailable, setUploadAvailable] = useState(false);
  const [connectsAgents, setConnectsAgents] = useState(true);
  const [campaigns, setCampaigns] = useState<AgencyCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId || !accountId || !canWrite || !flagOn) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [route, numberList, clipList, campaignList] = await Promise.all([
        routeId ? getInboundRoute(routeId, tenantId, accountId) : Promise.resolve(null),
        listInboundNumbers(tenantId, accountId),
        listInboundClips(tenantId, accountId),
        // The pool's choices; a failure here only empties them (the route itself still loads).
        listAgencyCampaigns(tenantId, accountId).catch(() => [] as AgencyCampaign[]),
      ]);
      if (route) {
        setSaved(route);
        setDraft(draftFromRoute(route));
      }
      setNumbers(numberList.numbers);
      setClips(clipList.clips);
      setUploadAvailable(clipList.upload_available);
      setConnectsAgents(clipList.connects_agents);
      setCampaigns(campaignList);
    } catch (err) {
      setLoadError(getErrorMessage(err, 'We couldn’t load this inbound route.'));
    } finally {
      setLoading(false);
    }
  }, [tenantId, accountId, routeId, canWrite, flagOn]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The recordings again, after an upload or delete the list no longer matches. A failure keeps what is shown. */
  const reloadClips = useCallback(async () => {
    if (!tenantId || !accountId) return;
    try {
      const clipList = await listInboundClips(tenantId, accountId);
      setClips(clipList.clips);
      setUploadAvailable(clipList.upload_available);
      setConnectsAgents(clipList.connects_agents);
    } catch {
      // The panel already said why; the list stays as it was.
    }
  }, [tenantId, accountId]);

  const clientErrors = useMemo(() => (draft ? validateRouteDraft(draft) : {}), [draft]);
  const errors = useConfigFieldErrors({ ...serverErrors, ...(touched ? clientErrors : {}) });
  const invalid = Object.keys(clientErrors).length > 0;
  const changed = draft ? draftChanged(saved, draft) : false;
  const numberLabel = (id: string) => {
    const n = numbers.find((o) => o.phone_number_id === id) ?? saved?.numbers.find((o) => o.phone_number_id === id);
    return n ? formatDialNumber(n.phone_number) : null;
  };

  if (!canWrite || !flagOn) return <CapabilityUnavailable />;
  if (loading && !loadError) return <LoadingSpinner />;
  if (loadError || !draft) {
    return (
      <div className={styles.page}>
        <PageHeader title={isNew ? 'New inbound route' : 'Inbound route'} />
        <ErrorAlert message={loadError ?? 'We couldn’t load this inbound route.'} onRetry={() => void load()} />
        <Link to="/app/inbound" className={styles.iconLabel}>
          <ArrowLeft size={14} aria-hidden="true" /> All inbound routes
        </Link>
      </div>
    );
  }

  const update = (patch: Partial<InboundRouteDraft>) => {
    setTouched(true);
    setServerErrors({});
    setSaveError(null);
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const save = async () => {
    setTouched(true);
    if (invalid) {
      setSaveError('Fix the highlighted fields before saving.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    const result = saved
      ? await updateInboundRoute(saved.id, patchFromDraft(saved, draft), tenantId ?? undefined, accountId ?? undefined)
      : await createInboundRoute(createRequestFromDraft(draft), tenantId ?? undefined, accountId ?? undefined);
    setSaving(false);
    if (result.ok) {
      setSaved(result.value);
      setDraft(draftFromRoute(result.value));
      setTouched(false);
      setServerErrors({});
      showToast(isNew ? `“${result.value.name}” created.` : 'Inbound route saved.', 'success');
      if (isNew) navigate(`/app/inbound/${result.value.id}`, { replace: true });
      return;
    }
    const refusal = result.refusal;
    if (refusal.code === 'inbound_route_invalid') setServerErrors(routeErrorsFromDetails(refusal.details));
    if (refusal.code === 'inbound_route_name_taken') setServerErrors({ name: 'Another route in this account has this name.' });
    if (refusal.phoneNumberId) setServerErrors({ phone_number_ids: inboundRefusalCopy(refusal, numberLabel) });
    setSaveError(inboundRefusalCopy(refusal, numberLabel));
  };

  const toggleNumber = (id: string) =>
    update({ numberIds: draft.numberIds.includes(id) ? draft.numberIds.filter((n) => n !== id) : [...draft.numberIds, id] });
  // A number on this route that the account can no longer choose stays listed, so it can be removed.
  const numberChoices = [
    ...numbers,
    ...(saved?.numbers ?? [])
      .filter((n) => !numbers.some((o) => o.phone_number_id === n.phone_number_id))
      .map((n) => ({ phone_number_id: n.phone_number_id, phone_number: n.phone_number, linked: true, route_id: saved!.id, route_name: saved!.name, held_elsewhere: false })),
  ];
  const usingBuiltIn = draft.catalog.length === 0;
  const profileKnown = draft.profileId === null || profiles.some((p) => p.id === draft.profileId);
  const actionChoices = offeredUnconnectedActions(AGENCY_INBOUND_AVAILABLE_ACTIONS, [
    draft.afterHoursAction,
    draft.overflowAction,
  ]);
  // Advisory, as the server's `warnings`, computed live from the draft. Never blocks the save.
  const routeWarnings = inboundRouteWarnings(configFromDraft(draft), { connectsAgents });
  const warningsAt = (path: AgencyInboundRouteWarning['path']) => routeWarnings.filter((w) => w.path === path);

  return (
    <div className={styles.page}>
      <Link to="/app/inbound" className={styles.iconLabel}>
        <ArrowLeft size={14} aria-hidden="true" /> All inbound routes
      </Link>
      <PageHeader
        title={isNew ? 'New inbound route' : (saved?.name ?? 'Inbound route')}
        actions={
          <div className={styles.headerActions}>
            {changed && !isNew ? <span className={styles.unsaved}>Unsaved changes</span> : null}
            <button
              type="button"
              className={`btn-primary ${styles.iconLabel}`}
              onClick={() => void save()}
              disabled={saving || (!isNew && !changed)}
              data-testid="inbound-route-save"
            >
              <Save size={15} aria-hidden="true" />
              {saving ? 'Saving…' : isNew ? 'Create route' : 'Save changes'}
            </button>
          </div>
        }
      />
      {saveError ? <ErrorAlert message={saveError} /> : null}
      {errors.render('form')}
      <RouteWarnings warnings={warningsAt(null)} />

      <div className={styles.grid}>
        <div className={styles.stack}>
          <section className="card" aria-labelledby="ib-basics">
            <h2 className={styles.cardTitle} id="ib-basics">Route</h2>
            <div className={styles.fields}>
              <div className="form-group">
                <label htmlFor="ib-name">Name</label>
                <input
                  id="ib-name"
                  value={draft.name}
                  maxLength={L.NAME_MAX}
                  placeholder="Main line"
                  onChange={(e) => update({ name: e.target.value })}
                  aria-describedby={errors.describedBy('name')}
                  data-testid="inbound-route-name"
                />
                {errors.render('name')}
              </div>
              <div className="form-group">
                <label htmlFor="ib-timezone">Time zone</label>
                <input
                  id="ib-timezone"
                  value={draft.timezone}
                  list="ib-timezone-options"
                  placeholder="Europe/London"
                  onChange={(e) => update({ timezone: e.target.value })}
                  aria-describedby={errors.describedBy('timezone')}
                  data-testid="inbound-route-timezone"
                />
                <datalist id="ib-timezone-options">
                  {COMMON_TIMEZONES.map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
                {errors.render('timezone')}
              </div>
            </div>
          </section>

          <section className="card" aria-labelledby="ib-numbers" data-testid="inbound-route-numbers">
            <h2 className={styles.cardTitle} id="ib-numbers">Numbers</h2>
            <p className={styles.cardLead}>Calls to these numbers follow this route. A number answers one route at a time.</p>
            {numberChoices.length === 0 ? (
              <p className={styles.note}>This account has no numbers yet. Contact support to have numbers assigned.</p>
            ) : (
              <ul className={styles.choiceList} aria-describedby={errors.describedBy('phone_number_ids')}>
                {numberChoices.map((option) => {
                  const selected = draft.numberIds.includes(option.phone_number_id);
                  const availability = numberAvailability(option, saved?.id ?? null);
                  const disabled = !selected && !availability.available;
                  const id = `ib-number-${option.phone_number_id}`;
                  return (
                    <li key={option.phone_number_id} className={styles.choice} data-available={selected || availability.available ? 'true' : 'false'}>
                      <input
                        type="checkbox"
                        id={id}
                        checked={selected}
                        disabled={disabled}
                        onChange={() => toggleNumber(option.phone_number_id)}
                        aria-describedby={availability.available ? undefined : `${id}-why`}
                      />
                      <label htmlFor={id}>
                        <span className={styles.mono}>{formatDialNumber(option.phone_number)}</span>
                        {availability.available ? null : (
                          <span className={styles.sub} id={`${id}-why`}>
                            {availability.reason}
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            {errors.render('phone_number_ids')}
          </section>

          <OpeningHoursCard draft={draft} update={update} errors={errors} warnings={warningsAt('weekly_hours')} />
          <HolidaysCard draft={draft} update={update} errors={errors} />
          <RouteClipsCard
            draft={draft}
            update={update}
            errors={errors}
            clips={clips}
            uploadAvailable={uploadAvailable}
            tenantId={tenantId ?? undefined}
            accountId={accountId ?? undefined}
            onUploaded={(clip) => setClips((current) => [clip, ...current.filter((c) => c.id !== clip.id)])}
            onDeleted={(clipId) => setClips((current) => current.filter((c) => c.id !== clipId))}
            onStale={() => void reloadClips()}
          />
        </div>

        <div className={styles.stack}>
          <RouteRoutingCard draft={draft} update={update} errors={errors} campaigns={campaigns} />

          <section className="card" aria-labelledby="ib-queue" data-testid="inbound-route-queue">
            <h2 className={styles.cardTitle} id="ib-queue">Waiting and limits</h2>
            <div className={styles.fields}>
              <NumberField id="ib-queue-wait" label="Longest wait (seconds)" value={draft.queueMaxWait}
                hint={`${L.QUEUE_MAX_WAIT_SECONDS.min}–${L.QUEUE_MAX_WAIT_SECONDS.max}.`}
                onChange={(v) => update({ queueMaxWait: v })} errors={errors} path="queue_max_wait_seconds" />
              <NumberField id="ib-max-waiting" label="Callers waiting at once" value={draft.maxWaiting}
                hint="0 means nobody waits: a caller no agent can take at once is missed."
                onChange={(v) => update({ maxWaiting: v })} errors={errors} path="max_waiting" />
              <NumberField id="ib-max-concurrent" label="Calls at once" value={draft.maxConcurrent}
                hint="Waiting and connected together. Inbound calls also count towards the account’s live calls."
                onChange={(v) => update({ maxConcurrent: v })} errors={errors} path="max_concurrent" />
            </div>
          </section>

          <section className="card" aria-labelledby="ib-after-call" data-testid="inbound-route-wrapup">
            <h2 className={styles.cardTitle} id="ib-after-call">After the call</h2>
            <div className={styles.fields}>
              <NumberField id="ib-wrapup" label={WRAPUP_FIELD.label} value={draft.wrapupSeconds} hint={WRAPUP_FIELD.hint}
                onChange={(v) => update({ wrapupSeconds: v })} errors={errors} path="wrapup_seconds" />
            </div>
          </section>

          <section className="card" aria-labelledby="ib-unanswered" data-testid="inbound-route-unanswered">
            <h2 className={styles.cardTitle} id="ib-unanswered">When nobody answers</h2>
            <p className={styles.cardLead}>{UNANSWERED_LEAD}</p>
            {actionChoices.length > 1 ? (
              <>
                <ActionChoice
                  name="ib-after-hours-action"
                  legend="Out of hours"
                  actions={actionChoices}
                  value={draft.afterHoursAction}
                  onChange={(afterHoursAction) => update({ afterHoursAction })}
                  testId="inbound-after-hours-action"
                />
                <ActionChoice
                  name="ib-overflow-action"
                  legend="When nobody can answer"
                  actions={actionChoices}
                  value={draft.overflowAction}
                  onChange={(overflowAction) => update({ overflowAction })}
                  testId="inbound-overflow-action"
                />
              </>
            ) : (
              <p className={styles.note} data-testid="inbound-voicemail-note">Voicemail isn’t available yet.</p>
            )}
            {errors.render('after_hours_action')}
            {errors.render('overflow_action')}
          </section>

          <section className="card" aria-labelledby="ib-recording" data-testid="inbound-route-recording">
            <h2 className={styles.cardTitle} id="ib-recording">Recording and summaries</h2>
            <label className={styles.switch}>
              <input type="checkbox" role="switch" checked={draft.recordCalls} onChange={(e) => update({ recordCalls: e.target.checked })} data-testid="inbound-record" />
              Record answered calls
            </label>
            <label className={styles.switch}>
              <input
                type="checkbox"
                role="switch"
                checked={draft.recordingNotice}
                disabled={!draft.recordCalls}
                onChange={(e) => update({ recordingNotice: e.target.checked })}
                data-testid="inbound-recording-notice"
              />
              Tell callers the call is recorded before an agent joins
            </label>
            <RouteWarnings warnings={warningsAt('recording_notice')} />
            {mayReadProfiles ? (
              <div className="form-group">
                <label htmlFor="ib-profile">Summary profile</label>
                <select
                  id="ib-profile"
                  value={draft.profileId ?? ''}
                  onChange={(e) => update({ profileId: e.target.value || null })}
                  aria-describedby={errors.describedBy('analysis_profile_id')}
                >
                  <option value="">The account’s default</option>
                  {profileKnown ? null : <option value={draft.profileId!}>Current profile</option>}
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {errors.render('analysis_profile_id')}
              </div>
            ) : null}
          </section>

          <section className="card" aria-labelledby="ib-outcomes" data-testid="inbound-route-outcomes">
            <h2 className={styles.cardTitle} id="ib-outcomes">Outcomes for callers we don’t recognise</h2>
            <p className={styles.cardLead}>A caller matched to a campaign uses that campaign’s outcomes.</p>
            {usingBuiltIn ? (
              <>
                <p className={styles.note}>The built-in outcomes are in use.</p>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => update({ catalog: DEFAULT_DISPOSITIONS.map((d) => ({ ...d })) })}
                  data-testid="inbound-customise-outcomes"
                >
                  Customise the outcomes
                </button>
              </>
            ) : (
              <>
                <DispositionCatalogEditor dispositions={draft.catalog} onChange={(next) => update({ catalog: next })} errors={errors} />
                <button type="button" className="btn-secondary" onClick={() => update({ catalog: [] })}>
                  Use the built-in outcomes instead
                </button>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

