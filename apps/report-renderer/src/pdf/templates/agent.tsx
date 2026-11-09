/**
 * The agent performance review as pages: (1) presence and time, (2) the representative day,
 * outcomes, the floor and follow-through, (3) per campaign, (4) definitions and notes. The `self`
 * audience's dataset carries no benchmark and no quality block (RP5); those sections are not
 * drawn at all, not drawn empty.
 */
import type { ReactNode } from 'react';
import type { AgentReviewDataset } from '@magick-agency/contracts/reports';
import {
  average,
  clockTime,
  count,
  dayLabel,
  dateTime,
  dayHours,
  duration,
  hoursIntoDay,
  pct,
  plural,
  rangeLabel,
  rate,
  rateText,
  rateValue,
  servedRate,
  share,
  shortDate,
  wallClockInto,
  type Rate,
} from '../../format';
import { bandDomain, FloorBands, SplitBar, StackedColumns, TimelineStrip, tickEvery, type BandRow } from '../charts';
import { agentConnectRate, agentSuccessRate, rosterSuccessReportable } from '../../rates';
import { DefinitionsPage, Kpis, Legend, Notes, PageHeader, RateCell, Section, rateKpi, type KpiProps } from '../components';
import { STATE_COLOURS } from '../styles';

const STATE_LABELS = { on_call: 'On a call', wrapup: 'Wrap-up', available: 'Idle, waiting', break: 'Break', offline: 'Logged out' } as const;

export function AgentReview({ d }: { d: AgentReviewDataset }) {
  const zone = d.range.timezone;
  const self = d.audience === 'self';
  const meta = [`${rangeLabel(d.range.from, d.range.to)} (${plural(d.range.days, 'day')})`, zone, `Generated ${dateTime(d.generated_at, zone)}`];
  const small = (title: string) => <PageHeader compact tag={self ? 'Agent performance review · own copy' : 'Agent performance review'} title={title} meta={[rangeLabel(d.range.from, d.range.to), d.agent.name]} />;
  return (
    <>
      <PresencePage d={d} meta={meta} self={self} />
      <CallsPage d={d} header={small('Calls, outcomes and follow-through')} />
      <CampaignsPage d={d} header={small('By campaign')} />
      <DefinitionsPage
        dataset={d}
        header={small('Definitions')}
        floorsLine={`Agent rates (connect rate, success rate) are not quoted below ${count(d.floors.agent_rate_min_first_dials)} first dials or connected calls, the roster’s floor.`}
      />
    </>
  );
}

function PresencePage({ d, meta, self }: { d: AgentReviewDataset; meta: string[]; self: boolean }) {
  const zone = d.range.timezone;
  const p = d.presence;
  const station = p.station_seconds;
  const firstDials = d.daily.reduce((s, r) => s + r.first_dials, 0);
  const humans = d.daily.reduce((s, r) => s + r.human_connects, 0);
  const connectRate = agentConnectRate(d);
  const talkAvg = average(d.record.talk_seconds, d.record.connected);
  const wrapAvg = average(d.record.wrapup_seconds, d.record.connected);
  const talkShare = share(d.record.talk_seconds, station);
  const handling = d.occupancy.handling_pct;
  const campaignsWord = plural(d.campaigns.length, 'campaign');

  const kpis: KpiProps[] = [
    {
      id: 'station',
      label: 'Time on station',
      value: duration(station),
      detail: p.days_worked > 0 ? `${plural(p.days_worked, 'day')} worked · ${duration(station / p.days_worked)}/day` : 'No days worked',
    },
    { id: 'talk', label: 'Talking (agent leg)', value: duration(d.record.talk_seconds), detail: talkShare === null ? undefined : `${pct(talkShare)} of station time` },
    handling === null
      ? { id: 'occupancy', label: 'Occupancy (talk + wrap-up ÷ station)', value: 'Not measured in this window', words: true }
      : { id: 'occupancy', label: 'Occupancy (talk + wrap-up ÷ station)', value: pct(handling), detail: 'the roster’s figure' },
    { id: 'connected', label: 'Calls connected', value: count(d.record.connected), detail: `of ${plural(d.record.attempts, 'dial')}` },
    rateKpi('Connect rate', connectRate, connectRate.kind === 'value' ? `${count(humans)} people / ${count(firstDials)} first dials` : `${plural(firstDials, 'first dial')}, floor ${d.floors.agent_rate_min_first_dials}`, 'connect_rate'),
    d.record.aht_seconds === null
      ? { id: 'aht', label: 'Average handle time', value: 'No connected calls', words: true }
      : {
          id: 'aht',
          label: 'Average handle time',
          value: duration(d.record.aht_seconds),
          detail: talkAvg !== null ? `talk ${duration(talkAvg)} + wrap ${duration(wrapAvg ?? 0)}` : undefined,
        },
  ];

  const parts = (['on_call', 'wrapup', 'available', 'break'] as const).map((k) => ({ key: k, label: STATE_LABELS[k], value: p.by_state[k], colour: STATE_COLOURS[k] }));
  const onCallAside =
    d.occupancy.on_call_pct === null
      ? undefined
      : `on a call ${pct(d.occupancy.on_call_pct)} of station time${d.occupancy.on_call_pct_excl_break === null ? '' : `, ${pct(d.occupancy.on_call_pct_excl_break)} excluding breaks`}`;

  const worked = d.daily.filter((r) => r.station_s > 0);
  const weekend = (date: string) => {
    const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
    return wd === 0 || wd === 6;
  };
  const every = tickEvery(d.daily.length);

  return (
    <div className="page" data-page="presence">
      <PageHeader
        tag={self ? 'Agent performance review · own copy' : 'Agent performance review'}
        title={d.agent.name}
        sub={`Account: ${d.account?.name ?? d.tenant.name} · ${campaignsWord} · this account’s sessions only`}
        meta={meta}
      />
      <Notes notes={d.notes} />
      <Section title="The window in numbers" id="kpis">
        <Kpis items={kpis} />
      </Section>
      <Section title="Where station time went" aside={onCallAside} id="split">
        {station > 0 ? (
          <>
            <SplitBar id="states" parts={parts} title={`Station time by state: ${parts.map((x) => `${x.label} ${duration(x.value)}`).join(', ')}`} />
            <Legend items={parts.map((x) => ({ colour: x.colour, label: x.label, value: `${duration(x.value)} (${pct(share(x.value, station) ?? 0, 0)})` }))} />
            {p.break_by_reason.length > 0 ? (
              <p className="small muted" style={{ marginTop: 5 }}>
                Breaks by reason: {p.break_by_reason.map((b) => `${b.label} ${duration(b.seconds)}`).join(' · ')}
              </p>
            ) : null}
          </>
        ) : (
          <p className="empty">No time on station in this window.</p>
        )}
      </Section>
      {station > 0 ? (
        <Section title="Hours on station per day, by state" id="daily">
          <StackedColumns
            title="Station hours per day by state"
            unit="h"
            scale={1 / 3600}
            series={parts.map((x) => ({ label: x.label, colour: x.colour }))}
            columns={d.daily.map((r, i) => ({
              label: shortDate(r.date),
              tick: i % every === 0,
              shade: weekend(r.date),
              values: [r.on_call_s, r.wrapup_s, r.available_s, r.break_s],
              title: `${dayLabel(r.date)}: station ${duration(r.station_s)}`,
            }))}
          />
          <Legend items={parts.map((x) => ({ colour: x.colour, label: x.label }))} />
        </Section>
      ) : null}
      <Section title="Station sessions" aside="one row per day worked" flow id="sessions">
        {worked.length === 0 ? (
          <p className="empty">No sessions in this window.</p>
        ) : (
          <table className="tight">
            <thead>
              <tr>
                <th>Day</th>
                <th>First in</th>
                <th>Last out</th>
                <th className="num">Sessions</th>
                <th className="num">Station</th>
                <th className="num">Talk</th>
                <th className="num">Breaks</th>
                <th className="num">Dials</th>
                <th className="num">Drops</th>
              </tr>
            </thead>
            <tbody>
              {worked.map((r) => (
                <tr key={r.date}>
                  <td>{dayLabel(r.date)}</td>
                  <td className="mono">{r.first_in ? clockTime(r.first_in, zone) : '—'}</td>
                  <td className="mono">{r.last_out ? clockTime(r.last_out, zone) : '—'}</td>
                  <td className="num">{count(r.sessions)}</td>
                  <td className="num">{duration(r.station_s)}</td>
                  <td className="num">{duration(r.talk_s)}</td>
                  <td className="num">{duration(r.break_s)}</td>
                  <td className="num">{count(r.dials)}</td>
                  <td className="num">{count(r.drops)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="small muted" style={{ marginTop: 5 }}>
          Drops are station connections that ended without the agent leaving ({count(p.drops)} in the window). Every join and leave is in the workbook’s Sessions sheet.
        </p>
      </Section>
    </div>
  );
}

function CallsPage({ d, header }: { d: AgentReviewDataset; header: ReactNode }) {
  const zone = d.range.timezone;
  const conversations = d.outcomes.reduce((s, o) => s + o.conversations, 0);
  const shown = d.outcomes.length > 9 ? d.outcomes.slice(0, 8) : d.outcomes;
  const rest = d.outcomes.slice(shown.length);
  const ft = d.follow_through;
  const cb = ft.callbacks;
  return (
    <div className="page cont" data-page="calls">
      {header}
      {d.timeline ? <TimelineSection d={d} zone={zone} /> : <p className="empty">No time on station in this window, so there is no day to draw.</p>}
      <Section title="Outcomes of conversations" aside={`${count(conversations)}; a redial chain counts once`} id="outcomes">
        {d.outcomes.length === 0 ? (
          <p className="empty">No conversations in this window.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Outcome</th>
                <th className="num">Conversations</th>
                <th className="num">Share</th>
                <th className="num">Average talk</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <tr key={String(o.code)}>
                  <td>
                    {o.label}
                    {o.is_success ? <span className="tagok">SUCCESS</span> : null}
                  </td>
                  <td className="num">{count(o.conversations)}</td>
                  <td className="num">{o.share_pct === null ? <span className="words">No conversations</span> : pct(o.share_pct)}</td>
                  <td className="num">{o.avg_talk_s === null ? '—' : duration(o.avg_talk_s)}</td>
                </tr>
              ))}
              {rest.length > 0 ? (
                <tr>
                  <td>Other outcomes ({rest.length})</td>
                  <td className="num">{count(rest.reduce((s, o) => s + o.conversations, 0))}</td>
                  <td className="num">{conversations > 0 ? pct((rest.reduce((s, o) => s + o.conversations, 0) / conversations) * 100) : '—'}</td>
                  <td className="num">—</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        )}
        <p className="small muted" style={{ marginTop: 5 }}>
          Success rate (successes ÷ connected calls): <b>{rateText(agentSuccessRate(d))}</b>.
        </p>
      </Section>
      {d.benchmark ? <FloorSection d={d} /> : null}
      <Section title="Follow-through" id="follow-through">
        <Kpis
          items={[
            {
              id: 'callbacks',
              label: 'Callbacks booked',
              value: count(cb.booked),
              detail: `${count(cb.on_time)} on time · ${count(cb.late)} late · ${count(cb.missed)} missed · ${count(cb.pending_due)} overdue · ${count(cb.pending_future)} ahead`,
            },
            { id: 'redials', label: 'Wrap-up redials', value: count(ft.redials_placed), detail: `${count(ft.redials_connected)} connected` },
            { id: 'retries', label: 'Agent retries', value: count(ft.agent_retries), detail: `${plural(ft.overrides_used, 'outcome override')} used` },
            { id: 'dnc', label: 'Numbers marked Do Not Call', value: count(ft.dnc_marked) },
            { id: 'softphone', label: 'Soft-phone calls', value: count(ft.softphone_calls), detail: 'outside every campaign count above' },
            { id: 'drops', label: 'Calls ended by a dropped station', value: count(d.presence.drops) },
          ]}
        />
      </Section>
      {d.quality ? <QualitySection q={d.quality} /> : null}
    </div>
  );
}

function TimelineSection({ d, zone }: { d: AgentReviewDataset; zone: string }) {
  const tl = d.timeline!;
  const marks = tl.segments.map((s) => {
    const from = hoursIntoDay(s.start, tl.date, zone);
    const to = hoursIntoDay(s.end, tl.date, zone);
    return { from, to, colour: STATE_COLOURS[s.state], title: `${STATE_LABELS[s.state]} ${clockTime(s.start, zone)}–${clockTime(s.end, zone)}`, state: s.state, start: s.start, end: s.end };
  });
  const on = marks.filter((m) => m.state !== 'offline');
  const first = on[0];
  const last = on.at(-1);
  // Placed by time elapsed since local midnight, so a clock-change day is 23 or 25 hours long.
  const length = dayHours(tl.date, zone);
  const startHour = first ? Math.max(0, Math.floor(first.from) - 0.5) : 0;
  const endHour = last ? Math.min(length, Math.ceil(last.to) + 0.5) : length;
  const row = d.daily.find((r) => r.date === tl.date);
  return (
    <Section title={`A representative day: ${dayLabel(tl.date)}`} aside={row ? `the most time on station, ${duration(row.station_s)}` : undefined} id="timeline">
      <TimelineStrip
        title={`States on ${dayLabel(tl.date)}`}
        marks={marks}
        startHour={startHour}
        endHour={endHour}
        annotations={[
          ...(first ? [{ hour: first.from, text: `↑ first in ${clockTime(first.start, zone)}`, anchor: 'start' as const }] : []),
          ...(last ? [{ hour: last.to, text: `last out ${clockTime(last.end, zone)} ↑`, anchor: 'end' as const }] : []),
        ]}
        hourLabel={(h) => wallClockInto(h, tl.date, zone)}
      />
      {length !== 24 ? (
        <p className="small muted" data-note="clock-change">
          {length > 24
            ? `A ${count(length)}-hour day: the clocks went back, so an hour of the scale appears twice.`
            : `A ${count(length)}-hour day: the clocks went forward, so an hour of the scale is missing.`}
        </p>
      ) : null}
      <Legend items={(['on_call', 'wrapup', 'available', 'break', 'offline'] as const).map((k) => ({ colour: STATE_COLOURS[k], label: STATE_LABELS[k] }))} />
    </Section>
  );
}

function FloorSection({ d }: { d: AgentReviewDataset }) {
  const b = d.benchmark!;
  const c = b.cohort;
  const r = d.roster_row;
  if (b.pool_size === 0) {
    return (
      <Section title="Against the floor" aside="supervisors’ copy only" id="floor">
        <p className="empty">No agent on this account had enough calls in this window to be compared with.</p>
      </Section>
    );
  }
  const connect = r ? servedRate(r.connect_rate_pct, r.rates_reportable) : ({ kind: 'none' } as Rate);
  const succReportable = r ? rosterSuccessReportable(r) : false;
  const success = r ? servedRate(r.success_rate_pct, succReportable) : ({ kind: 'none' } as Rate);
  const aht = r && succReportable ? r.aht_seconds : null;
  const occ = d.occupancy.handling_pct;
  const pctBand = (p: { p25: number | null; median: number | null; p75: number | null }) =>
    p.p25 === null || p.p75 === null ? 'no band' : `floor ${pct(p.p25)}–${pct(p.p75)}, median ${p.median === null ? '—' : pct(p.median)}`;
  const rows: BandRow[] = [
    { label: 'Connect rate', value: rateValue(connect), valueText: rateText(connect), ...c.connect_rate, ...bandDomain([rateValue(connect), c.connect_rate.p25, c.connect_rate.p75]), bandText: pctBand(c.connect_rate) },
    { label: 'Occupancy', value: occ, valueText: occ === null ? 'Not measured' : pct(occ), ...c.occupancy_pct, ...bandDomain([occ, c.occupancy_pct.p25, c.occupancy_pct.p75]), bandText: pctBand(c.occupancy_pct) },
  ];
  if (c.aht) {
    rows.push({
      label: 'Average handle time',
      value: aht,
      valueText: aht === null ? (r ? 'Not enough calls to rate' : 'No connected calls') : duration(aht),
      ...c.aht,
      ...bandDomain([aht, c.aht.p25, c.aht.p75]),
      bandText: c.aht.p25 === null || c.aht.p75 === null ? 'no band' : `floor ${duration(c.aht.p25)}–${duration(c.aht.p75)} (lower is faster)`,
    });
  }
  rows.push({ label: 'Success rate', value: rateValue(success), valueText: rateText(success), ...c.success_rate, ...bandDomain([rateValue(success), c.success_rate.p25, c.success_rate.p75]), bandText: pctBand(c.success_rate) });
  return (
    <Section title="Against the floor" aside={`same window, compared with ${plural(b.pool_size, 'agent')} · supervisors’ copy only`} id="floor">
      <FloorBands rows={rows} title="This agent against the floor’s middle half and median" colour={STATE_COLOURS.on_call} />
      <Legend
        items={[
          { colour: STATE_COLOURS.on_call, label: 'This agent' },
          { colour: '#c3cbd7', label: 'Floor’s middle half (25th–75th percentile)' },
          { colour: '#5a6372', label: 'Floor median (the tick)' },
        ]}
      />
    </Section>
  );
}

function QualitySection({ q }: { q: NonNullable<AgentReviewDataset['quality']> }) {
  const parts = [
    { label: 'Positive', value: q.sentiment.positive, colour: STATE_COLOURS.available },
    { label: 'Neutral', value: q.sentiment.neutral, colour: '#9aa5b5' },
    { label: 'Negative', value: q.sentiment.negative, colour: STATE_COLOURS.wrapup },
    { label: 'Mixed', value: q.sentiment.mixed, colour: STATE_COLOURS.break },
  ];
  return (
    <Section title="Call analysis" aside={`${plural(q.analysed_calls, 'analysed call')} · supervisors’ copy only`} id="quality">
      {q.analysed_calls > 0 ? (
        <>
          <SplitBar id="sentiment" parts={parts} title="Sentiment of analysed calls" height={16} />
          <Legend items={parts.map((p) => ({ colour: p.colour, label: p.label, value: `${count(p.value)} (${pct((p.value / q.analysed_calls) * 100, 0)})` }))} />
        </>
      ) : (
        <p className="empty">No call in this window was analysed.</p>
      )}
    </Section>
  );
}

function CampaignsPage({ d, header }: { d: AgentReviewDataset; header: ReactNode }) {
  const rows = [...d.per_campaign].sort((a, b) => b.attempts - a.attempts);
  const idle = d.campaigns.filter((c) => !d.per_campaign.some((r) => r.campaign_id === c.id));
  const zoneOf = (id: string) => d.campaigns.find((c) => c.id === id)?.timezone ?? '';
  const totalFirst = rows.reduce((s, r) => s + r.first_dials, 0);
  const totalHuman = rows.reduce((s, r) => s + r.human_connects, 0);
  return (
    <div className="page" data-page="campaigns">
      {header}
      <Section title="Per campaign" aside="the agent record’s rows; they sum to the totals" id="per-campaign">
        <table>
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Zone</th>
              <th className="num">Dials</th>
              <th className="num">Connected</th>
              <th className="num">First dials</th>
              <th className="num">People reached</th>
              <th className="num">Connect rate</th>
              <th className="num">Successes</th>
              <th className="num">Talk</th>
              <th className="num">Handle time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const handle = average(r.talk_seconds + r.wrapup_seconds, r.connected);
              return (
                <tr key={r.campaign_id}>
                  <td>{r.campaign_name}</td>
                  <td className="small muted">{zoneOf(r.campaign_id)}</td>
                  <td className="num">{count(r.attempts)}</td>
                  <td className="num">{count(r.connected)}</td>
                  <td className="num">{count(r.first_dials)}</td>
                  <td className="num">{count(r.human_connects)}</td>
                  <RateCell rate={servedRate(r.connect_rate_pct, r.rates_reportable)} />
                  <td className="num">{count(r.successes)}</td>
                  <td className="num">{duration(r.talk_seconds)}</td>
                  <td className="num">{handle === null ? '—' : duration(handle)}</td>
                </tr>
              );
            })}
            {idle.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="small muted">{c.timezone}</td>
                <td className="num" colSpan={8}>
                  <span className="words">Logged in without dialling</span>
                </td>
              </tr>
            ))}
            <tr className="total">
              <td colSpan={2}>All campaigns</td>
              <td className="num">{count(d.record.attempts)}</td>
              <td className="num">{count(d.record.connected)}</td>
              <td className="num">{count(totalFirst)}</td>
              <td className="num">{count(totalHuman)}</td>
              <RateCell rate={agentConnectRate(d)} />
              <td className="num">{count(d.record.successes)}</td>
              <td className="num">{duration(d.record.talk_seconds)}</td>
              <td className="num">{d.record.aht_seconds === null ? '—' : duration(d.record.aht_seconds)}</td>
            </tr>
          </tbody>
        </table>
        <p className="small muted" style={{ marginTop: 5 }}>
          A campaign’s connect rate is quoted from {count(d.floors.agent_rate_min_first_dials)} first dials. Handle time is talk plus measured wrap-up per connected call.
        </p>
      </Section>
      <Section title="Day by day" aside="the report’s days, in its zone" flow id="day-by-day">
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th className="num">Dials</th>
              <th className="num">First dials</th>
              <th className="num">Connected</th>
              <th className="num">Conversations</th>
              <th className="num">People reached</th>
              <th className="num">Successes</th>
              <th className="num">Connect rate</th>
            </tr>
          </thead>
          <tbody>
            {d.daily
              .filter((r) => r.dials > 0)
              .map((r) => (
                <tr key={r.date}>
                  <td>{dayLabel(r.date)}</td>
                  <td className="num">{count(r.dials)}</td>
                  <td className="num">{count(r.first_dials)}</td>
                  <td className="num">{count(r.connected)}</td>
                  <td className="num">{count(r.conversations)}</td>
                  <td className="num">{count(r.human_connects)}</td>
                  <td className="num">{count(r.successes)}</td>
                  <RateCell rate={rate(r.human_connects, r.first_dials, d.floors.agent_rate_min_first_dials)} />
                </tr>
              ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
