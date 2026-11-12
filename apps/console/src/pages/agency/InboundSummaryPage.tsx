import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, PhoneIncoming } from 'lucide-react';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import { useTenant } from '../../contexts/TenantContext';
import { hasPermission } from '../../utils/permissions';
import { useMissedCallsAccess } from '../../hooks/useMissedCallsAccess';
import { CapabilityUnavailable } from '../../components/common/CapabilityUnavailable';
import { PageDescription } from '../../components/common/PageDescription';
import { SettingsEntryLink } from '../../components/common/SettingsEntryLink';
import { getInboundSummary } from '../../api/inbound';
import { formatCount, pct } from '../../utils/format/number';
import { durationWords, statClock } from '../../utils/format/duration';
import {
  INBOUND_SUMMARY_PRESETS,
  inboundSummaryRange,
  localDateInput,
  type InboundSummaryPreset,
} from '../../utils/inbound/inboundSummary';
import type { AgencyInboundSummary } from '../../types/inbound';
import { NOBODY_FREE_MEANING } from '../../utils/inbound/missedCopy';
import spine from '../../components/agency/SpineListLayout.module.css';
import styles from '../../components/agency/inbound/Inbound.module.css';
import summary from '../../components/agency/inbound/MissedCalls.module.css';

/** A rate, or a dash when there was nothing to divide by. */
function rate(value: number | null): string {
  return value === null ? '—' : pct(value);
}

/** The Calls tile's breakdown: while open, out of hours, and the other closed causes when there were any. */
function callsNote(data: AgencyInboundSummary): string {
  const parts = [`${formatCount(data.open_hours_calls)} while open`, `${formatCount(data.after_hours)} out of hours`];
  if (data.switched_off > 0) parts.push(`${formatCount(data.switched_off)} while inbound was off`);
  if (data.no_route > 0) parts.push(`${formatCount(data.no_route)} to a number not on a route`);
  return parts.join(' · ');
}

/** A time to answer, or a dash with no answered call. */
function seconds(value: number | null): string {
  return value === null ? '—' : durationWords(value);
}

/**
 * The inbound summary (`docs/inbound.md` §11): the account's inbound calls over a range, for
 * supervisors and admins (`agency.supervise`, the route's gate). Today, the last 7 or 30 days, or
 * two dates of the viewer's choosing, cut at the viewer's local midnights. Tiles for the calls and
 * what became of them (answer and abandon rates over the calls that rang while the line was open,
 * time to answer, voicemails, nobody free to answer and all lines busy (the Missed list's words),
 * out of hours with the calls closed for another reason apart (inbound switched off, a number not
 * on a route), the sticky hit rate, the Missed calls they left and how many are handled), then
 * each agent's answered calls and talk time.
 *
 * Shown, like the Missed list, while inbound is on or there is inbound history to read: turning
 * inbound off does not hide what already happened.
 */
export default function InboundSummaryPage() {
  const { role, tenantId, accountId } = useTenant();
  const access = useMissedCallsAccess();
  const [preset, setPreset] = useState<InboundSummaryPreset>('7d');
  const today = localDateInput(new Date());
  const [custom, setCustom] = useState({ from: today, to: today });
  const [applied, setApplied] = useState({ preset: '7d' as InboundSummaryPreset, custom: { from: today, to: today } });
  const [data, setData] = useState<AgencyInboundSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const range = useMemo(() => inboundSummaryRange(applied.preset, new Date(), applied.custom), [applied]);
  const draftRange = preset === 'custom' ? inboundSummaryRange('custom', new Date(), custom) : null;
  const allowed = hasPermission(role, 'agency.supervise') && access.available;

  const load = useCallback(async () => {
    if (!allowed || !tenantId || !accountId || !range.ok) return;
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const body = await getInboundSummary({ from: range.from.toISOString(), to: range.to.toISOString() }, tenantId, accountId);
      if (mine === seq.current) setData(body);
    } catch (err) {
      if (mine === seq.current) setError(getErrorMessage(err, 'We couldn’t load the inbound summary.'));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [allowed, tenantId, accountId, range]);

  useEffect(() => {
    void load();
  }, [load]);

  if (role === undefined || !access.settled) return <LoadingSpinner />;
  if (!allowed) return <CapabilityUnavailable />;

  const choose = (next: InboundSummaryPreset) => {
    setPreset(next);
    if (next !== 'custom') setApplied({ preset: next, custom });
  };

  return (
    <div className={styles.page}>
      <PageHeader
        title="Inbound summary"
        subtitle="How this account’s inbound calls went, and who answered them."
        actions={<SettingsEntryLink entry="inbound" />}
      />
      <PageDescription
        pageKey="agency-inbound-summary"
        description={
          'Every inbound call to this account that has ended, by the day it came in. The answer and abandon rates count the '
          + 'calls that rang while the line was open; calls out of hours are shown on their own.'
        }
        tips={[
          'Time to answer runs from when the call came in to when an agent was put through, greeting included.',
          'Their agent answered: of the open-hours callers with an agent of their own, how many were put through to that agent.',
        ]}
      />

      <div className={summary.ranges} role="group" aria-label="Which days">
        <div className={summary.presets}>
          {INBOUND_SUMMARY_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={summary.preset}
              aria-pressed={preset === p.id}
              onClick={() => choose(p.id)}
              data-testid={`summary-preset-${p.id}`}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            className={summary.preset}
            aria-pressed={preset === 'custom'}
            onClick={() => choose('custom')}
            data-testid="summary-preset-custom"
          >
            Choose dates
          </button>
        </div>
        {preset === 'custom' ? (
          <div className={summary.customRange}>
            <label>
              From
              <input
                type="date"
                className={spine.fieldInput}
                value={custom.from}
                max={today}
                onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                data-testid="summary-from"
              />
            </label>
            <label>
              To
              <input
                type="date"
                className={spine.fieldInput}
                value={custom.to}
                max={today}
                onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                data-testid="summary-to"
              />
            </label>
            <button
              type="button"
              className="btn-primary"
              disabled={!draftRange?.ok}
              onClick={() => setApplied({ preset: 'custom', custom })}
              data-testid="summary-apply"
            >
              Show
            </button>
          </div>
        ) : null}
      </div>
      {draftRange && !draftRange.ok ? (
        <p className={spine.filterError} role="alert" data-testid="summary-range-problem">
          <AlertCircle size={13} aria-hidden="true" />
          {draftRange.problem}
        </p>
      ) : null}

      {error ? <ErrorAlert message={error} onRetry={() => void load()} /> : null}
      {loading && !data ? <LoadingSpinner /> : null}

      {data && !error ? (
        data.calls === 0 ? (
          <EmptyState
            icon={<PhoneIncoming size={32} />}
            title="No inbound calls on these days"
            description="Choose other days, or come back once calls have come in."
          />
        ) : (
          <div aria-busy={loading} data-testid="inbound-summary">
            <dl className={summary.tiles}>
              <div className={summary.tile}>
                <dt>Calls</dt>
                <dd data-testid="summary-calls">
                  {formatCount(data.calls)}
                  <span className={summary.tileNote}>{callsNote(data)}</span>
                </dd>
              </div>
              <div className={summary.tile}>
                <dt>Answered</dt>
                <dd data-testid="summary-answered">
                  {rate(data.answer_rate_pct)}
                  <span className={summary.tileNote}>{formatCount(data.answered)} of {formatCount(data.open_hours_calls)} while open</span>
                </dd>
              </div>
              <div className={summary.tile}>
                <dt>Hung up waiting</dt>
                <dd data-testid="summary-abandoned">
                  {rate(data.abandon_rate_pct)}
                  <span className={summary.tileNote}>{formatCount(data.abandoned)} callers</span>
                </dd>
              </div>
              <div className={summary.tile}>
                <dt>Time to answer</dt>
                <dd data-testid="summary-answer-time">
                  {seconds(data.avg_answer_seconds)}
                  <span className={summary.tileNote}>average · 9 in 10 within {seconds(data.p90_answer_seconds)}</span>
                </dd>
              </div>
              <div className={summary.tile}>
                <dt>Their agent answered</dt>
                <dd data-testid="summary-sticky">
                  {rate(data.sticky_hit_rate_pct)}
                  <span className={summary.tileNote}>{formatCount(data.sticky_answered)} of {formatCount(data.sticky_calls)} callers with an agent of their own</span>
                </dd>
              </div>
              <div className={summary.tile}>
                <dt>Voicemails</dt>
                <dd>{formatCount(data.voicemails)}</dd>
              </div>
              <div className={summary.tile}>
                <dt>Nobody free to answer</dt>
                <dd data-testid="summary-nobody-free">
                  {formatCount(data.nobody_free)}
                  <span className={summary.tileNote}>{NOBODY_FREE_MEANING}</span>
                </dd>
              </div>
              <div className={summary.tile}>
                <dt>All lines busy</dt>
                <dd data-testid="summary-lines-busy">
                  {formatCount(data.lines_busy)}
                  <span className={summary.tileNote}>more calls at once than the line takes</span>
                </dd>
              </div>
              <div className={summary.tile}>
                <dt>Missed calls followed up</dt>
                <dd data-testid="summary-missed">
                  {formatCount(data.missed_handled)} of {formatCount(data.missed)}
                </dd>
              </div>
              {data.switched_off > 0 ? (
                <div className={summary.tile}>
                  <dt>While inbound was off</dt>
                  <dd data-testid="summary-switched-off">
                    {formatCount(data.switched_off)}
                    <span className={summary.tileNote}>inbound was switched off, so they heard the closed message</span>
                  </dd>
                </div>
              ) : null}
              {data.no_route > 0 ? (
                <div className={summary.tile}>
                  <dt>Number not on a route</dt>
                  <dd data-testid="summary-no-route">
                    {formatCount(data.no_route)}
                    <span className={summary.tileNote}>rang a number no inbound route answers, so they heard the closed message</span>
                  </dd>
                </div>
              ) : null}
              {data.not_served > 0 ? (
                <div className={summary.tile}>
                  <dt>Couldn’t be put through</dt>
                  <dd>
                    {formatCount(data.not_served)}
                    <span className={summary.tileNote}>a fault on our side, the phone line not active, or turned away</span>
                  </dd>
                </div>
              ) : null}
            </dl>

            <h2 className={summary.sectionTitle}>Agents</h2>
            {data.agents.length === 0 ? (
              <p className={styles.muted}>No agent answered an inbound call on these days.</p>
            ) : (
              <div className={spine.tableWrap}>
                <table className={`${spine.table} ${styles.stackTable}`}>
                  <caption className={styles.srOnly}>Inbound calls each agent answered, busiest first</caption>
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th className={summary.numeric}>Calls answered</th>
                      <th className={summary.numeric}>Talk time</th>
                      <th className={summary.numeric}>Average call</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.agents.map((a) => (
                      <tr key={a.user_id} data-testid={`summary-agent-${a.user_id}`}>
                        <td data-label="Agent">{a.name ?? 'Former member'}</td>
                        <td data-label="Calls answered" className={summary.numeric}>{formatCount(a.answered)}</td>
                        <td data-label="Talk time" className={summary.numeric}>{statClock(a.talk_seconds)}</td>
                        <td data-label="Average call" className={summary.numeric}>
                          {a.answered > 0 ? statClock(a.talk_seconds / a.answered) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className={summary.footnote}>
              Calls still in progress are counted once they end. Out of hours: outside the opening hours or on a holiday,
              including voicemails left then. Calls answered with the closed message for another reason (inbound switched off,
              a number not on a route) are counted on their own, and none of them are in the rates.
            </p>
          </div>
        )
      ) : null}
    </div>
  );
}
