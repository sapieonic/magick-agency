/**
 * The campaign report: the Insights tab as a document. (1) the headline as of generation and the
 * window's figures, calls and outcomes; (2) trends by day, best hours and the agents; (3)
 * callbacks and health; (4) definitions. Insights serves counts: every rate here is derived from
 * the counts beside it and withheld below `floors.campaign_rate_min_first_dials` (RP9).
 */
import type { ReactNode } from 'react';
import type { CampaignReportDataset } from '@magick-agency/contracts/reports';
import { average, bucketDate, count, dateTime, dayLabel, duration, pct, plural, rangeLabel, rate, rateText, share, shortDate, type Rate } from '../../format';
import { HourColumns, StackedColumns } from '../charts';
import { DefinitionsPage, Kpis, Legend, NameOrId, Notes, PageHeader, RateCell, Section, rateKpi } from '../components';
import { INK, STATE_COLOURS } from '../styles';

const STATUS_WORDS: Record<CampaignReportDataset['campaign']['status'], string> = {
  draft: 'Draft',
  running: 'Running',
  paused: 'Paused',
  stopping: 'Stopping',
  completed: 'Completed',
  stopped: 'Stopped',
};
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
      <OverviewPage d={d} floor={floor} />
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

function OverviewPage({ d, floor }: { d: CampaignReportDataset; floor: number }) {
  const zone = d.range.timezone;
  const calls = d.activity.calls;
  const firstDials = calls.dials - calls.redials.placed;
  const answered = d.trends.buckets.reduce((s, b) => s + b.answered, 0);
  const abandoned = d.trends.buckets.reduce((s, b) => s + b.abandoned, 0);
  const connect = rate(calls.human_connects, firstDials, floor);
  const success = rate(calls.successes, calls.conversations, floor);
  const abandonment = rate(abandoned, answered, floor);
  const talk = average(calls.talk_seconds, calls.connected);
  const wrap = average(calls.wrapup_seconds, calls.wrapup_measured);
  const conversations = calls.conversations;
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
            rateKpi('Connect rate', connect, `${count(calls.human_connects)} people / ${count(firstDials)} first dials`, 'connect_rate'),
            rateKpi('Success rate', success, `${count(calls.successes)} successes / ${count(conversations)} conversations`, 'success_rate'),
            rateKpi('Abandonment', abandonment, `${count(abandoned)} of ${count(answered)} answered`, 'abandonment'),
            talk === null
              ? { id: 'aht', label: 'Average handle time', value: 'No connected calls', words: true }
              : { id: 'aht', label: 'Average handle time', value: duration(talk + (wrap ?? 0)), detail: `talk ${duration(talk)} + wrap ${wrap === null ? 'not measured' : duration(wrap)}` },
          ]}
        />
      </Section>
      <Section title="Outcomes" aside={`over ${count(conversations)} conversations`} id="outcomes">
        {d.activity.outcomes.length === 0 ? (
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
    </div>
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
  const tickEvery = b.length > 16 ? 7 : b.length > 8 ? 2 : 1;
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
            tick: i % tickEvery === 0,
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
  const answered = d.trends.buckets.reduce((s, b) => s + b.answered, 0);
  const abandoned = d.trends.buckets.reduce((s, b) => s + b.abandoned, 0);
  const recorded: Rate = rate(h.recording.recorded, h.recording.connected, 1);
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
              {rateText(rate(abandoned, answered, floor))} ({count(abandoned)} of {count(answered)} answered)
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
  const n = d.agent_names[id];
  return n ?? `Unknown user ${id.slice(0, 8)}`;
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
