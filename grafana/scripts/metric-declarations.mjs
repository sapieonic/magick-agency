/**
 * What magick-agency exports to Grafana Cloud, read as TEXT from this repo's
 * source — the one truth both Grafana validators
 * (`validate-alerts.test.mjs`, `validate-dashboard.test.mjs`) assert the alert
 * rules and the dashboard against. Shared, because two copies of a scraper
 * drift, and a scraper that misreads is indistinguishable from a rule that is
 * correct: a metric it fails to see reads as "missing", one it sees with no
 * labels reads every matcher as wrong, one it sees wrongly as a histogram lets
 * `x_count` through.
 *
 * Deliberately textual: importing the metric modules would hide a rename
 * behind a mock, and the server's config `process.exit(1)`s without a `.env`.
 *
 * - **Application metrics** are declared through the facades
 *   (`packages/observability/src/metric-instruments.ts`), one file per module
 *   area under `packages/observability/src/metrics/` — every `*.ts` there is
 *   read, so a new area file is picked up: `counter<'a' | 'b'>(meter, 'name', {…})`. The
 *   TYPE ARGUMENT is the label set; no type argument means no labels.
 *   `packages/observability/test/fixtures/agency-otlp-instruments.json`
 *   snapshots the `agency_*` instruments of `metrics/agency.ts` (pinned against
 *   the module by `metrics-agency.test.ts`), so the parse is cross-checked
 *   against it field by field.
 * - **Runtime metrics** come from `@opentelemetry/instrumentation-runtime-node`:
 *   the allow-list and DROP views in `apps/server/src/utils/otel-sdk-config.ts`
 *   decide what leaves the process, plus the single-series heap gauge
 *   registered in `apps/server/src/instrumentation.ts`. The instrument set is
 *   read from the INSTALLED package (`apps/server/node_modules`), so a
 *   runtime-node upgrade that adds an instrument reds here instead of leaking
 *   an undeclared series.
 * - An OTel instrument created anywhere else in the source is reported: this
 *   parser would never see it.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root. */
export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const at = (p) => join(root, p);

const METRICS_DIR = at('packages/observability/src/metrics');
const FACADE_SOURCE = at('packages/observability/src/metric-instruments.ts');
const FACADE_IMPORT = '../metric-instruments.js';
const FIXTURE = at('packages/observability/test/fixtures/agency-otlp-instruments.json');
const SDK_CONFIG = at('apps/server/src/utils/otel-sdk-config.ts');
const INSTRUMENTATION = at('apps/server/src/instrumentation.ts');
const RUNTIME_NODE_SEMCONV = at('apps/server/node_modules/@opentelemetry/instrumentation-runtime-node/build/src/semconv.js');

/** The declaring files, as `{ origin, text }`. */
function metricFiles() {
  return readdirSync(METRICS_DIR).filter((f) => f.endsWith('.ts')).sort()
    .map((f) => ({ origin: relative(root, join(METRICS_DIR, f)), text: readFileSync(join(METRICS_DIR, f), 'utf8') }));
}

/** Declaration kind → the series names a Prometheus query can select. */
export function seriesNames(name, kind) {
  return kind === 'histogram' ? [`${name}_bucket`, `${name}_sum`, `${name}_count`] : [name];
}

/**
 * How Grafana Cloud's OTLP gateway names an instrument: dots become
 * underscores, a unit suffix is appended unless already present, and a counter
 * gets `_total`. So `nodejs.eventloop.utilization` (unit `1`) is queried as
 * `nodejs_eventloop_utilization_ratio`. Only units this platform emits are
 * mapped; {@link scraperProblems} reds on any other.
 */
const UNIT_SUFFIX = { s: 'seconds', By: 'bytes', 1: 'ratio' };

function promName(instrument, unit, kind) {
  let name = instrument.replace(/\./g, '_');
  const suffix = UNIT_SUFFIX[unit];
  if (suffix && !name.endsWith(`_${suffix}`)) name += `_${suffix}`;
  if (kind === 'counter' && !name.endsWith('_total')) name += '_total';
  return name;
}

/**
 * Comments stripped first, so a quoted
 * example in prose cannot satisfy — or be mistaken for — a declaration.
 * String-aware: a regex-only strip reads the `/*` in `'/api/*'` (or in a regex
 * literal) as a comment opener and deletes everything up to the next real
 * `*\/` — declarations included, silently. So this walks the source once,
 * copying string, template and regex literals through verbatim and dropping
 * only real comments. A `/` starts a regex literal where an operand is
 * expected (after an operator, an opening bracket, a keyword, or nothing).
 */
export function stripComments(source) {
  let out = '';
  let last = ''; // last significant character copied, for the regex-vs-division call
  let word = ''; // the identifier ending at `last`, if any
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    const two = source.slice(i, i + 2);
    if (two === '//') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      out += ' ';
      continue;
    }
    const regex = ch === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last) || /^(return|typeof|case|in|of|void|delete|throw|new)$/.test(word));
    if (ch === "'" || ch === '"' || ch === '`' || regex) {
      let j = i + 1;
      let inClass = false;
      for (; j < source.length; j += 1) {
        const c = source[j];
        if (c === '\\') { j += 1; continue; }
        if (regex && c === '[') inClass = true;
        else if (regex && c === ']') inClass = false;
        else if (c === ch && !inClass) break;
        else if (c === '\n' && ch !== '`') break; // unterminated: stop at the line
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      last = ch; word = '';
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) {
      word = /[\w$]/.test(ch) ? (/[\w$]/.test(last) ? word + ch : ch) : '';
      last = ch;
    }
    i += 1;
  }
  return out;
}

/** Facade → declaration kind, what its body must do to reach OTLP, and its snapshot kind. */
const FACADES = {
  counter: { kind: 'counter', otel: /meter\.createCounter\(/, fixtureKind: 'Counter' },
  histogram: { kind: 'histogram', otel: /meter\.createHistogram\(/, fixtureKind: 'Histogram' },
  gauge: { kind: 'gauge', otel: /meter\.createObservableGauge\(/, fixtureKind: 'ObservableGauge' },
  observableGauge: { kind: 'gauge', otel: /meter\.createObservableGauge\(/, fixtureKind: 'ObservableGauge' },
};

/**
 * Which facades really create an OTel instrument, by reading each one's body,
 * for one declaring file: a file that imports `prom-client`, or does not import
 * the facades, declares nothing that reaches OTLP. Comments stripped first.
 */
function otelFacades(rawMetricsSource) {
  const text = stripComments(readFileSync(FACADE_SOURCE, 'utf8'));
  const metricsSource = stripComments(rawMetricsSource);
  const bodies = [...text.matchAll(/^export (?:function|class) (\w+)\b/gm)];
  const ok = new Set();
  if (/from\s+'prom-client'/.test(metricsSource)) return ok;
  if (!metricsSource.includes(`from '${FACADE_IMPORT}'`)) return ok;
  bodies.forEach((m, i) => {
    const body = text.slice(m.index, i + 1 < bodies.length ? bodies[i + 1].index : text.length);
    if (FACADES[m[1]]?.otel.test(body)) ok.add(m[1]);
  });
  return ok;
}

/**
 * `counter<'a' | 'b'>(meter, 'name', …)`. `anchors` counts every facade call
 * however written, so a declaration the full pattern fails to read (a new
 * facade shape, a name passed as a constant) is reported rather than dropped.
 */
function parseFile(raw, otel, origin) {
  const source = stripComments(raw);
  const out = [];
  const declaration = /\b(counter|histogram|gauge|observableGauge)(?:<([^>]*)>)?\(\s*meter,\s*'([a-z0-9_]+)'/g;
  for (const [, facade, typeArg, name] of source.matchAll(declaration)) {
    out.push({
      name,
      facade,
      kind: FACADES[facade].kind,
      labels: new Set([...(typeArg ?? '').matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])),
      otel: otel.has(facade),
      origin,
    });
  }
  const anchors = [...source.matchAll(/\b(?:counter|histogram|gauge|observableGauge)\s*[<(]/g)].length;
  return { out, anchors };
}

/**
 * The runtime-node instruments agency allow-lists: their unit (set inside the
 * package) and attribute keys, which fix the Grafana Cloud name. Every
 * allow-listed instrument must have an entry and every entry must be
 * allow-listed, so this table cannot drift from the source silently.
 */
const RUNTIME_INSTRUMENTS = {
  'nodejs.eventloop.delay.p99': { unit: 's', kind: 'gauge', labels: [] },
  'nodejs.eventloop.delay.max': { unit: 's', kind: 'gauge', labels: [] },
  'nodejs.eventloop.utilization': { unit: '1', kind: 'gauge', labels: [] },
};

/** `export const X = [ 'a', 'b' ]` (a type annotation allowed) → `['a', 'b']`; null when absent. */
function allowListed(text, constant) {
  const m = new RegExp(`export const ${constant}\\s*(?::[^=]*)?=\\s*\\[([\\s\\S]*?)\\]`).exec(text);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
}

/** An OTel view `instrumentName` filter (`*` and `?` wildcards) as a matcher. */
function viewPattern(pattern) {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

/** The installed runtime-node's instruments; null when it is not installed. */
function installedRuntimeInstruments() {
  if (!existsSync(RUNTIME_NODE_SEMCONV)) return null;
  return [...readFileSync(RUNTIME_NODE_SEMCONV, 'utf8').matchAll(/exports\.METRIC_\w+ = '([^']+)'/g)].map((m) => m[1]);
}

function parseRuntime() {
  const absent = [SDK_CONFIG, INSTRUMENTATION].filter((f) => !existsSync(f));
  if (absent.length) return { out: [], listed: [], dropped: [], absent };
  const text = stripComments(readFileSync(SDK_CONFIG, 'utf8'));
  const listed = allowListed(text, 'RUNTIME_METRIC_ALLOW_LIST') ?? [];
  const dropped = allowListed(text, 'DROPPED_METRIC_PATTERNS');
  const out = listed.filter((i) => RUNTIME_INSTRUMENTS[i]).map((instrument) => {
    const { unit, kind, labels } = RUNTIME_INSTRUMENTS[instrument];
    return { name: promName(instrument, unit, kind), facade: 'RUNTIME_METRIC_ALLOW_LIST', kind, labels: new Set(labels), otel: true, origin: `RUNTIME_METRIC_ALLOW_LIST (${instrument})` };
  });
  // The heap gauge: registered on the SDK meter by `registerHeapUsedGauge`,
  // named after prom-client's default metric.
  const heap = /export const HEAP_USED_METRIC = '([a-z0-9_]+)'/.exec(text)?.[1];
  const registered = /\bregisterHeapUsedGauge\(/.test(stripComments(readFileSync(INSTRUMENTATION, 'utf8')));
  if (heap && registered) {
    out.push({ name: promName(heap, 'By', 'gauge'), facade: 'HEAP_USED_METRIC', kind: 'gauge', labels: new Set(), otel: true, origin: 'HEAP_USED_METRIC' });
  }
  return { out, listed, dropped, absent: [] };
}

/**
 * Every declaration, keyed both by metric name (`declarations`) and by every
 * series name a query can select (`series`: a histogram's `_bucket`, `_sum`,
 * `_count`, never its bare name).
 */
export function loadDeclarations() {
  const app = { out: [], anchors: 0 };
  for (const { text, origin } of metricFiles()) {
    const parsed = parseFile(text, otelFacades(text), origin);
    app.out.push(...parsed.out);
    app.anchors += parsed.anchors;
  }
  const runtime = parseRuntime();
  const declarations = new Map();
  const duplicates = [];
  for (const d of [...app.out, ...runtime.out]) {
    if (declarations.has(d.name)) duplicates.push(d.name);
    declarations.set(d.name, d);
  }
  const series = new Map();
  for (const d of declarations.values()) for (const s of seriesNames(d.name, d.kind)) series.set(s, d);
  return { declarations, series, app: app.out, anchors: app.anchors, duplicates, runtime };
}

/** Labels the validators are written around, pinned so a misparse is loud. */
const PINNED_LABELS = [
  ['agency_predial_gate_total', ['action', 'campaign_id', 'gate']],
  ['agency_attempt_hold_seconds', ['outcome', 'tenant_id']],
  ['rate_limit_rejected_total', ['bucket_kind', 'route_class']],
  ['auth_attempts_total', ['method', 'status']],
  ['websocket_connections_active', ['type']],
  ['nodejs_eventloop_utilization_ratio', []],
];

/** Plausible floor: well under today's 40, far above a broken regex. */
const MIN_METRICS = 30;

/**
 * Series agency must NOT declare: the billing series (docs/decisions.md S6 —
 * attempt batches, attempt settlement, settlement fan-out). Declaring one
 * would mean billing came back, which is a decision, not drift.
 */
export const RETIRED_SERIES = [
  'agency_attempt_batches_total',
  'agency_attempt_batch_attempts_total',
  'agency_attempt_settlement_failures_total',
  'settlement_dispatch_total',
  'webhook_fanout_abandoned_total',
];

/** Where an OTel instrument may be created: the facades, and the SDK config's heap gauge. */
const INSTRUMENT_SITES = [relative(root, FACADE_SOURCE), relative(root, SDK_CONFIG)];

/** `apps/server/src` and each package's `src` (`packages/<name>/src`). */
const sourceRoots = () => [
  at('apps/server/src'),
  ...readdirSync(at('packages')).map((p) => at(`packages/${p}/src`)),
];

/** Every `*.ts` under `dir`, skipping `node_modules`. */
function tsFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : tsFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}

/** `.create*(` in the source outside {@link INSTRUMENT_SITES}. */
function strayInstruments() {
  const problems = [];
  for (const file of sourceRoots().flatMap(tsFiles)) {
    const rel = relative(root, file);
    if (INSTRUMENT_SITES.includes(rel)) continue;
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(/\.create(?:Observable)?(?:Counter|UpDownCounter|Histogram|Gauge)\s*\(/g)) {
      problems.push(`${rel} creates an OTel instrument directly (${m[0].trim()}) — declare it through the facades in packages/observability/src/metrics/`);
    }
  }
  return problems;
}

/**
 * Everything that would make {@link loadDeclarations} a scraper that silently
 * misreads. Empty means the parse is trustworthy. Both validators assert it first.
 */
export function scraperProblems(loaded) {
  const { app, anchors, duplicates, declarations, runtime } = loaded;
  const problems = [];
  if (app.length < MIN_METRICS) problems.push(`only ${app.length} metrics parsed from packages/observability/src/metrics/`);
  if (anchors !== app.length) problems.push(`${anchors} declarations in packages/observability/src/metrics/ but only ${app.length} parsed — a declaration shape this parser does not read`);
  for (const name of duplicates) problems.push(`${name} declared twice`);
  for (const d of app) {
    if (d.kind === 'counter' && !d.name.endsWith('_total')) problems.push(`counter ${d.name} lacks _total — Grafana Cloud exports it as ${d.name}_total`);
  }
  for (const f of [...new Set(app.filter((d) => !d.otel).map((d) => `${d.facade} (${d.origin})`))]) {
    problems.push(`facade ${f} was not recognised as creating an OTel instrument`);
  }
  if (runtime.absent.length) {
    problems.push(`${runtime.absent.map((f) => relative(root, f)).join(' and ')} not found — no runtime metrics (event loop, heap) can be read`);
  } else {
    problems.push(...runtimeProblems(runtime, app));
    if (!declarations.has('nodejs_heap_size_used_bytes')) problems.push('HEAP_USED_METRIC not found or no longer registered in apps/server/src/instrumentation.ts');
  }
  for (const [name, labels] of PINNED_LABELS) {
    const d = declarations.get(name);
    if (!d) problems.push(`pinned metric ${name} not parsed`);
    else if ([...d.labels].sort().join(',') !== labels.join(',')) problems.push(`${name} parsed with [${[...d.labels].sort()}], expected [${labels}]`);
  }
  problems.push(...fixtureProblems(app));
  problems.push(...strayInstruments());
  return problems;
}

/**
 * The allow-list only means "exported" if nothing else decides otherwise: an
 * allow-listed name a DROP view also matches is dropped (or double-recorded),
 * and an installed runtime-node instrument neither list covers is exported by
 * default — a series this scraper would call undeclared. The drop patterns
 * must not reach the application metrics or the heap gauge either.
 */
function runtimeProblems(runtime, app) {
  const problems = [];
  const known = Object.keys(RUNTIME_INSTRUMENTS);
  for (const i of runtime.listed.filter((x) => !known.includes(x))) problems.push(`runtime instrument ${i} is allow-listed but unknown to RUNTIME_INSTRUMENTS (add its unit and labels)`);
  for (const i of known.filter((x) => !runtime.listed.includes(x))) problems.push(`RUNTIME_INSTRUMENTS lists ${i}, which RUNTIME_METRIC_ALLOW_LIST no longer allow-lists`);
  const installed = installedRuntimeInstruments();
  if (installed === null) return [...problems, 'apps/server/node_modules/@opentelemetry/instrumentation-runtime-node is not installed — run pnpm install'];
  for (const i of runtime.listed.filter((x) => !installed.includes(x))) problems.push(`allow-listed ${i} is not created by the installed runtime-node`);
  if (runtime.dropped === null) return [...problems, 'DROPPED_METRIC_PATTERNS not found'];
  const drops = runtime.dropped.map((p) => [p, viewPattern(p)]);
  const droppedBy = (name) => drops.filter(([, re]) => re.test(name)).map(([p]) => p);
  for (const i of runtime.listed) {
    const by = droppedBy(i);
    if (by.length) problems.push(`allow-listed ${i} is also matched by drop view ${by.join(', ')}`);
  }
  for (const i of installed) {
    if (!runtime.listed.includes(i) && droppedBy(i).length === 0) problems.push(`installed runtime-node creates ${i}, which is neither allow-listed nor dropped — it is exported undeclared`);
  }
  for (const d of [...app, ...runtime.out.filter((x) => x.facade === 'HEAP_USED_METRIC')]) {
    const by = droppedBy(d.name);
    if (by.length) problems.push(`${d.name} is matched by drop view ${by.join(', ')}`);
  }
  return problems;
}

/**
 * The instrument snapshot covers exactly the `agency_*` metrics of
 * `metrics/agency.ts` (its own suite filters to those); the parse must agree
 * with it there — names, kinds, attribute keys — and every unit it carries
 * must already be spelled in the name, or Grafana Cloud would append it.
 */
function fixtureProblems(app) {
  const file = relative(root, FIXTURE);
  if (!existsSync(FIXTURE)) return [`${file} missing — no oracle to cross-check the parse against`];
  const covers = (d) => d.origin === 'packages/observability/src/metrics/agency.ts' && d.name.startsWith('agency_');
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const problems = [];
  const parsed = new Map(app.map((d) => [d.name, d]));
  for (const e of fixture) {
    const d = parsed.get(e.name);
    if (!d) { problems.push(`${e.name} is in ${file} but was not parsed`); continue; }
    if (!covers(d)) { problems.push(`${e.name} is in ${file} but declared in ${d.origin}`); continue; }
    if (FACADES[d.facade].fixtureKind !== e.kind) problems.push(`${e.name} parsed via ${d.facade}, fixture says ${e.kind}`);
    const want = [...e.attributes].sort().join(',');
    const got = [...d.labels].sort().join(',');
    if (want !== got) problems.push(`${e.name} parsed with [${got}], fixture says [${want}]`);
    if (e.unit !== undefined && (!UNIT_SUFFIX[e.unit] || promName(e.name, e.unit, d.kind) !== e.name)) {
      problems.push(`${e.name} has unit ${e.unit} — Grafana Cloud will not query it by its declared name`);
    }
  }
  const inFixture = new Set(fixture.map((e) => e.name));
  for (const d of app.filter(covers)) if (!inFixture.has(d.name)) problems.push(`${d.name} parsed but absent from ${file}`);
  return problems;
}

// ── PromQL shape ─────────────────────────────────────────────────────────────
//
// Both tests ask questions a regex over the expression answers wrongly: which
// labels survive `sum by (service_name) (…)` (a `{{path}}` legend on it renders
// empty), which labels a `label_replace(…, "dst", …)` mints, which range
// windows an expression uses (`status=~"[45].."` is not one), which side of an
// `unless` decides whether a rule fires. So expressions are parsed — a small
// recursive-descent parser for the PromQL this platform writes, plus Grafana's
// `$var` / `${var}` / `[[var]]` placeholders. What it cannot parse it throws on,
// and both tests red on a throw: an unparsed expression is an unchecked one.

const AGGREGATIONS = new Set(['sum', 'min', 'max', 'avg', 'group', 'stddev', 'stdvar', 'count', 'count_values',
  'bottomk', 'topk', 'quantile', 'limitk', 'limit_ratio']);
/** Aggregations that return input series whole — `by` picks the groups, not the labels. */
const KEEPS_INPUT = new Set(['topk', 'bottomk', 'limitk', 'limit_ratio']);
const PRECEDENCE = { or: 1, and: 2, unless: 2, '==': 3, '!=': 3, '<=': 3, '<': 3, '>=': 3, '>': 3,
  '+': 4, '-': 4, '*': 5, '/': 5, '%': 5, atan2: 5, '^': 6 };
const SCALAR_FUNCTIONS = new Set(['scalar', 'time', 'pi']);
/** Operators that drop `__name__` from their result (so does any comparison with `bool`). */
const ARITHMETIC = new Set(['+', '-', '*', '/', '%', '^', 'atan2']);
/** Functions whose result keeps `__name__`; every other function drops it. */
const KEEPS_NAME = new Set(['label_replace', 'label_join', 'last_over_time', 'first_over_time',
  'sort', 'sort_desc', 'sort_by_label', 'sort_by_label_desc']);

const TOKEN = /\s+|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)|(\$\{[^}]*\}|\$\w+|\[\[\w+\]\])|(\d+(?:\.\d+)?(?:e[+-]?\d+)?(?:(?:ms|[smhdwy])(?:\d+(?:ms|[smhdwy]))*)?)|([A-Za-z_:][\w:]*)|(=~|!~|==|!=|<=|>=|[-+*/%^<>=(){}[\],:@])/y;

function tokenize(expr) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < expr.length) {
    const pos = TOKEN.lastIndex;
    const m = TOKEN.exec(expr);
    if (!m) throw new SyntaxError(`unexpected ${JSON.stringify(expr[pos])} at ${pos}`);
    const [, str, gvar, num, ident, op] = m;
    if (str) tokens.push({ type: 'string', v: str, pos });
    else if (gvar) tokens.push({ type: 'var', v: gvar, pos });
    else if (num) tokens.push({ type: 'number', v: num, pos });
    else if (ident) tokens.push({ type: 'ident', v: ident, pos });
    else if (op) tokens.push({ type: 'op', v: op, pos });
  }
  return tokens;
}

const unquote = (s) => s.slice(1, -1).replace(/\\(.)/g, '$1');

/**
 * Parse a PromQL expression into a tree of `{ type, … }` nodes: `selector`
 * (`name` or null, `matchers`), `range` (`range`, `step`), `call` (`fn`,
 * `args`), `aggregation` (`op`, `grouping`, `args`), `binary` (`op`,
 * `matching`, `group`, `left`, `right`), `paren`, `unary`, `offset`, `number`,
 * `string` (`value`, and its `raw` literal at `pos`). Throws a SyntaxError on
 * anything else.
 */
export function parsePromQL(expr) {
  const toks = tokenize(expr);
  let i = 0;
  const peek = () => toks[i];
  const is = (v) => toks[i]?.v === v && (toks[i].type === 'op' || toks[i].type === 'ident');
  const fail = (what) => { throw new SyntaxError(`${what} at ${toks[i]?.pos ?? 'end'} in ${expr}`); };
  const expect = (v) => { if (!is(v)) fail(`expected ${v}`); return toks[i++]; };

  // Prometheus's `grouping_labels`: `()`, or names separated by commas with
  // one trailing comma allowed — `by (a b)`, `by (, a)` and `by (a,, b)` are
  // parse errors there, so here too. A name may be quoted (`by ("a")`, legal
  // since Prometheus 3.0); it is unquoted and checked like any other, and the
  // empty name is rejected as Prometheus rejects it.
  function labelList() {
    expect('(');
    const labels = [];
    while (!is(')')) {
      const t = toks[i++];
      if (!t) fail('unterminated label list');
      if (t.type === 'ident') labels.push(t.v);
      else if (t.type === 'string' && unquote(t.v) !== '') labels.push(unquote(t.v));
      else if (t.type === 'string') { i -= 1; fail('invalid label name "" in label list'); }
      else { i -= 1; fail(`unexpected ${t.v} in label list`); }
      if (is(',')) i += 1;
      else if (!is(')')) fail('expected , or ) in label list');
    }
    i += 1;
    return labels;
  }
  function binaryOp() {
    const t = peek();
    if (!t) return null;
    if (t.type === 'op' && t.v in PRECEDENCE) return t.v;
    if (t.type === 'ident' && ['and', 'or', 'unless', 'atan2'].includes(t.v)) return t.v;
    return null;
  }
  function expression(minPrec = 1) {
    let left = unary();
    for (let op = binaryOp(); op && PRECEDENCE[op] >= minPrec; op = binaryOp()) {
      i += 1;
      const node = { type: 'binary', op, left, matching: null, group: null, bool: false };
      if (is('bool')) { i += 1; node.bool = true; }
      if (is('on') || is('ignoring')) node.matching = { kind: toks[i++].v, labels: labelList() };
      if (is('group_left') || is('group_right')) node.group = { kind: toks[i++].v, labels: is('(') ? labelList() : [] };
      node.right = expression(op === '^' ? PRECEDENCE[op] : PRECEDENCE[op] + 1);
      left = node;
    }
    return left;
  }
  function unary() {
    if (is('-') || is('+')) { i += 1; return { type: 'unary', expr: unary() }; }
    return postfix(primary());
  }
  function postfix(node) {
    for (;;) {
      if (is('[')) {
        i += 1;
        let text = '';
        while (!is(']')) { if (!peek()) fail('unterminated ['); text += toks[i++].v; }
        i += 1;
        const [range, step] = text.split(':');
        node = { type: 'range', expr: node, range, step: step ?? null, subquery: text.includes(':') };
      } else if (is('offset')) {
        i += 1;
        if (is('-')) i += 1;
        node = { type: 'offset', expr: node, offset: toks[i++]?.v };
      } else if (is('@')) {
        i += 1;
        if (is('-')) i += 1;
        const t = toks[i++];
        if (t?.type === 'ident') { expect('('); expect(')'); }
        node = { type: 'offset', expr: node, at: t?.v };
      } else return node;
    }
  }
  function args() {
    expect('(');
    const out = [];
    while (!is(')')) {
      out.push(expression());
      if (is(',')) i += 1;
      else if (!is(')')) fail('expected , or )');
    }
    i += 1;
    return out;
  }
  function matchers() {
    expect('{');
    const out = [];
    while (!is('}')) {
      const name = toks[i++];
      if (!name) fail('unterminated {');
      if (name.type === 'string') out.push({ label: '__name__', op: '=', value: unquote(name.v) });
      else {
        if (name.type !== 'ident') fail(`unexpected ${name.v} in matchers`);
        const op = toks[i++];
        const value = toks[i++];
        if (!['=', '!=', '=~', '!~'].includes(op?.v) || value?.type !== 'string') fail(`bad matcher on ${name.v}`);
        out.push({ label: name.v, op: op.v, value: unquote(value.v) });
      }
      if (is(',')) i += 1;
      else if (!is('}')) fail('expected , or }');
    }
    i += 1;
    return out;
  }
  function primary() {
    const t = peek();
    if (!t) fail('unexpected end');
    if (is('(')) { i += 1; const e = expression(); expect(')'); return { type: 'paren', expr: e }; }
    if (is('{')) return { type: 'selector', name: null, matchers: matchers() };
    i += 1;
    if (t.type === 'number' || t.type === 'var') return { type: 'number' }; // `> $threshold` stands in for a scalar
    if (t.type === 'string') return { type: 'string', value: unquote(t.v), pos: t.pos, raw: t.v };
    if (t.type !== 'ident') fail(`unexpected ${t.v}`);
    if (AGGREGATIONS.has(t.v) && (is('(') || is('by') || is('without'))) {
      let grouping = null;
      if (is('by') || is('without')) grouping = { kind: toks[i++].v, labels: labelList() };
      const a = args();
      if (!grouping && (is('by') || is('without'))) grouping = { kind: toks[i++].v, labels: labelList() };
      return { type: 'aggregation', op: t.v, grouping, args: a };
    }
    if (is('(')) return { type: 'call', fn: t.v, args: args() };
    if (['Inf', 'NaN', 'inf', 'nan'].includes(t.v)) return { type: 'number' };
    return { type: 'selector', name: t.v, matchers: is('{') ? matchers() : [] };
  }

  const ast = expression();
  if (i < toks.length) fail(`trailing ${toks[i].v}`);
  return ast;
}

const CHILDREN = (n) => [n.expr, n.left, n.right, ...(n.args ?? [])].filter(Boolean);

/** Every node, depth-first. */
export function walkPromQL(node, visit) {
  visit(node);
  for (const c of CHILDREN(node)) walkPromQL(c, visit);
}

/**
 * The facts both tests check, in one pass: every selector, every label list
 * (`by`/`without`/`on`/`ignoring`/`group_left`/`group_right`, each with the
 * `node` it sits on, for {@link labelsInScope}), every label a
 * `label_replace`/`label_join`/`count_values` mints, and every range (`[5m]`,
 * `[$__rate_interval]`, subquery).
 */
export function promqlFacts(ast) {
  const facts = { selectors: [], groupings: [], minted: new Set(), ranges: [], calls: [] };
  walkPromQL(ast, (n) => {
    if (n.type === 'selector') facts.selectors.push(n);
    if (n.type === 'range') facts.ranges.push(n);
    if (n.type === 'call') facts.calls.push(n);
    if (n.type === 'aggregation' && n.grouping) facts.groupings.push({ ...n.grouping, node: n });
    if (n.type === 'binary' && n.matching) facts.groupings.push({ ...n.matching, node: n });
    if (n.type === 'binary' && n.group) facts.groupings.push({ ...n.group, node: n });
    const dst = mintedBy(n);
    if (dst) facts.minted.add(dst);
  });
  return facts;
}

function mintedBy(n) {
  if (n.type === 'call' && ['label_replace', 'label_join'].includes(n.fn) && n.args[1]?.type === 'string') return n.args[1].value;
  if (n.type === 'aggregation' && n.op === 'count_values' && n.args[0]?.type === 'string') return n.args[0].value;
  return null;
}

/**
 * The labels a label list on `node` (its `by`, `on`, `group_left`, …) may name:
 * what the selectors beneath it carry (`selectorLabels`, as for
 * {@link outputLabels}; null contributes nothing) and what a `label_replace` /
 * `label_join` / `count_values` beneath it mints. Lexical, so a label one
 * operand mints or declares is not borrowed by its sibling, and a
 * `count_values`'s own output label is not in scope of its own `by`. A
 * selector's MATCHERS are not checked against this: they filter raw series,
 * which carry no minted label and none of another metric's.
 */
export function labelsInScope(node, selectorLabels) {
  const out = new Set();
  for (const child of CHILDREN(node)) {
    walkPromQL(child, (n) => {
      if (n.type === 'selector') for (const l of selectorLabels(n) ?? []) out.add(l);
      const dst = mintedBy(n);
      if (dst) out.add(dst);
    });
  }
  return out;
}

// Label sets below are a Set, or null for "could be any label" (a nameless
// selector, an undeclared metric) — null absorbs a union and yields to an
// intersection, so an unknown input never manufactures a red.
const union = (a, b) => (a === null || b === null ? null : new Set([...a, ...b]));
const intersect = (a, b) => (a === null ? b : b === null ? a : new Set([...a].filter((l) => b.has(l))));
const minus = (a, drop) => (a === null ? null : new Set([...a].filter((l) => !drop.includes(l))));

/**
 * The labels an expression's result series can carry NON-EMPTY, given
 * `selectorLabels` (selector node → Set, or null for unknown). Follows
 * Prometheus: an aggregation keeps its `by` labels (or drops its `without`
 * ones; topk-style keep the input); `label_replace` adds its destination;
 * `histogram_quantile` drops `le`; functions drop `__name__` (bar
 * {@link KEEPS_NAME}).
 *
 * Binary operators, after `resultMetric` in Prometheus's engine.go: the result
 * takes the LEFT side's labels (the many side's, under `group_left/right`),
 * minus `__name__` for arithmetic or `bool`; one-to-one `on (…)` then keeps
 * only the `on` labels and `ignoring (…)` deletes its own; a `group_x (…)`
 * label is copied from the one side, and deleted when the one side lacks it.
 * And a pair only matches where both sides agree on every matching label (the
 * `on` list, or everything not ignored), so a matching label the other side
 * cannot carry is empty on every result — which is why `a / b` keeps only what
 * both carry. With a scalar, the vector's labels. `and`/`unless` return left
 * series whole; `or` returns series from both sides, so a label either side
 * carries can render (the question the callers ask is "always empty?").
 * Returns `{ scalar: boolean, labels: Set | null }`.
 */
export function outputLabels(node, selectorLabels) {
  const vec = (labels) => ({ scalar: false, labels });
  const scalar = { scalar: true, labels: new Set() };
  const of = (n) => outputLabels(n, selectorLabels);
  switch (node.type) {
    case 'number': case 'string': return scalar;
    case 'selector': return vec(selectorLabels(node));
    case 'paren': case 'unary': case 'range': case 'offset': return of(node.expr);
    case 'aggregation': {
      const input = of(node.args[node.args.length - 1]).labels;
      const extra = node.op === 'count_values' ? [mintedBy(node)] : [];
      if (KEEPS_INPUT.has(node.op)) return vec(input);
      if (!node.grouping) return vec(new Set(extra));
      if (node.grouping.kind === 'by') return vec(new Set([...node.grouping.labels, ...extra]));
      return vec(union(minus(input, node.grouping.labels), new Set(extra)));
    }
    case 'call': {
      if (SCALAR_FUNCTIONS.has(node.fn)) return scalar;
      if (node.fn === 'vector') return vec(new Set());
      if (mintedBy(node)) return vec(union(of(node.args[0]).labels, new Set([mintedBy(node)])));
      if (node.fn === 'histogram_quantile') return vec(minus(of(node.args[1]).labels, ['le', '__name__']));
      if (node.fn === 'absent' || node.fn === 'absent_over_time') {
        let sel = node.args[0];
        while (sel && sel.type !== 'selector') sel = sel.expr;
        return vec(new Set((sel?.matchers ?? []).filter((m) => m.op === '=' && m.label !== '__name__').map((m) => m.label)));
      }
      const vectorArg = node.args.map(of).find((r) => !r.scalar);
      if (!vectorArg) return node.args.length ? scalar : vec(new Set());
      return KEEPS_NAME.has(node.fn) ? vectorArg : vec(minus(vectorArg.labels, ['__name__']));
    }
    case 'binary': {
      const l = of(node.left);
      const r = of(node.right);
      if (node.op === 'and' || node.op === 'unless') return l;
      if (node.op === 'or') return vec(union(l.labels, r.labels));
      if (l.scalar && r.scalar) return scalar;
      const named = (labels) => (node.bool || ARITHMETIC.has(node.op) ? minus(labels, ['__name__']) : labels);
      if (l.scalar) return vec(named(r.labels));
      if (r.scalar) return vec(named(l.labels));
      const m = node.matching ?? { kind: 'ignoring', labels: [] };
      const matches = (x) => (m.kind === 'on' ? m.labels.includes(x) : x !== '__name__' && !m.labels.includes(x));
      // `side`'s labels, less the matching labels `other` cannot carry.
      const agreed = (side, other) => (side === null || other === null ? side
        : new Set([...side].filter((x) => other.has(x) || !matches(x))));
      if (node.group) {
        const [many, one] = node.group.kind === 'group_left' ? [l, r] : [r, l];
        const copied = node.group.labels.filter((x) => one.labels === null || one.labels.has(x));
        return vec(named(union(minus(agreed(many.labels, one.labels), node.group.labels), new Set(copied))));
      }
      const kept = agreed(l.labels, r.labels);
      if (m.kind === 'on') return vec(intersect(kept, new Set(m.labels)));
      return vec(named(minus(kept, m.labels)));
    }
    default: throw new Error(`outputLabels: unknown node ${node.type}`);
  }
}
