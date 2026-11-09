import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Save, Trash2 } from 'lucide-react';
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
import { ISO_WEEKDAY_SHORT } from '../../utils/format/weekdays';
import { formatDialNumber } from '../../utils/softphone/phoneInput';
import {
  CLIP_SLOT_LABELS,
  STICKY_MODE_LABELS,
  inboundRefusalCopy,
} from '../../utils/inbound/inboundCopy';
import {
  createRequestFromDraft,
  draftChanged,
  draftFromRoute,
  isOvernight,
  newRouteDraft,
  numberAvailability,
  offeredUnconnectedActions,
  UNCONNECTED_ACTION_LABELS,
  patchFromDraft,
  routeErrorsFromDetails,
  validateRouteDraft,
  weekdayHours,
  type InboundRouteDraft,
} from '../../utils/inbound/routeForm';
import {
  AGENCY_INBOUND_AVAILABLE_ACTIONS,
  AGENCY_INBOUND_CLIP_SLOTS,
  AGENCY_INBOUND_ROUTE_LIMITS as L,
  AGENCY_INBOUND_STICKY_MODES,
  type AgencyInboundClipOption,
  type AgencyInboundNumberOption,
  type AgencyInboundRoute,
  type AgencyInboundUnconnectedAction,
} from '../../types/inbound';
import type { AgencyCampaign } from '../../types/agency-campaign';
import styles from '../../components/agency/inbound/Inbound.module.css';

const COMMON_TIMEZONES = [
  'Europe/London', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'America/New_York', 'America/Chicago',
  'America/Los_Angeles', 'Australia/Sydney', 'UTC',
];

/**
 * Settings → Inbound calls → a route (`/app/inbound/new`, `/app/inbound/:routeId`;
 * `docs/inbound.md` §8.1): name and time zone, the numbers it answers, weekly hours (overnight
 * stretches included) and holidays, the clips callers hear, routing to the caller's agent (IB2),
 * queue limits (§5.1), what happens when nobody answers (IB3), recording (IB7) and the outcomes
 * for callers matched to no campaign.
 *
 * Every rule is in `utils/inbound/routeForm.ts`; the server judges the whole route again and its
 * `inbound_route_invalid` details land on the same fields. A save of an existing route sends
 * only what changed. What happens to a call nobody answers is offered from the server's own list
 * (`AGENCY_INBOUND_AVAILABLE_ACTIONS`): while that is callback alone there is no choice to make
 * and the card says so; voicemail is offered the moment the list includes it.
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

  const setHours = (index: number, patch: Partial<InboundRouteDraft['hours'][number]>) =>
    update({ hours: draft.hours.map((h, i) => (i === index ? { ...h, ...patch } : h)) });
  const setHoliday = (index: number, patch: Partial<InboundRouteDraft['holidays'][number]>) =>
    update({ holidays: draft.holidays.map((h, i) => (i === index ? { ...h, ...patch } : h)) });
  const toggleNumber = (id: string) =>
    update({ numberIds: draft.numberIds.includes(id) ? draft.numberIds.filter((n) => n !== id) : [...draft.numberIds, id] });
  const togglePool = (id: string) =>
    update({
      poolCampaignIds: draft.poolCampaignIds.includes(id)
        ? draft.poolCampaignIds.filter((c) => c !== id)
        : [...draft.poolCampaignIds, id],
    });
  // A number on this route that the account can no longer choose stays listed, so it can be removed.
  const numberChoices = [
    ...numbers,
    ...(saved?.numbers ?? [])
      .filter((n) => !numbers.some((o) => o.phone_number_id === n.phone_number_id))
      .map((n) => ({ phone_number_id: n.phone_number_id, phone_number: n.phone_number, linked: true, route_id: saved!.id, route_name: saved!.name, held_elsewhere: false })),
  ];
  const usingBuiltIn = draft.catalog.length === 0;
  const profileKnown = draft.profileId === null || profiles.some((p) => p.id === draft.profileId);
  const stickyOff = draft.stickyMode === 'off';
  const actionChoices = offeredUnconnectedActions(AGENCY_INBOUND_AVAILABLE_ACTIONS, [
    draft.afterHoursAction,
    draft.overflowAction,
  ]);

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

          <section className="card" aria-labelledby="ib-hours" data-testid="inbound-route-hours">
            <h2 className={styles.cardTitle} id="ib-hours">Opening hours</h2>
            <p className={styles.cardLead}>
              In the route’s time zone. A closing time earlier than the opening time runs past midnight into the next day;
              a closing time of 00:00 means midnight. With no hours, every call is treated as out of hours.
            </p>
            {errors.render('weekly_hours')}
            <ul className={styles.rows}>
              {draft.hours.map((row, index) => {
                const at = `weekly_hours[${index}]`;
                return (
                  <li key={index} className={styles.editRow} data-testid={`inbound-hours-${index}`}>
                    <div className={styles.small}>
                      <label htmlFor={`${at}-day`}>Day</label>
                      <select id={`${at}-day`} value={row.day} onChange={(e) => setHours(index, { day: Number(e.target.value) })}>
                        {ISO_WEEKDAY_SHORT.map((label, i) => (
                          <option key={label} value={i + 1}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className={styles.small}>
                      <label htmlFor={`${at}-start`}>Opens</label>
                      <input
                        id={`${at}-start`}
                        type="time"
                        value={row.start}
                        onChange={(e) => setHours(index, { start: e.target.value })}
                        aria-describedby={errors.describedBy(`${at}.start`)}
                      />
                      {errors.render(`${at}.start`)}
                    </div>
                    <div className={styles.small}>
                      <label htmlFor={`${at}-end`}>Closes</label>
                      <input
                        id={`${at}-end`}
                        type="time"
                        value={row.end}
                        onChange={(e) => setHours(index, { end: e.target.value })}
                        aria-describedby={[errors.describedBy(`${at}.end`), isOvernight(row) ? `${at}-overnight` : undefined].filter(Boolean).join(' ') || undefined}
                      />
                      {errors.render(`${at}.end`)}
                    </div>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => update({ hours: draft.hours.filter((_, i) => i !== index) })}
                      aria-label={`Remove ${ISO_WEEKDAY_SHORT[row.day - 1] ?? ''} ${row.start}–${row.end}`}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                    {isOvernight(row) ? (
                      <p className={styles.rowNote} id={`${at}-overnight`}>
                        Overnight: closes at {row.end} on {ISO_WEEKDAY_SHORT[row.day % 7]}.
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <div className={styles.buttonRow}>
              <button
                type="button"
                className={`btn-secondary ${styles.iconLabel}`}
                onClick={() => update({ hours: [...draft.hours, { day: 1, start: '09:00', end: '17:00' }] })}
                disabled={draft.hours.length >= L.WEEKLY_HOURS_MAX}
                data-testid="inbound-add-hours"
              >
                <Plus size={14} aria-hidden="true" /> Add hours
              </button>
              {draft.hours.length === 0 ? (
                <button type="button" className="btn-secondary" onClick={() => update({ hours: weekdayHours() })} data-testid="inbound-weekday-hours">
                  Monday to Friday, 09:00–17:00
                </button>
              ) : null}
            </div>
          </section>

          <section className="card" aria-labelledby="ib-holidays" data-testid="inbound-route-holidays">
            <h2 className={styles.cardTitle} id="ib-holidays">Holidays</h2>
            <p className={styles.cardLead}>Closed all day on these dates (up to {L.HOLIDAY_SPAN_DAYS_MAX} days each), whatever the hours say.</p>
            {errors.render('holidays')}
            <ul className={styles.rows}>
              {draft.holidays.map((row, index) => {
                const at = `holidays[${index}]`;
                return (
                  <li key={index} className={styles.editRow}>
                    <div className={styles.small}>
                      <label htmlFor={`${at}-from`}>First day</label>
                      <input id={`${at}-from`} type="date" value={row.from} onChange={(e) => setHoliday(index, { from: e.target.value, ...(row.to ? {} : { to: e.target.value }) })} aria-describedby={errors.describedBy(`${at}.from`)} />
                      {errors.render(`${at}.from`)}
                    </div>
                    <div className={styles.small}>
                      <label htmlFor={`${at}-to`}>Last day</label>
                      <input id={`${at}-to`} type="date" value={row.to} onChange={(e) => setHoliday(index, { to: e.target.value })} aria-describedby={errors.describedBy(`${at}.to`)} />
                      {errors.render(`${at}.to`)}
                    </div>
                    <div className={styles.small}>
                      <label htmlFor={`${at}-label`}>Label (optional)</label>
                      <input id={`${at}-label`} value={row.label} maxLength={L.HOLIDAY_LABEL_MAX} placeholder="Christmas Day" onChange={(e) => setHoliday(index, { label: e.target.value })} aria-describedby={errors.describedBy(`${at}.label`)} />
                      {errors.render(`${at}.label`)}
                    </div>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => update({ holidays: draft.holidays.filter((_, i) => i !== index) })}
                      aria-label={`Remove holiday ${row.label || row.from || index + 1}`}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              className={`btn-secondary ${styles.iconLabel}`}
              onClick={() => update({ holidays: [...draft.holidays, { from: '', to: '', label: '' }] })}
              disabled={draft.holidays.length >= L.HOLIDAYS_MAX}
              data-testid="inbound-add-holiday"
            >
              <Plus size={14} aria-hidden="true" /> Add holiday
            </button>
          </section>

          <section className="card" aria-labelledby="ib-clips" data-testid="inbound-route-clips">
            <h2 className={styles.cardTitle} id="ib-clips">What callers hear</h2>
            <p className={styles.cardLead}>
              Choose one of this account’s audio files for each message. Without a recording, the closed, all lines busy and
              call-back messages are read out in a standard voice instead, and the greeting is skipped.
              {clips.length === 0 ? ' This account has no audio files yet, so callers hear the standard spoken messages. Contact support to add your recordings.' : ''}
            </p>
            <div className={styles.fields}>
              {AGENCY_INBOUND_CLIP_SLOTS.map((slot) => {
                const id = `ib-clip-${slot}`;
                const current = draft.clips[slot];
                const known = current === null || clips.some((c) => c.id === current);
                return (
                  <div key={slot} className="form-group">
                    <label htmlFor={id}>{CLIP_SLOT_LABELS[slot].label}</label>
                    <select
                      id={id}
                      value={current ?? ''}
                      disabled={clips.length === 0 && current === null}
                      onChange={(e) => update({ clips: { ...draft.clips, [slot]: e.target.value || null } })}
                      aria-describedby={[`${id}-hint`, errors.describedBy(`clips.${slot}`)].filter(Boolean).join(' ')}
                    >
                      <option value="">{CLIP_SLOT_LABELS[slot].none}</option>
                      {known ? null : <option value={current!}>Current recording</option>}
                      {clips.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <span className={styles.hint} id={`${id}-hint`}>{CLIP_SLOT_LABELS[slot].hint}</span>
                    {errors.render(`clips.${slot}`)}
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <div className={styles.stack}>
          <section className="card" aria-labelledby="ib-routing" data-testid="inbound-route-routing">
            <h2 className={styles.cardTitle} id="ib-routing">Who answers</h2>
            <p className={styles.cardLead}>
              A caller we recognise goes to the agent they last dealt with first: the contact’s owner, the agent who last called
              them from this number, or the last agent who spoke to them.
            </p>
            <fieldset className={styles.radioGroup}>
              <legend>Their agent first</legend>
              {AGENCY_INBOUND_STICKY_MODES.map((mode) => (
                <label key={mode} className={styles.choice}>
                  <input
                    type="radio"
                    name="ib-sticky-mode"
                    value={mode}
                    checked={draft.stickyMode === mode}
                    onChange={() => update({ stickyMode: mode })}
                    data-testid={`inbound-sticky-${mode}`}
                  />
                  <span>
                    {STICKY_MODE_LABELS[mode].label}
                    <span className={styles.sub}>{STICKY_MODE_LABELS[mode].hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className={styles.fields}>
              <NumberField id="ib-sticky-wait" label="Wait for their agent (seconds)" value={draft.stickyWait} disabled={stickyOff}
                hint={draft.stickyMode === 'strict'
                  ? 'With “Only their agent”, the caller waits for them until the longest wait instead.'
                  : `${L.STICKY_WAIT_SECONDS.min}–${L.STICKY_WAIT_SECONDS.max}, then the team. No longer than the longest wait.`}
                onChange={(v) => update({ stickyWait: v })} errors={errors} path="sticky_wait_seconds" />
              <NumberField id="ib-sticky-lookback" label="Look back (days)" value={draft.stickyLookback} disabled={stickyOff}
                hint="How far back a past call makes an agent theirs."
                onChange={(v) => update({ stickyLookback: v })} errors={errors} path="sticky_lookback_days" />
            </div>
            <h3 className={styles.cardTitle}>The team</h3>
            <p className={styles.cardLead}>
              {draft.poolCampaignIds.length === 0
                ? 'Any agent live on a campaign in this account. Choose campaigns to narrow it to agents staffed on them.'
                : 'Only agents staffed on the campaigns ticked here.'}
            </p>
            {campaigns.length > 0 ? (
              <ul className={styles.choiceList} aria-label="Campaigns whose agents take these calls">
                {campaigns.map((c) => {
                  const id = `ib-pool-${c.id}`;
                  return (
                    <li key={c.id} className={styles.choice}>
                      <input type="checkbox" id={id} checked={draft.poolCampaignIds.includes(c.id)} onChange={() => togglePool(c.id)} />
                      <label htmlFor={id}>{c.name}</label>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {errors.render('pool_campaign_ids')}
            {draft.poolCampaignIds.map((_, i) => errors.render(`pool_campaign_ids[${i}]`))}
          </section>

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

          <section className="card" aria-labelledby="ib-unanswered" data-testid="inbound-route-unanswered">
            <h2 className={styles.cardTitle} id="ib-unanswered">When nobody answers</h2>
            <p className={styles.cardLead}>
              Out of hours the caller hears your Closed message, when every line is busy your All lines busy message, and
              otherwise your We’ll call you back message. The call then ends and appears under Missed calls, assigned to their
              agent or the account. A customer on a campaign also gets a callback booked for when you next open.
            </p>
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

function NumberField({
  id, label, value, hint, onChange, errors, path, disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  hint: string;
  onChange: (value: string) => void;
  errors: ReturnType<typeof useConfigFieldErrors>;
  path: string;
  disabled?: boolean;
}) {
  return (
    <div className="form-group">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={[`${id}-hint`, errors.describedBy(path)].filter(Boolean).join(' ')}
      />
      <span className={styles.hint} id={`${id}-hint`}>{hint}</span>
      {errors.render(path)}
    </div>
  );
}

/** One of the two "when nobody answers" choices: the actions the server accepts, as radios. */
function ActionChoice({
  name,
  legend,
  actions,
  value,
  onChange,
  testId,
}: {
  name: string;
  legend: string;
  actions: readonly AgencyInboundUnconnectedAction[];
  value: AgencyInboundUnconnectedAction;
  onChange: (next: AgencyInboundUnconnectedAction) => void;
  testId: string;
}) {
  return (
    <fieldset className={styles.radioGroup} data-testid={testId}>
      <legend>{legend}</legend>
      {actions.map((action) => (
        <label key={action} className={styles.choice}>
          <input
            type="radio"
            name={name}
            value={action}
            checked={value === action}
            onChange={() => onChange(action)}
            data-testid={`${testId}-${action}`}
          />
          <span>
            {UNCONNECTED_ACTION_LABELS[action].label}
            <span className={styles.sub}>{UNCONNECTED_ACTION_LABELS[action].hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
