/**
 * The account report: (1) totals and the campaigns side by side; (2) the account's days and its
 * agents against the floor; (3) health per campaign; (4) definitions. Rates of the totals come
 * from the summed counts, never from averaging the campaigns' rates.
 */
import type { ReactNode } from 'react';
import type { AccountReportDataset, AccountReportFigures } from '@magick-agency/contracts/reports';
import { average, count, dateTime, dayLabel, duration, pct, plural, rangeLabel, rate, rateText, servedRate, shortDate, type Rate } from '../../format';
import { StackedColumns } from '../charts';
import { DefinitionsPage, Kpis, Legend, NameOrId, Notes, PageHeader, RateCell, Section, rateKpi } from '../components';
import { INK, STATE_COLOURS } from '../styles';

const STATUS_WORDS: Record<string, string> = { draft: 'Draft', running: 'Running', paused: 'Paused', stopping: 'Stopping', completed: 'Completed', stopped: 'Stopped' };

function firstDials(f: AccountReportFigures): number {
  return f.calls.dials - f.calls.redials.placed;
}

export function AccountReport({ d }: { d: AccountReportDataset }) {
  const small = (title: string) => <PageHeader compact tag="Account report" title={title} meta={[rangeLabel(d.range.from, d.range.to), d.account.name]} />;
  return (
    <>
      <OverviewPage d={d} />
      <AgentsPage d={d} header={small('Days and agents')} />
      <HealthPage d={d} header={small('Health by campaign')} />
      <DefinitionsPage
        dataset={d}
        header={small('Definitions')}
        floorsLine={`Campaign and account rates are not quoted below ${count(d.floors.campaign_rate_min_first_dials)} in their denominator (the Insights floor); agent rates and floor bands use the roster’s floor of ${count(d.floors.agent_rate_min_first_dials)} first dials.`}
      />
    </>
  );
}

function OverviewPage({ d }: { d: AccountReportDataset }) {
  const zone = d.range.timezone;
  const t = d.totals;
  const floor = d.floors.campaign_rate_min_first_dials;
  const fd = firstDials(t);
  const byStatus = new Map<string, number>();
  for (const c of d.campaigns) byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);
  return (
    <div className="page" data-page="overview">
      <PageHeader
        tag="Account report"
        title={d.account.name}
        sub={`${plural(d.campaigns.length, 'campaign')}: ${[...byStatus.entries()].map(([s, n]) => `${count(n)} ${STATUS_WORDS[s]?.toLowerCase() ?? s}`).join(', ')} (as of generation)`}
        meta={[`${rangeLabel(d.range.from, d.range.to)} (${plural(d.range.days, 'day')})`, zone, `Generated ${dateTime(d.generated_at, zone)}`]}
      />
      <Notes notes={d.notes} />
      <Section title="The window in numbers" aside="every campaign summed" id="kpis">
        <Kpis
          items={[
            { id: 'dials', label: 'Dials', value: count(t.calls.dials), detail: `${count(fd)} first dials` },
            { id: 'connected', label: 'Connected', value: count(t.calls.connected), detail: `${count(t.calls.conversations)} conversations` },
            rateKpi('Connect rate', rate(t.calls.human_connects, fd, floor), `${count(t.calls.human_connects)} people / ${count(fd)} first dials`, 'connect_rate'),
            rateKpi('Success rate', rate(t.calls.successes, t.calls.conversations, floor), `${count(t.calls.successes)} successes / ${count(t.calls.conversations)} conversations`, 'success_rate'),
            rateKpi('Abandonment', rate(t.abandoned, t.answered, floor), `${count(t.abandoned)} of ${count(t.answered)} answered`, 'abandonment'),
            { id: 'callbacks', label: 'Callbacks booked', value: count(t.callbacks_booked), detail: `${duration(t.calls.talk_seconds)} talking` },
          ]}
        />
      </Section>
      <Section title="Campaigns" aside="rates from each campaign’s own counts" id="campaigns">
        <table>
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Status</th>
              <th className="num">Dials</th>
              <th className="num">Connected</th>
              <th className="num">Connect rate</th>
              <th className="num">Conver&shy;sations</th>
              <th className="num">Successes</th>
              <th className="num">Success rate</th>
              <th className="num">Handle time</th>
              <th className="num">Aban&shy;doned</th>
              <th className="num">Callbacks</th>
            </tr>
          </thead>
          <tbody>
            {d.campaigns.map((c) => (
              <FiguresRow key={c.id} label={c.name} sub={c.timezone !== zone ? c.timezone : undefined} status={STATUS_WORDS[c.status] ?? c.status} f={c} floor={floor} />
            ))}
            <FiguresRow total label="All campaigns" status="" f={t} floor={floor} />
          </tbody>
        </table>
        <p className="small muted" style={{ marginTop: 5 }}>
          Recorded: {rateText(rate(t.recorded, t.recording_connected, 1))} of connected calls across the account ({count(t.recorded)} of {count(t.recording_connected)}). Handle time is average talk plus average measured wrap-up.
        </p>
      </Section>
    </div>
  );
}

function FiguresRow({ label, sub, status, f, floor, total }: { label: string; sub?: string; status: string; f: AccountReportFigures; floor: number; total?: boolean }) {
  const talk = average(f.calls.talk_seconds, f.calls.connected);
  const wrap = average(f.calls.wrapup_seconds, f.calls.wrapup_measured);
  return (
    <tr className={total ? 'total' : undefined}>
      <td>
        {label}
        {sub ? <div className="small muted">{sub}</div> : null}
      </td>
      <td className="small">{status}</td>
      <td className="num">{count(f.calls.dials)}</td>
      <td className="num">{count(f.calls.connected)}</td>
      <RateCell rate={rate(f.calls.human_connects, firstDials(f), floor)} />
      <td className="num">{count(f.calls.conversations)}</td>
      <td className="num">{count(f.calls.successes)}</td>
      <RateCell rate={rate(f.calls.successes, f.calls.conversations, floor)} />
      <td className="num">{talk === null ? '—' : duration(talk + (wrap ?? 0))}</td>
      <RateCell rate={rate(f.abandoned, f.answered, floor)} />
      <td className="num">{count(f.callbacks_booked)}</td>
    </tr>
  );
}

function AgentsPage({ d, header }: { d: AccountReportDataset; header: ReactNode }) {
  const tickEvery = d.daily.length > 16 ? 7 : d.daily.length > 8 ? 2 : 1;
  const totalDials = d.daily.reduce((s, r) => s + r.dials, 0);
  const totalHuman = d.daily.reduce((s, r) => s + r.human_connects, 0);
  const c = d.benchmark.cohort;
  const flag = (value: number | null, band: { p25: number | null; p75: number | null }, lowerIsBetter = false) => {
    if (value === null || band.p25 === null || band.p75 === null) return '';
    if (value > band.p75) return lowerIsBetter ? ' ↑ slower' : ' ↑';
    if (value < band.p25) return lowerIsBetter ? ' ↓ faster' : ' ↓';
    return '';
  };
  const bandCell = (p: { p25: number | null; median: number | null; p75: number | null }, fmt: (v: number) => string) =>
    p.p25 === null || p.p75 === null ? <span className="words">No band</span> : `${fmt(p.p25)} · ${p.median === null ? '—' : fmt(p.median)} · ${fmt(p.p75)}`;
  return (
    <div className="page" data-page="agents">
      {header}
      <Section title="Dials by day" aside={`every campaign, in days of ${d.range.timezone}`} id="daily">
        <StackedColumns
          title="Dials by day across the account, people reached at the bottom"
          unit=""
          series={[
            { label: 'People reached', colour: STATE_COLOURS.on_call },
            { label: 'Other dials', colour: INK.rest },
          ]}
          columns={d.daily.map((r, i) => ({
            label: shortDate(r.date),
            tick: i % tickEvery === 0,
            values: [r.human_connects, Math.max(0, r.dials - r.human_connects)],
            title: `${dayLabel(r.date)}: ${count(r.dials)} dials, ${count(r.human_connects)} people reached, ${r.agents_online_peak === null ? 'peak agents not measured' : `${count(r.agents_online_peak)} agents at the peak`}`,
          }))}
        />
        <Legend
          items={[
            { colour: STATE_COLOURS.on_call, label: 'People reached', value: count(totalHuman) },
            { colour: INK.rest, label: 'Other dials', value: count(totalDials - totalHuman) },
          ]}
        />
      </Section>
      <Section title="Agents" aside={`the account roster; floor bands over ${plural(d.benchmark.pool_size, 'agent')} with at least ${d.floors.agent_rate_min_first_dials} first dials`} flow id="agents">
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th className="num">Campaigns</th>
              <th className="num">Dials</th>
              <th className="num">Connected</th>
              <th className="num">Connect rate</th>
              <th className="num">Success rate</th>
              <th className="num">Handle time</th>
              <th className="num">Occupancy</th>
              <th className="num">On station</th>
            </tr>
          </thead>
          <tbody>
            <tr className="floor">
              <td colSpan={4}>Floor: 25th percentile · median · 75th percentile</td>
              <td className="num">{bandCell(c.connect_rate, (v) => pct(v))}</td>
              <td className="num">{bandCell(c.success_rate, (v) => pct(v))}</td>
              <td className="num">{c.aht ? bandCell(c.aht, (v) => duration(v)) : <span className="words">No band</span>}</td>
              <td className="num">{bandCell(c.occupancy_pct, (v) => pct(v))}</td>
              <td />
            </tr>
            {d.agents.map((a) => {
              const succOk = a.success_rate_reportable ?? a.rates_reportable;
              const connect: Rate = servedRate(a.connect_rate_pct, a.rates_reportable);
              const success: Rate = servedRate(a.success_rate_pct, succOk);
              return (
                <tr key={a.agent_user_id}>
                  <td>
                    <NameOrId name={a.agent_name} id={a.agent_user_id} />
                  </td>
                  <td className="num">{count(a.campaigns)}</td>
                  <td className="num">{count(a.attempts)}</td>
                  <td className="num">{count(a.connected)}</td>
                  <td className="num">
                    {connect.kind === 'value' ? `${rateText(connect)}${flag(connect.pct, c.connect_rate)}` : <span className="words">{rateText(connect)}</span>}
                  </td>
                  <td className="num">
                    {success.kind === 'value' ? `${rateText(success)}${flag(success.pct, c.success_rate)}` : <span className="words">{rateText(success)}</span>}
                  </td>
                  <td className="num">{a.aht_seconds === null || !succOk ? <span className="words">{a.aht_seconds === null ? 'No connected calls' : 'Not enough calls to rate'}</span> : `${duration(a.aht_seconds)}${c.aht ? flag(a.aht_seconds, c.aht, true) : ''}`}</td>
                  <td className="num">{a.occupancy_pct === null ? <span className="words">Not measured</span> : `${pct(a.occupancy_pct)}${a.rates_reportable ? flag(a.occupancy_pct, c.occupancy_pct) : ''}`}</td>
                  <td className="num">{duration(a.shift_seconds)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="small muted" style={{ marginTop: 5 }}>
          ↑ above the floor’s middle half, ↓ below it (for handle time, ↑ is slower). The floor’s pooled connect rate is {c.connect_rate_pct === null ? 'not measured' : pct(c.connect_rate_pct)}
          {d.benchmark.pool_size === 0 ? '; no agent had enough calls for bands' : ''}.
        </p>
      </Section>
    </div>
  );
}

function HealthPage({ d, header }: { d: AccountReportDataset; header: ReactNode }) {
  const name = (id: string) => d.campaigns.find((c) => c.id === id)?.name ?? id;
  return (
    <div className="page" data-page="health">
      {header}
      <Section title="Health by campaign" id="health">
        <table>
          <thead>
            <tr>
              <th>Campaign</th>
              <th className="num">Auto-pauses</th>
              <th className="num">Stall minutes</th>
              <th>Main stall reason</th>
              <th className="num">At concurrency limit</th>
              <th className="num">Carrier failures</th>
              <th className="num">Retired, our fault</th>
              <th className="num">Blocked: DNC</th>
              <th className="num">Blocked: invalid</th>
            </tr>
          </thead>
          <tbody>
            {d.health.map((h) => {
              const stalls = Object.entries(h.stall_minutes_by_reason).sort((a, b) => b[1] - a[1]);
              const total = stalls.reduce((s, [, m]) => s + m, 0);
              return (
                <tr key={h.campaign_id}>
                  <td>{name(h.campaign_id)}</td>
                  <td className="num">{count(h.auto_pauses)}</td>
                  <td className="num">{count(total)}</td>
                  <td className="small">{total > 0 ? stallWords(stalls[0]![0]) : '—'}</td>
                  <td className="num">{plural(h.concurrency_limit_minutes, 'min', 'min')}</td>
                  <td className="num">{count(h.carrier_failures)}</td>
                  <td className="num">{count(h.our_fault_retired)}</td>
                  <td className="num">{count(h.predial_blocks.dnc)}</td>
                  <td className="num">{count(h.predial_blocks.invalid)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
      <Section title="Peak agents online per day" aside="distinct agents across the account at the day’s busiest moment" id="peaks">
        <p>
          {d.daily
            .filter((r) => r.dials > 0)
            .map((r) => `${shortDate(r.date)} ${r.agents_online_peak === null ? 'not measured' : count(r.agents_online_peak)}`)
            .join(' · ')}
        </p>
      </Section>
    </div>
  );
}

function stallWords(k: string): string {
  return (
    {
      no_agents: 'No agents available',
      no_slots: 'No call slots free',
      no_contacts: 'No contacts left',
      no_reservations: 'No agent could be reserved',
      no_caller_ids: 'No caller ID',
      nothing_due: 'Nothing due yet',
      outside_calling_hours: 'Outside calling hours',
    } as Record<string, string>
  )[k] ?? k;
}
