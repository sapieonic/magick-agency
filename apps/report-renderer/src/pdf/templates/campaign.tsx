/**
 * The campaign report: the Insights tab as a document. (1) the headline as of generation and the
 * window's figures, calls and outcomes; (2) trends by day, best hours and the agents; (3)
 * callbacks and health; (4) definitions. Insights serves counts: every rate here is derived from
 * the counts beside it and withheld below `floors.campaign_rate_min_first_dials` (RP9).
 */
import type { ReactNode } from 'react';
import {
  AGENCY_CALLS_BY_TYPE_NO_RATE, AGENCY_OUTBOUND_CONNECT_RATE_LABEL, agencyCallsByTypeFootnote, type CampaignReportDataset,
} from '@magick-agency/contracts/reports';
import { bucketDate, count, dateTime, dayLabel, duration, pct, plural, rangeLabel, rate, rateText, share, shortDate, unknownUser } from '../../format';
import { campaignCallsByType, campaignFigures, campaignOutcomeRows, recordingShare, type CampaignCallsByType } from '../../rates';
import { HourColumns, StackedColumns, tickEvery } from '../charts';
import { DefinitionsPage, Kpis, Legend, NameOrId, Notes, PageHeader, RateCell, Section, STATUS_WORDS, rateKpi } from '../components';
import { INK, STATE_COLOURS } from '../styles';

const STALL_WORDS: Record<string, string> = {
  no_agents: 'No agents available',
  no_slots: 'No call slots free',
  no_contacts: 'No contacts left',
  no_reservations: 'No agent could be reserved',
  no_caller_ids: 'No caller ID available',
  nothing_due: 'Nothing due yet',
  outside_calling_hours: 'Outside calling hours',
};
const RESOLUTION_WORDS: Record<string, string> = {
  agent_skipped: 'Agent skipped the outcome',
  wrapup_timeout: 'Wrap-up timed out',
  reaper: 'Closed by the reaper',
};

export function CampaignReport({ d }: { d: CampaignReportDataset }) {
  const zone = d.range.timezone;
  const small = (title: string) => <PageHeader compact tag="Campaign report" title={title} meta={[rangeLabel(d.range.from, d.range.to), d.campaign.name]} />;
  const floor = d.floors.campaign_rate_min_first_dials;
  return (
    <>
      <OverviewPage d={d} />
      <TrendsPage d={d} floor={floor} header={small('Trends and agents')} />
      <HealthPage d={d} floor={floor} header={small('Callbacks and health')} />
      <DefinitionsPage
        dataset={d}
        header={small('Definitions')}
        floorsLine={`Campaign rates are not quoted below ${count(floor)} in their denominator (first dials for the connect rate, conversations for the success rate, answered calls for abandonment), the Insights floor. Times are in the campaign’s zone, ${zone}.`}
      />
    </>
  );
}

function firstDialsOf(d: CampaignReportDataset): number {
  return d.trends.buckets.reduce((s, b) => s + b.first_dials, 0);
}

function OverviewPage({ d }: { d: CampaignReportDataset }) {
  const zone = d.range.timezone;
  const calls = d.activity.calls;
  const { firstDials, answered, abandoned, connect, success, abandonment, talk, wrap, handle } = campaignFigures(d);
  const conversations = calls.conversations;
  const byType = campaignCallsByType(d);
  // Outcomes by type where the report shows more than the dialler and the dataset carries them (CL28).
  const typed = byType && d.activity.outcomes_by_type ? byType : null;
  const outcomeRows = typed ? campaignOutcomeRows(d, typed) : [];
  return (
    <div className="page" data-page="overview">
      <PageHeader
        tag="Campaign report"
        title={d.campaign.name}
        sub={`Account: ${d.summary.account.name ?? d.account?.name ?? '—'} · ${STATUS_WORDS[d.campaign.status]} as of ${dateTime(d.generated_at, zone)}`}
        meta={[`${rangeLabel(d.range.from, d.range.to)} (${plural(d.range.days, 'day')})`, zone, `Generated ${dateTime(d.generated_at, zone)}`]}
      />
      <Notes notes={d.notes} />
      <Headline d={d} />
      <Section title="The window in numbers" id="kpis">
        <Kpis
          items={[
            { id: 'dials', label: 'Dials', value: count(calls.dials), detail: `${count(firstDials)} first dials · ${count(calls.redials.placed)} redials` },
            { id: 'connected', label: 'Connected', value: count(calls.connected), detail: `${count(conversations)} conversations` },
            // "Dialler connect rate" where another type's figures show beside it (SR1).
            rateKpi(byType ? 'Dialler connect rate' : 'Connect rate', connect, `${count(calls.human_connects)} people / ${count(firstDials)} first dials`, 'connect_rate'),
            rateKpi('Success rate', success, `${count(calls.successes)} successes / ${count(conversations)} conversations`, 'success_rate'),
            rateKpi('Abandonment', abandonment, `${count(abandoned)} of ${count(answered)} answered`, 'abandonment'),
            talk === null || handle === null
              ? { id: 'aht', label: 'Average handle time', value: 'No connected calls', words: true }
              : { id: 'aht', label: 'Average handle time', value: duration(handle), detail: `talk ${duration(talk)} + wrap ${wrap === null ? 'not measured' : duration(wrap)}` },
          ]}
        />
      </Section>
      <Section
        title="Outcomes"
        // With the types' columns the table holds more than the dialler's conversations: say
        // how many across the types, and whose the share is.
        aside={typed
          ? `${count(outcomeRows.reduce((sum, o) => sum + o.total, 0))} conversations across the call types; share is of the dialler’s ${count(conversations)}`
          : `over ${count(conversations)} conversations`}
        id="outcomes"
      >
        {typed ? (
          // One outcome list for the campaign, so one table: each outcome on every call type the
          // report shows (CL28). Share stays the dialler's, of its conversations.
          outcomeRows.length === 0 ? (
            <p className="empty">No conversations in this window.</p>
          ) : (
            <table data-testid="outcomes-by-type">
              <thead>
                <tr>
                  <th>Outcome</th>
                  <th className="num">Dialler</th>
                  <th className="num">Share of dialler</th>
                  {typed.columns.filter((c) => c.type !== 'dialler').map((c) => <th key={c.type} className="num">{c.label}</th>)}
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {outcomeRows.map((o) => (
                  <tr key={String(o.code)}>
                    <td>
                      {o.label ?? (o.code === null ? 'No outcome written' : <span className="idref">{o.code} (retired)</span>)}
                      {o.is_success ? <span className="tagok">SUCCESS</span> : null}
                    </td>
                    <td className="num">{count(o.dialler)}</td>
                    <td className="num">{conversations > 0 ? pct((o.dialler / conversations) * 100) : '—'}</td>
                    {typed.columns.filter((c) => c.type !== 'dialler').map((c) => <td key={c.type} className="num">{count(o[c.type])}</td>)}
                    <td className="num">{count(o.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : d.activity.outcomes.length === 0 ? (
          <p className="empty">No conversations in this window.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Outcome</th>
                <th className="num">Conversations</th>
                <th className="num">Share</th>
              </tr>
            </thead>
            <tbody>
              {d.activity.outcomes.map((o) => (
                <tr key={String(o.code)}>
                  <td>
                    {o.label ?? (o.code === null ? 'No outcome written' : <span className="idref">{o.code} (retired)</span>)}
                    {o.is_success ? <span className="tagok">SUCCESS</span> : null}
                  </td>
                  <td className="num">{count(o.count)}</td>
                  <td className="num">{conversations > 0 ? pct((o.count / conversations) * 100) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {d.activity.no_outcome.total > 0 ? (
          <p className="small muted" style={{ marginTop: 5 }}>
            No outcome written on {plural(d.activity.no_outcome.total, 'conversation')}:{' '}
            {Object.entries(d.activity.no_outcome.by_resolution)
              .filter(([, n]) => n > 0)
              .map(([k, n]) => `${RESOLUTION_WORDS[k] ?? k} ${count(n)}`)
              .join(' · ')}
            .
          </p>
        ) : null}
      </Section>
      <Section title="Calls" id="calls">
        <dl className="facts">
          <dt>Wrap-up redials</dt>
          <dd>
            {count(calls.redials.placed)} placed, {count(calls.redials.connected)} connected; {count(calls.redials.chains_at_limit)} chains reached the redial limit
          </dd>
          <dt>Agent retries</dt>
          <dd>
            {count(calls.agent_retries.reopened_dials)} reopened ({count(calls.agent_retries.reopened_connected)} connected), {count(calls.agent_retries.manual_dials)} manual ({count(calls.agent_retries.manual_connected)} connected)
          </dd>
          <dt>Not answered</dt>
          <dd>
            {count(calls.by_outcome.no_answer)} no answer · {count(calls.by_outcome.busy)} busy · {count(calls.by_outcome.machine)} answering machine · {count(calls.by_outcome.failed)} failed
          </dd>
          <dt>Talk and wrap-up</dt>
          <dd>
            {duration(calls.talk_seconds)} talking; {duration(calls.wrapup_seconds)} wrap-up measured on {plural(calls.wrapup_measured, 'call')}
          </dd>
          <dt>Do Not Call</dt>
          <dd>{plural(d.activity.dnc_marked.total, 'number')} marked by agents</dd>
        </dl>
      </Section>
      {byType ? <CallsByType t={byType} /> : null}
    </div>
  );
}

/** A Calls by type cell that has no such thing for the type. */
const NA = '—';

/**
 * The campaign's calls by type (`docs/call-log.md` §6): a column per type the window holds, and
 * All calls, the counts added. No rate is added (CL7); the dialler and the soft phone together
 * are the Outbound connect rate, under the table. Only when a second type has calls.
 */
function CallsByType({ t }: { t: CampaignCallsByType }) {
  const soft = t.soft;
  return (
    <Section title="Calls by type" id="calls-by-type">
      <table data-testid="calls-by-type">
        <thead>
          <tr>
            <th />
            {t.columns.map((c) => <th key={c.type} className="num">{c.label}</th>)}
            <th className="num">All calls</th>
          </tr>
        </thead>
        <tbody>
          <tr data-row="calls">
            <td>Calls</td>
            {t.columns.map((c) => <td key={c.type} className="num">{count(c.calls)} {c.callsWord}</td>)}
            <td className="num">{count(t.all.calls)}</td>
          </tr>
          <tr data-row="connected">
            <td>Connected</td>
            {t.columns.map((c) => <td key={c.type} className="num">{count(c.connected)}{c.type === 'inbound' ? ' answered' : ''}</td>)}
            <td className="num">{count(t.all.connected)}</td>
          </tr>
          <tr data-row="reached">
            <td>Reached a person</td>
            {t.columns.map((c) => <td key={c.type} className="num">{count(c.reached)}</td>)}
            <td className="num">{count(t.all.reached)}</td>
          </tr>
          <tr data-row="talk">
            <td>Talk time</td>
            {t.columns.map((c) => <td key={c.type} className="num">{c.talk_seconds === null ? NA : duration(c.talk_seconds)}</td>)}
            <td className="num">{duration(t.all.talk_seconds)}</td>
          </tr>
          {t.all.missed !== null ? (
            <tr data-row="missed">
              <td>Missed by us</td>
              {t.columns.map((c) => (
                <td key={c.type} className="num">
                  {c.missed === null ? NA : <>{count(c.missed)} <span className="muted">({count(c.open_follow_ups ?? 0)} to follow up)</span></>}
                </td>
              ))}
              <td className="num">{count(t.all.missed)}</td>
            </tr>
          ) : null}
          <tr data-row="rate">
            <td>Rate</td>
            {t.columns.map((c) => (
              <td key={c.type} className="num">
                <b>{rateText(c.rate)}</b>
                <br />
                <span className="muted">{c.rateLabel}</span>
              </td>
            ))}
            <td className="num muted">{AGENCY_CALLS_BY_TYPE_NO_RATE}</td>
          </tr>
        </tbody>
      </table>
      <p className="small muted" style={{ marginTop: 5 }} data-testid="calls-by-type-note">
        {agencyCallsByTypeFootnote(t.columns.map((c) => c.type))}
        {t.inbound ? ' To follow up counts the campaign’s missed calls still owed a call back when this report was made, whatever the window.' : ''}
      </p>
      {soft ? (
        <p className="small" style={{ marginTop: 4 }} data-testid="outbound-connect-rate">
          {AGENCY_OUTBOUND_CONNECT_RATE_LABEL}: {rateText(soft.outbound.connect)} ({plural(soft.outbound.humanConnects, 'person', 'people')} reached of {count(soft.outbound.firstCalls)} first dials and soft-phone calls, the dialler and the soft phone together; inbound calls are not in it)
        </p>
      ) : null}
    </Section>
  );
}

function Headline({ d }: { d: CampaignReportDataset }) {
  const h = d.summary.headline;
  const r = d.summary.roster;
  const lines: string[] = [];
  if (h.running) {
    const a = h.running.agents_by_state;
    const online = a.available + a.reserved + a.on_call + a.wrapup + a.break;
    lines.push(`${plural(online, 'agent')} online (${count(a.on_call)} on a call), ${plural(h.running.calls_live, 'call')} live`);
    if (h.running.dials_per_hour !== null) lines.push(`${count(Math.round(h.running.dials_per_hour))} dials an hour`);
    if (h.running.eta_seconds !== null) lines.push(`about ${etaWords(h.running.eta_seconds)} of contacts left at this pace`);
  }
  if (h.paused) lines.push(`paused ${h.paused.reason === 'abandonment_ceiling' ? 'by the abandonment ceiling' : h.paused.reason === 'supervisor' ? 'by a supervisor' : 'by its carrier account'}`);
  if (h.completed) lines.push(`completed: ${count(h.completed.reached)} reached, ${count(h.completed.successes)} successes`);
  if (h.stopped) lines.push(`stopped with ${plural(h.stopped.pending, 'contact')} pending`);
  const penetration = rate(r.attempted, r.total, 1);
  return (
    <Section title="Headline" aside={`as of ${dateTime(d.summary.generated_at, d.range.timezone)}, not the window`} id="headline">
      <p>
        <b>{STATUS_WORDS[d.summary.status]}</b>
        {lines.length ? `: ${lines.join(' · ')}.` : '.'}
      </p>
      <p className="small muted" style={{ marginTop: 3 }}>
        Contacts: {count(r.total)} in the list, {count(r.attempted)} attempted ({rateText(penetration)}), {count(r.completed)} completed, {count(r.waiting_due_now + r.waiting_retry + r.waiting_callback)} waiting ({count(r.waiting_callback)} for a callback), {count(r.exhausted)} out of attempts, {count(r.suppressed_dnc + r.suppressed_invalid + r.suppressed_other)} suppressed.
      </p>
    </Section>
  );
}

function TrendsPage({ d, floor, header }: { d: CampaignReportDataset; floor: number; header: ReactNode }) {
  const b = d.trends.buckets;
  const every = tickEvery(b.length);
  const dates = b.map((x) => bucketDate(x.bucket_start, d.range.timezone));
  const totalHuman = b.reduce((s, x) => s + x.human_connects, 0);
  const totalDials = b.reduce((s, x) => s + x.dials, 0);
  const firstDials = firstDialsOf(d);
  const best = [...d.trends.best_hours]
    .map((h) => ({ h, r: rate(h.human_connects, h.first_dials, floor) }))
    .filter((x) => x.r.kind === 'value')
    .sort((a, b) => (b.r as { pct: number }).pct - (a.r as { pct: number }).pct)
    .slice(0, 3)
    .map((x) => x.h.hour);
  const agents = d.activity.agents;
  return (
    <div className="page" data-page="trends">
      {header}
      <Section title="Dials by day" aside={`${count(totalDials)} dials, ${count(totalHuman)} people reached`} id="trends">
        <StackedColumns
          title="Dials by day, people reached at the bottom"
          unit=""
          series={[
            { label: 'People reached', colour: STATE_COLOURS.on_call },
            { label: 'Other dials', colour: INK.rest },
          ]}
          columns={b.map((x, i) => ({
            label: shortDate(dates[i]!),
            tick: i % every === 0,
            values: [x.human_connects, Math.max(0, x.dials - x.human_connects)],
            title: `${dayLabel(dates[i]!)}: ${count(x.dials)} dials, ${count(x.human_connects)} people reached`,
          }))}
        />
        <Legend
          items={[
            { colour: STATE_COLOURS.on_call, label: 'People reached', value: count(totalHuman) },
            { colour: INK.rest, label: 'Other dials', value: count(totalDials - totalHuman) },
          ]}
        />
        <p className="small muted" style={{ marginTop: 4 }}>
          Connect rate over the window: {rateText(rate(totalHuman, firstDials, floor))} ({count(totalHuman)} people / {count(firstDials)} first dials). Busiest day: {busiest(b, dates)}.
        </p>
      </Section>
      <Section title="Best hours to call" aside="hour of day in each contact’s zone; the three best connect rates labelled" id="best-hours">
        {d.trends.best_hours.length === 0 ? (
          <p className="empty">No dials in this window.</p>
        ) : (
          <>
            <HourColumns
              title="First dials by hour of day, people reached at the bottom"
              series={[
                { label: 'People reached', colour: STATE_COLOURS.on_call },
                { label: 'Other first dials', colour: INK.rest },
              ]}
              hours={d.trends.best_hours.map((h) => {
                const r = rate(h.human_connects, h.first_dials, floor);
                return {
                  hour: h.hour,
                  values: [h.human_connects, Math.max(0, h.first_dials - h.human_connects)],
                  label: best.includes(h.hour) ? rateText(r) : null,
                  title: `${String(h.hour).padStart(2, '0')}:00 ${count(h.first_dials)} first dials, connect rate ${rateText(r)}`,
                };
              })}
            />
            <Legend
              items={[
                { colour: STATE_COLOURS.on_call, label: 'People reached' },
                { colour: INK.rest, label: 'Other first dials' },
              ]}
            />
          </>
        )}
      </Section>
      <Section title="Agents" aside="over the window; rates from each agent’s own counts" flow id="agents">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th className="num">Dials</th>
              <th className="num">Connected</th>
              <th className="num">People reached</th>
              <th className="num">Connect rate</th>
              <th className="num">Successes</th>
              <th className="num">Success rate</th>
              <th className="num">Talk</th>
              <th className="num">Online</th>
              <th className="num">Occupancy</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => {
              const occ = share(a.state_seconds.on_call + a.state_seconds.wrapup, a.online_seconds);
              return (
                <tr key={a.agent_user_id ?? 'none'}>
                  <td>
                    <NameOrId name={a.agent_name ?? (a.agent_user_id ? d.agent_names[a.agent_user_id] : null)} id={a.agent_user_id} />
                  </td>
                  <td className="num">{count(a.dials)}</td>
                  <td className="num">{count(a.connected)}</td>
                  <td className="num">{count(a.human_connects)}</td>
                  <RateCell rate={a.agent_user_id ? rate(a.human_connects, a.dials - a.redials, floor) : { kind: 'none' }} />
                  <td className="num">{count(a.successes)}</td>
                  <RateCell rate={a.agent_user_id ? rate(a.successes, a.conversations, floor) : { kind: 'none' }} />
                  <td className="num">{duration(a.talk_seconds)}</td>
                  <td className="num">{a.online_seconds > 0 ? duration(a.online_seconds) : '—'}</td>
                  <td className="num">{occ === null ? '—' : pct(occ)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {d.activity.never_joined.length > 0 ? (
          <p className="small muted" style={{ marginTop: 5 }}>
            Staffed but never joined: {d.activity.never_joined.map((id) => nameOf(d, id)).join(', ')}.
          </p>
        ) : null}
      </Section>
    </div>
  );
}

function HealthPage({ d, floor, header }: { d: CampaignReportDataset; floor: number; header: ReactNode }) {
  const zone = d.range.timezone;
  const cb = d.activity.callbacks;
  const h = d.health;
  const stalls = Object.entries(h.stalls.minutes_by_reason).filter(([, m]) => m > 0);
  const { answered, abandoned, abandonment } = campaignFigures(d);
  const recorded = recordingShare(h.recording.recorded, h.recording.connected);
  return (
    <div className="page" data-page="health">
      {header}
      <Section title="Callbacks" aside="booked in the window" id="callbacks">
        <Kpis
          four
          items={[
            { id: 'booked', label: 'Booked', value: count(cb.booked) },
            { id: 'on_time', label: 'Kept on time', value: count(cb.kept_on_time), detail: cb.booked > 0 ? pct((cb.kept_on_time / cb.booked) * 100) + ' of booked' : undefined },
            { id: 'late', label: 'Kept late', value: count(cb.kept_late) },
            { id: 'missed', label: 'Missed', value: count(cb.missed), detail: `${count(cb.pending_due)} overdue · ${count(cb.pending_future)} ahead` },
          ]}
        />
        {cb.by_owner.length > 0 ? (
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Open callbacks by owner</th>
                <th className="num">Open</th>
                <th className="num">Overdue</th>
              </tr>
            </thead>
            <tbody>
              {cb.by_owner.map((o) => (
                <tr key={o.agent_user_id ?? 'none'}>
                  <td>{o.agent_user_id ? nameOf(d, o.agent_user_id) : 'No owner (pool)'}</td>
                  <td className="num">{count(o.open)}</td>
                  <td className="num">{count(o.overdue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Section>
      <div className="cols">
        <Section title="Abandonment" id="abandonment">
          <dl className="facts">
            <dt>In the window</dt>
            <dd>
              {rateText(abandonment)} ({count(abandoned)} of {count(answered)} answered)
            </dd>
            <dt>Ceiling</dt>
            <dd>{pct(h.abandonment.ceiling_pct, 2)}</dd>
            <dt>Auto-pauses</dt>
            <dd>
              {h.abandonment.auto_pauses.length === 0
                ? 'None'
                : h.abandonment.auto_pauses.map((p) => `${dateTime(p.at, zone)}${p.measured_pct === null ? '' : ` at ${pct(p.measured_pct)}`}`).join('; ')}
            </dd>
          </dl>
        </Section>
        <Section title="Dialling problems" id="problems">
          <dl className="facts">
            <dt>Concurrency limit</dt>
            <dd>{plural(h.concurrency_limit_minutes, 'minute')} at the limit</dd>
            <dt>Carrier failures</dt>
            <dd>
              {count(h.carrier_failures)}
              {h.carrier_failures_by_code.length ? ` (${h.carrier_failures_by_code.map((c) => `${c.error_code ?? 'no code'}: ${count(c.count)}`).join(', ')})` : ''}
            </dd>
            <dt>Retired, our fault</dt>
            <dd>{count(h.our_fault_retired)}</dd>
            <dt>Blocked before dialling</dt>
            <dd>
              {count(h.predial_blocks.dnc)} Do Not Call · {count(h.predial_blocks.invalid)} invalid · {count(h.predial_blocks.outside_calling_hours_deferrals)} deferred to calling hours
            </dd>
            <dt>Recorded</dt>
            <dd>
              {rateText(recorded)} of connected calls ({count(h.recording.recorded)} of {count(h.recording.connected)})
            </dd>
          </dl>
        </Section>
      </div>
      <Section title="Stalls" aside="minutes running without dialling" id="stalls">
        {stalls.length === 0 ? (
          <p className="empty">No stalls in this window.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Reason</th>
                <th className="num">Minutes</th>
              </tr>
            </thead>
            <tbody>
              {stalls
                .sort((a, b) => b[1] - a[1])
                .map(([k, m]) => (
                  <tr key={k}>
                    <td>{STALL_WORDS[k] ?? k}</td>
                    <td className="num">{count(m)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
        {h.stalls.episodes.length > 0 ? (
          <p className="small muted" style={{ marginTop: 5 }}>
            Longest episodes:{' '}
            {[...h.stalls.episodes]
              .sort((a, b) => b.minutes - a.minutes)
              .slice(0, 3)
              .map((e) => `${STALL_WORDS[e.reason] ?? e.reason}, ${dateTime(e.started_at, zone)} for ${plural(e.minutes, 'minute')}`)
              .join('; ')}
            {h.stalls.episodes_truncated ? ' (list shortened)' : ''}.
          </p>
        ) : null}
      </Section>
      <Section title="Caller IDs" id="caller-ids">
        <table>
          <thead>
            <tr>
              <th>Caller ID</th>
              <th className="num">Dials</th>
              <th className="num">First dials</th>
              <th className="num">Connected</th>
              <th className="num">People reached</th>
              <th className="num">Connect rate</th>
            </tr>
          </thead>
          <tbody>
            {h.caller_ids.map((c) => (
              <tr key={c.caller_id}>
                <td className="mono">{c.caller_id}</td>
                <td className="num">{count(c.dials)}</td>
                <td className="num">{count(c.first_dials)}</td>
                <td className="num">{count(c.connected)}</td>
                <td className="num">{count(c.human_connects)}</td>
                <RateCell rate={rate(c.human_connects, c.first_dials, floor)} />
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {h.analysis ? (
        <Section title="Call analysis" aside={plural(h.analysis.analysed, 'analysed call')} id="analysis">
          <p>
            Positive {count(h.analysis.sentiment.positive)} · neutral {count(h.analysis.sentiment.neutral)} · negative {count(h.analysis.sentiment.negative)}
            {h.analysis.top_topics.length ? `. Top topics: ${h.analysis.top_topics.slice(0, 5).map((t) => `${t.topic} (${count(t.count)})`).join(', ')}` : ''}.
          </p>
        </Section>
      ) : null}
    </div>
  );
}

function nameOf(d: CampaignReportDataset, id: string): string {
  return d.agent_names[id] ?? unknownUser(id);
}

function busiest(b: CampaignReportDataset['trends']['buckets'], dates: string[]): string {
  let best = -1;
  for (let i = 0; i < b.length; i++) if (best < 0 || b[i]!.dials > b[best]!.dials) best = i;
  return best < 0 || b[best]!.dials === 0 ? 'none' : `${dayLabel(dates[best]!)} (${count(b[best]!.dials)} dials)`;
}

/** A long duration in days and hours: `5 days 4 hours`, `3 hours`. */
function etaWords(seconds: number): string {
  const hours = Math.round(seconds / 3600);
  if (hours < 1) return duration(seconds);
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  if (days === 0) return plural(rest, 'hour');
  return rest === 0 ? plural(days, 'day') : `${plural(days, 'day')} ${plural(rest, 'hour')}`;
}
