/**
 * Static SVG charts for print. Drawn at the content width so one unit is one CSS pixel; thin
 * marks, a 2px white gap between stacked segments and adjacent bars, recessive grid and axes,
 * tick labels in IBM Plex Mono with tabular figures. Every chart has a legend with values beside
 * it in the template, and a `<title>` per mark for screen readers of the PDF's tagged text.
 */
import { CONTENT_WIDTH, INK } from './styles';

const MONO = "'IBM Plex Mono', ui-monospace, monospace";
const SANS = "'IBM Plex Sans', system-ui, sans-serif";

// ── Split bar ─────────────────────────────────────────────────────────────────

export interface SplitPart {
  label: string;
  value: number;
  colour: string;
}

/** One horizontal part-to-whole bar, segments separated by 2px gaps, rounded ends. */
export function SplitBar({ id, parts, title, width = CONTENT_WIDTH, height = 22 }: { id: string; parts: SplitPart[]; title: string; width?: number; height?: number }) {
  const shown = parts.filter((p) => p.value > 0);
  const total = shown.reduce((s, p) => s + p.value, 0);
  const gap = 2;
  const usable = width - gap * Math.max(0, shown.length - 1);
  let x = 0;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
      <title>{title}</title>
      <defs>
        <clipPath id={`split-${id}`}>
          <rect x={0} y={0} width={width} height={height} rx={4} />
        </clipPath>
      </defs>
      <g clipPath={`url(#split-${id})`}>
        {shown.map((p, i) => {
          const w = total > 0 ? (p.value / total) * usable : 0;
          const rect = <rect key={i} x={x} y={0} width={Math.max(0.5, w)} height={height} fill={p.colour} />;
          x += w + gap;
          return rect;
        })}
      </g>
    </svg>
  );
}

// ── Axis helpers ──────────────────────────────────────────────────────────────

/** A "nice" tick step for a maximum and a target tick count. */
export function niceStep(max: number, ticks = 4): number {
  if (max <= 0) return 1;
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

// ── Stacked columns (one per day) ─────────────────────────────────────────────

export interface ColumnSeries {
  label: string;
  colour: string;
}
export interface Column {
  /** The x label when shown (`9 Oct`). */
  label: string;
  /** Show the label under this column. */
  tick: boolean;
  /** One value per series, bottom first. */
  values: number[];
  /** A light band behind the column (a weekend, a day off). */
  shade?: boolean;
  title: string;
}

/**
 * Columns stacked bottom to top in series order. `scale` turns a value into axis units (seconds →
 * hours) and `unit` labels the ticks.
 */
export function StackedColumns({
  columns,
  series,
  title,
  unit,
  scale = 1,
  width = CONTENT_WIDTH,
  height = 140,
}: {
  columns: Column[];
  series: ColumnSeries[];
  title: string;
  unit: string;
  scale?: number;
  width?: number;
  height?: number;
}) {
  const left = 40;
  const bottom = height - 20;
  const top = 8;
  const plotH = bottom - top;
  const max = Math.max(0, ...columns.map((c) => c.values.reduce((s, v) => s + v, 0) * scale));
  const step = niceStep(max || 1);
  const yMax = Math.max(step, Math.ceil((max || 1) / step) * step);
  const n = Math.max(1, columns.length);
  const slot = (width - left) / n;
  const barW = Math.max(2, Math.min(18, slot - 2));
  const y = (v: number) => bottom - (v / yMax) * plotH;
  const ticks: number[] = [];
  for (let t = 0; t <= yMax + 1e-9; t += step) ticks.push(Number(t.toFixed(6)));
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
      <title>{title}</title>
      {columns.map((c, i) =>
        c.shade ? <rect key={`s${i}`} x={left + i * slot} y={top} width={slot} height={plotH} fill="#f6f7f9" /> : null,
      )}
      {ticks.map((t) => (
        <g key={`t${t}`}>
          <line x1={left} x2={width} y1={y(t)} y2={y(t)} stroke={t === 0 ? INK.axis : INK.grid} strokeWidth={1} />
          <text x={left - 6} y={y(t) + 3} textAnchor="end" fontSize={9} fill={INK.ink2} fontFamily={MONO}>
            {formatTick(t)}
            {unit}
          </text>
        </g>
      ))}
      {columns.map((c, i) => {
        const x = left + i * slot + (slot - barW) / 2;
        let acc = 0;
        const segs = c.values.map((v, j) => {
          const val = v * scale;
          if (val <= 0) return null;
          const y0 = y(acc);
          const y1 = y(acc + val);
          acc += val;
          // A 2px white gap under every segment but the bottom one.
          const h = Math.max(0, y0 - y1 - (acc - val > 0 ? 2 : 0));
          return <rect key={j} x={x} y={y1} width={barW} height={Math.max(0.5, h)} fill={series[j]!.colour} />;
        });
        return (
          <g key={`c${i}`}>
            <title>{c.title}</title>
            {segs}
          </g>
        );
      })}
      {columns.map((c, i) =>
        c.tick ? (
          <text key={`x${i}`} x={left + i * slot + slot / 2} y={height - 5} textAnchor="middle" fontSize={9} fill={INK.ink2} fontFamily={MONO}>
            {c.label}
          </text>
        ) : null,
      )}
    </svg>
  );
}

function formatTick(t: number): string {
  if (t >= 1000) return new Intl.NumberFormat('en-IN').format(t);
  return String(Number(t.toFixed(2)));
}

// ── Day timeline ─────────────────────────────────────────────────────────────

export interface TimelineMark {
  /** Hours since local midnight. */
  from: number;
  to: number;
  colour: string;
  title: string;
}

/** One day as a strip of state intervals, hour ticks under it, joined/left annotations. */
export function TimelineStrip({
  marks,
  startHour,
  endHour,
  title,
  annotations,
  width = CONTENT_WIDTH,
}: {
  marks: TimelineMark[];
  startHour: number;
  endHour: number;
  title: string;
  annotations: Array<{ hour: number; text: string; anchor: 'start' | 'end' }>;
  width?: number;
}) {
  const left = 4;
  const right = width - 4;
  const height = 64;
  const x = (h: number) => left + ((Math.min(endHour, Math.max(startHour, h)) - startHour) / (endHour - startHour)) * (right - left);
  const hours: number[] = [];
  for (let h = Math.ceil(startHour); h <= Math.floor(endHour); h++) hours.push(h);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
      <title>{title}</title>
      <rect x={left} y={4} width={right - left} height={26} fill="#f6f7f9" />
      {marks.map((m, i) =>
        m.to > startHour && m.from < endHour ? (
          <rect key={i} x={x(m.from)} y={4} width={Math.max(0.6, x(m.to) - x(m.from))} height={26} fill={m.colour}>
            <title>{m.title}</title>
          </rect>
        ) : null,
      )}
      {hours.map((h) => (
        <g key={h}>
          <line x1={x(h)} x2={x(h)} y1={32} y2={36} stroke={INK.axis} />
          <text x={x(h)} y={46} textAnchor="middle" fontSize={9} fill={INK.ink2} fontFamily={MONO}>
            {String(h % 24).padStart(2, '0')}
          </text>
        </g>
      ))}
      {annotations.map((a, i) => (
        <text key={`a${i}`} x={x(a.hour)} y={60} textAnchor={a.anchor} fontSize={9} fill={INK.ink} fontFamily={SANS}>
          {a.text}
        </text>
      ))}
    </svg>
  );
}

// ── Floor bands ───────────────────────────────────────────────────────────────

export interface BandRow {
  label: string;
  /** The subject's value; null when it cannot be quoted (the words go in `valueText`). */
  value: number | null;
  valueText: string;
  p25: number | null;
  median: number | null;
  p75: number | null;
  /** Axis domain for the row. */
  min: number;
  max: number;
  /** The band's readout under the label, e.g. "floor 37.4–46.2%, median 41.9%". */
  bandText: string;
}

/** One row per metric: the floor's middle half as a band, its median as a tick, the subject as a dot. */
export function FloorBands({ rows, title, colour, width = CONTENT_WIDTH }: { rows: BandRow[]; title: string; colour: string; width?: number }) {
  const labelW = 150;
  const valueW = 130;
  const plotL = labelW;
  const plotR = width - valueW;
  const rowH = 34;
  const height = rows.length * rowH + 4;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
      <title>{title}</title>
      {rows.map((r, i) => {
        const cy = 14 + i * rowH;
        const sc = (v: number) => plotL + ((Math.min(r.max, Math.max(r.min, v)) - r.min) / (r.max - r.min || 1)) * (plotR - plotL);
        return (
          <g key={i}>
            <text x={0} y={cy + 3} fontSize={10.5} fill={INK.ink} fontFamily={SANS}>
              {r.label}
            </text>
            <text x={0} y={cy + 16} fontSize={8.5} fill={INK.ink2} fontFamily={MONO}>
              {r.bandText}
            </text>
            <line x1={plotL} x2={plotR} y1={cy} y2={cy} stroke={INK.grid} strokeWidth={6} strokeLinecap="round" />
            {r.p25 !== null && r.p75 !== null ? (
              <rect x={sc(r.p25)} y={cy - 5} width={Math.max(2, sc(r.p75) - sc(r.p25))} height={10} rx={5} fill={INK.band}>
                <title>{`Floor middle half ${r.bandText}`}</title>
              </rect>
            ) : null}
            {r.median !== null ? <line x1={sc(r.median)} x2={sc(r.median)} y1={cy - 7} y2={cy + 7} stroke={INK.ink2} strokeWidth={1.5} /> : null}
            {r.value !== null ? <circle cx={sc(r.value)} cy={cy} r={5} fill={colour} stroke="#fff" strokeWidth={2} /> : null}
            <text x={plotR + 12} y={cy + 4} fontSize={r.value === null ? 9 : 10.5} fill={r.value === null ? INK.ink2 : INK.ink} fontFamily={r.value === null ? SANS : MONO} fontStyle={r.value === null ? 'italic' : 'normal'}>
              {r.valueText}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** The axis domain for a band row: the band, the median and the value, padded, never inverted. */
export function bandDomain(values: Array<number | null>, floorAt0 = true): { min: number; max: number } {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  if (v.length === 0) return { min: 0, max: 100 };
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const pad = Math.max((hi - lo) * 0.35, hi * 0.08, 1);
  return { min: floorAt0 ? Math.max(0, lo - pad) : lo - pad, max: hi + pad };
}

// ── Hour columns ──────────────────────────────────────────────────────────────

/** Columns by hour of day, with a direct label over the highlighted ones (the best hours). */
export function HourColumns({
  hours,
  series,
  title,
  width = CONTENT_WIDTH,
  height = 150,
}: {
  hours: Array<{ hour: number; values: number[]; label: string | null; title: string }>;
  series: ColumnSeries[];
  title: string;
  width?: number;
  height?: number;
}) {
  const left = 40;
  const bottom = height - 20;
  const top = 18;
  const plotH = bottom - top;
  const max = Math.max(1, ...hours.map((h) => h.values.reduce((s, v) => s + v, 0)));
  const step = niceStep(max);
  const yMax = Math.ceil(max / step) * step;
  const slot = (width - left) / Math.max(1, hours.length);
  const barW = Math.min(36, slot - 6);
  const y = (v: number) => bottom - (v / yMax) * plotH;
  const ticks: number[] = [];
  for (let t = 0; t <= yMax; t += step) ticks.push(t);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
      <title>{title}</title>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={left} x2={width} y1={y(t)} y2={y(t)} stroke={t === 0 ? INK.axis : INK.grid} />
          <text x={left - 6} y={y(t) + 3} textAnchor="end" fontSize={9} fill={INK.ink2} fontFamily={MONO}>
            {formatTick(t)}
          </text>
        </g>
      ))}
      {hours.map((h, i) => {
        const x = left + i * slot + (slot - barW) / 2;
        let acc = 0;
        return (
          <g key={h.hour}>
            <title>{h.title}</title>
            {h.values.map((v, j) => {
              if (v <= 0) return null;
              const y0 = y(acc);
              const y1 = y(acc + v);
              acc += v;
              return <rect key={j} x={x} y={y1} width={barW} height={Math.max(0.5, y0 - y1 - (acc - v > 0 ? 2 : 0))} rx={j === h.values.length - 1 ? 2 : 0} fill={series[j]!.colour} />;
            })}
            {h.label ? (
              <text x={x + barW / 2} y={y(acc) - 4} textAnchor="middle" fontSize={9} fill={INK.ink} fontFamily={MONO} fontWeight={500}>
                {h.label}
              </text>
            ) : null}
            <text x={x + barW / 2} y={height - 5} textAnchor="middle" fontSize={9} fill={INK.ink2} fontFamily={MONO}>
              {String(h.hour).padStart(2, '0')}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
