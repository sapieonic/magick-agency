/**
 * The building blocks every template shares: the document shell, the page header, KPI tiles,
 * rate cells (a rate without enough calls is words, never 0), legends and the definitions page.
 */
import type { ReactNode } from 'react';
import type { ReportDatasetBase } from '@magick-agency/contracts/reports';
import { rateText, type Rate } from '../format';
import { BASE_CSS } from './styles';

export function Doc({ title, fontsCss, children }: { title: string; fontsCss: string; children: ReactNode }) {
  return (
    <html lang="en-GB">
      <head>
        <meta charSet="utf-8" />
        <title>{title}</title>
        <style dangerouslySetInnerHTML={{ __html: `${fontsCss}\n${BASE_CSS}` }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

export function PageHeader({ tag, title, sub, meta, compact }: { tag: string; title: string; sub?: ReactNode; meta: string[]; compact?: boolean }) {
  return (
    <header className={compact ? 'ph compact' : 'ph'}>
      <div>
        <div className="tag">{tag}</div>
        <div className="nm">{title}</div>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
      <div className="meta">
        {meta.map((m, i) => (
          <div key={i}>{m}</div>
        ))}
      </div>
    </header>
  );
}

export function Notes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="notes" data-block="notes">
      {notes.map((n, i) => (
        <p key={i}>{n}</p>
      ))}
    </div>
  );
}

export interface KpiProps {
  label: string;
  /** The figure; with `words` set, it is a sentence in place of a number. */
  value: string;
  words?: boolean;
  detail?: string;
  id?: string;
}

export function Kpi({ label, value, words, detail, id }: KpiProps) {
  return (
    <div className="kpi" data-kpi={id}>
      <div className={words ? 'v words' : 'v'}>{value}</div>
      <div className="l">{label}</div>
      {detail ? <div className="d">{detail}</div> : null}
    </div>
  );
}

/** A KPI whose value is a rate: the percentage, or the words. */
export function rateKpi(label: string, rate: Rate, detail: string | undefined, id?: string): KpiProps {
  return { label, value: rateText(rate), words: rate.kind !== 'value', detail: rate.kind === 'value' ? detail : rate.kind === 'withheld' ? detail : undefined, id };
}

export function Kpis({ items, four }: { items: KpiProps[]; four?: boolean }) {
  return (
    <div className={four ? 'kpis four' : 'kpis'}>
      {items.map((k, i) => (
        <Kpi key={i} {...k} />
      ))}
    </div>
  );
}

/** A table cell holding a rate. */
export function RateCell({ rate }: { rate: Rate }) {
  return <td className="num">{rate.kind === 'value' ? rateText(rate) : <span className="words">{rateText(rate)}</span>}</td>;
}

export function Section({ title, aside, children, flow, id }: { title: string; aside?: string; children: ReactNode; flow?: boolean; id?: string }) {
  return (
    <section className={flow ? 'flow' : undefined} data-block={id}>
      <h2>
        {title}
        {aside ? <span className="aside"> · {aside}</span> : null}
      </h2>
      {children}
    </section>
  );
}

export function Legend({ items }: { items: Array<{ colour: string; label: string; value?: string }> }) {
  return (
    <div className="lg">
      {items.map((it, i) => (
        <span key={i}>
          <i style={{ background: it.colour }} />
          {it.label}
          {it.value ? (
            <>
              {' '}
              <b>{it.value}</b>
            </>
          ) : null}
        </span>
      ))}
    </div>
  );
}

/** The last page: what every figure means, then the run's notes. */
export function DefinitionsPage({ dataset, header, floorsLine }: { dataset: ReportDatasetBase; header: ReactNode; floorsLine: string }) {
  return (
    <div className="page" data-page="definitions">
      {header}
      <Section title="Definitions" id="definitions">
        <dl className="defs">
          {dataset.definitions.map((d) => (
            <DefinitionRow key={d.key} label={d.label} text={d.text} />
          ))}
        </dl>
      </Section>
      <Section title="About these figures" id="about">
        <p>{floorsLine}</p>
        <p className="muted" style={{ marginTop: 4 }}>
          A rate without enough calls behind it is written in words rather than as a number. Dates and times are in {dataset.range.timezone}.
        </p>
      </Section>
      {dataset.notes.length > 0 ? (
        <Section title="Notes on this run" id="run-notes">
          {dataset.notes.map((n, i) => (
            <p key={i} style={{ marginTop: i ? 3 : 0 }}>
              {n}
            </p>
          ))}
        </Section>
      ) : null}
    </div>
  );
}

function DefinitionRow({ label, text }: { label: string; text: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{text}</dd>
    </>
  );
}

/** A display name, or the id marked as one when the name no longer resolves. */
export function NameOrId({ name, id }: { name: string | null | undefined; id: string | null }) {
  if (name) return <>{name}</>;
  if (id === null) return <span className="muted">Not reserved to an agent</span>;
  return <span className="idref">Unknown user {id.slice(0, 8)}</span>;
}
