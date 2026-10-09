/**
 * Static contract between agency's dashboard
 * (`grafana/dashboards/magick-agency-overview.json`) and the metrics agency
 * actually exports.
 *
 * A metric renamed in `packages/observability/src/metrics/` leaves a panel
 * silently empty — no error, just a flat line an operator reads as "no
 * traffic". So every panel and template-variable query is parsed and checked
 * against agency's declarations (`metric-declarations.mjs`): every metric name,
 * label matcher, label list and `{{legend}}` placeholder must resolve, every
 * query must survive the 60s OTLP export interval, and every query must be
 * scoped to agency's deployments only: every selector must carry
 * `$service_name`, whose All value is agency's regex.
 *
 * Product names in titles and descriptions (B17) are the repo-wide branding
 * guard's job (`apps/server/test/unit/branding/no-external-references.test.ts`
 * scans this JSON too).
 *
 *   pnpm test:grafana
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  root, loadDeclarations, scraperProblems, stripComments, RETIRED_SERIES,
  parsePromQL, promqlFacts, outputLabels, labelsInScope,
} from './metric-declarations.mjs';

const dashboardPath = join(root, 'grafana/dashboards/magick-agency-overview.json');

/** Resource attributes promoted onto every OTLP series, plus `le`, `__name__`, `otel_metric_overflow`. */
const IMPLICIT_LABELS = new Set([
  'deployment_environment', 'service_name', 'service_version', 'job', 'instance', 'le', '__name__', 'otel_metric_overflow',
]);

const BUILTIN_VARIABLES = new Set([
  '__rate_interval', '__range', '__range_s', '__range_ms', '__interval', '__interval_ms', '__all',
  '__from', '__to', '__dashboard', '__org', '__user',
]);

/**
 * One OTLP sample per 60s: a target Min step of 1m keeps ≥ 4 samples in every
 * `$__rate_interval`, and a fixed window must hold five.
 */
const MIN_STEP_SECONDS = 60;
const MIN_WINDOW_SECONDS = 300;
const INTERVAL_VARIABLES = /^\$(?:\{)?(__rate_interval|__range|__interval)\}?$/;

const ENV_MATCHER = { label: 'deployment_environment', op: '=~', value: '$environment' };
const SVC_MATCHER = { label: 'service_name', op: '=~', value: '$service_name' };

function durationSeconds(text) {
  const s = String(text ?? '').trim();
  if (!/^(\d+(ms|s|m|h|d|w|y))+$/.test(s)) return Number.NaN;
  const unit = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };
  return [...s.matchAll(/(\d+)(ms|s|m|h|d|w|y)/g)].reduce((sum, [, n, u]) => sum + Number(n) * unit[u], 0);
}

/** `agency_service_name_regex`'s default — the alert rules' selector, which the dashboard must match. */
function agencyRegex() {
  const vars = readFileSync(join(root, 'grafana/terraform/variables.tf'), 'utf8');
  const block = /variable "agency_service_name_regex" \{[\s\S]*?\n\}/.exec(vars)?.[0] ?? '';
  return /\n\s+default\s*= "((?:[^"\\]|\\.)*)"/.exec(block)?.[1];
}

function loadTruth() {
  const { declarations, series } = loadDeclarations();
  return { declarations, series: new Map([...series].map(([raw, d]) => [raw, d.name])) };
}

const loadDashboard = () => JSON.parse(readFileSync(dashboardPath, 'utf8'));

function allPanels(dashboard) {
  const flatten = (panels) => panels.flatMap((p) => [p, ...flatten(p.panels ?? [])]);
  return flatten(dashboard.panels);
}

function datasourceType(ds, dashboard) {
  if (!ds) return undefined;
  if (typeof ds === 'string') ds = { uid: ds };
  if (ds.type) return ds.type;
  const variable = /^\$\{?(\w+)\}?$/.exec(ds.uid ?? '')?.[1];
  return dashboard.templating.list.find((v) => v.type === 'datasource' && v.name === variable)?.query;
}

function allTargets(dashboard) {
  return allPanels(dashboard)
    .filter((p) => p.type !== 'row')
    .flatMap((p) => (p.targets ?? []).map((t) => ({
      ...t,
      panel: p.title,
      dsType: datasourceType(t.datasource, dashboard) ?? datasourceType(p.datasource, dashboard),
    })));
}

const prometheusTargets = (dashboard) => allTargets(dashboard).filter((t) => t.dsType === 'prometheus');

function templateQueries(dashboard) {
  return dashboard.templating.list
    .filter((v) => v.type === 'query' && datasourceType(v.datasource, dashboard) === 'prometheus')
    .flatMap((v) => [...new Set([v.definition, typeof v.query === 'string' ? v.query : v.query?.query].filter(Boolean))]
      .map((q) => ({ variable: v.name, query: q })));
}

function templateQueryParts(query) {
  const q = query.trim();
  let m;
  if ((m = /^label_values\(\s*(\w+)\s*\)$/.exec(q))) return { expr: null, label: m[1] };
  if ((m = /^label_values\(([\s\S]*),\s*(\w+)\s*\)$/.exec(q))) return { expr: m[1], label: m[2] };
  if ((m = /^query_result\(([\s\S]*)\)$/.exec(q))) return { expr: m[1], label: null };
  if (/^(metrics|label_names)\(/.test(q)) return null;
  return { expr: q, label: null };
}

function allExpressions(dashboard) {
  const out = prometheusTargets(dashboard).map((t) => ({ where: `${t.panel} / ${t.refId}`, expr: t.expr ?? '', target: t }));
  for (const { variable, query } of templateQueries(dashboard)) {
    const parts = templateQueryParts(query);
    if (parts?.expr) out.push({ where: `$${variable} query`, expr: parts.expr, listsLabel: parts.label, variable });
  }
  for (const e of out) {
    try { e.ast = parsePromQL(e.expr); } catch (err) { e.error = err.message; }
  }
  return out;
}

/** The labels one selector's series carry: the implicit ones and what its metric declares. */
function ownLabels(sel, { declarations, series }) {
  const metric = series.get(sel.name);
  return new Set([...IMPLICIT_LABELS, ...(metric ? declarations.get(metric).labels : [])]);
}

const hasMatcher = (sel, m) => sel.matchers.some((x) => x.label === m.label && x.op === m.op && x.value === m.value);

describe('agency Grafana dashboard', () => {
  test('reads agency\'s declarations (a scraper that misreads would pass or fail everything below)', () => {
    const problems = scraperProblems(loadDeclarations());
    assert.deepEqual(problems, [], `metric declarations misread:\n  ${problems.join('\n  ')}`);
  });

  test('the comment stripper keeps string and regex literals whole (a phantom /* would swallow declarations)', () => {
    const source = "const p = '/api/*'; const r = /a\\/*b[/*]/g;\ncounter(meter, 'x_total'); // c\n/** doc */ y = a / b; /* c */";
    const stripped = stripComments(source);
    assert.match(stripped, /counter\(meter, 'x_total'\)/);
    assert.match(stripped, /'\/api\/\*'/);
    assert.doesNotMatch(stripped, /doc|\/\/ c|\/\* c/);
    assert.match(stripped, /y = a \/ b;/);
  });

  test('is valid JSON with the pinned uid and schema version', () => {
    const d = loadDashboard();
    assert.equal(d.uid, 'magick-agency-overview'); // the alert rules' dashboard_url links here
    assert.equal(d.schemaVersion, 39);
    assert.ok(d.panels.length > 0, 'dashboard has no panels');
  });

  test('every panel has a unique id', () => {
    const ids = allPanels(loadDashboard()).map((p) => p.id);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'duplicate panel ids');
  });

  test('no panel overlaps another or overflows the 24-column grid', () => {
    const occupied = new Map();
    for (const p of loadDashboard().panels) {
      const { x, y, w, h } = p.gridPos;
      assert.ok(x + w <= 24, `${p.title} overflows the grid: x=${x} w=${w}`);
      for (let cx = x; cx < x + w; cx += 1) {
        for (let cy = y; cy < y + h; cy += 1) {
          const key = `${cx},${cy}`;
          assert.ok(!occupied.has(key), `${p.title} overlaps ${occupied.get(key)} at (${cx},${cy})`);
          occupied.set(key, p.title);
        }
      }
    }
  });

  test('every query target resolves to a datasource type', () => {
    const d = loadDashboard();
    assert.deepEqual(allTargets(d).filter((t) => !t.dsType).map((t) => `${t.panel} / ${t.refId}`), []);
    assert.ok(prometheusTargets(d).length >= 30, `only ${prometheusTargets(d).length} Prometheus targets found`);
  });

  test('every PromQL expression parses', () => {
    const bad = allExpressions(loadDashboard()).filter((e) => e.error).map((e) => `${e.where}: ${e.error}`);
    assert.deepEqual(bad, [], `expressions that do not parse:\n  ${bad.join('\n  ')}`);
  });

  test('every metric charted or listed exists in agency, and none is a retired billing series', () => {
    const { series } = loadTruth();
    const missing = [];
    for (const e of allExpressions(loadDashboard()).filter((x) => x.ast)) {
      for (const sel of promqlFacts(e.ast).selectors) {
        if (!sel.name) continue;
        if (RETIRED_SERIES.includes(series.get(sel.name) ?? sel.name)) missing.push(`${sel.name} is a retired billing series (${e.where})`);
        else if (!series.has(sel.name)) missing.push(`${sel.name} (${e.where})`);
      }
    }
    assert.deepEqual(missing, [], `series agency does not export:\n  ${missing.join('\n  ')}`);
  });

  test('every label matcher and label list is a declared label', () => {
    const truth = loadTruth();
    const problems = [];
    for (const e of allExpressions(loadDashboard()).filter((x) => x.ast)) {
      const facts = promqlFacts(e.ast);
      for (const sel of facts.selectors) {
        const allowed = ownLabels(sel, truth);
        for (const { label } of sel.matchers) if (!allowed.has(label)) problems.push(`matcher ${label} on ${sel.name ?? 'a nameless selector'} (${e.where})`);
      }
      for (const g of facts.groupings) {
        const allowed = labelsInScope(g.node, (sel) => ownLabels(sel, truth));
        for (const label of g.labels) if (!allowed.has(label)) problems.push(`${g.kind}(${label}) (${e.where})`);
      }
    }
    assert.deepEqual(problems, [], `labels no selected metric declares:\n  ${problems.join('\n  ')}`);
  });

  test('every legend placeholder survives the query\'s aggregation', () => {
    const truth = loadTruth();
    const problems = [];
    for (const e of allExpressions(loadDashboard()).filter((x) => x.ast && x.target)) {
      const placeholders = [...(e.target.legendFormat ?? '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
      if (placeholders.length === 0) continue;
      const { labels } = outputLabels(e.ast, (sel) => (truth.series.get(sel.name) ? ownLabels(sel, truth) : null));
      if (labels === null) continue;
      for (const p of placeholders) if (!labels.has(p)) problems.push(`legend {{${p}}} — the result carries only [${[...labels].sort().join(', ')}] (${e.where})`);
    }
    assert.deepEqual(problems, [], `legend placeholders that always render empty:\n  ${problems.join('\n  ')}`);
  });

  test('every template variable query lists a declared label of an existing metric', () => {
    const truth = loadTruth();
    const problems = [];
    const queries = templateQueries(loadDashboard());
    assert.ok(queries.length >= 3, `only ${queries.length} template queries found`);
    for (const { variable, query } of queries) {
      const parts = templateQueryParts(query);
      if (!parts?.label || !parts.expr) continue;
      let ast;
      try { ast = parsePromQL(parts.expr); } catch { continue; }
      const listable = new Set(promqlFacts(ast).selectors.flatMap((s) => [...ownLabels(s, truth)]));
      if (!listable.has(parts.label)) problems.push(`$${variable}: ${query} — no selected metric declares ${parts.label}`);
    }
    assert.deepEqual(problems, [], `template variables that can only ever list nothing:\n  ${problems.join('\n  ')}`);
  });

  test('every Prometheus query has a Min step of at least 1m and no fixed window under 5m (60s OTLP export)', () => {
    const problems = [];
    for (const e of allExpressions(loadDashboard()).filter((x) => x.target)) {
      if (!(durationSeconds(e.target.interval) >= MIN_STEP_SECONDS)) problems.push(`${e.where}: interval=${JSON.stringify(e.target.interval)}`);
      if (!e.ast) continue;
      for (const r of promqlFacts(e.ast).ranges) {
        if (!INTERVAL_VARIABLES.test(r.range) && !(durationSeconds(r.range) >= MIN_WINDOW_SECONDS)) problems.push(`${e.where}: window [${r.range}]`);
      }
    }
    assert.deepEqual(problems, [], `queries that read empty at a 60s export interval:\n  ${problems.join('\n  ')}`);
  });

  test('every template variable referenced by a query is declared', () => {
    const d = loadDashboard();
    const declared = new Set([...d.templating.list.map((v) => v.name), ...BUILTIN_VARIABLES]);
    const texts = [
      ...allTargets(d).map((t) => ({ where: `panel: ${t.panel}`, text: t.expr ?? '' })),
      ...templateQueries(d).map(({ variable, query }) => ({ where: `$${variable} query`, text: query })),
    ];
    const undeclared = [];
    for (const { where, text } of texts) {
      let scanned = text;
      try {
        for (const c of promqlFacts(parsePromQL(text)).calls.filter((x) => x.fn === 'label_replace')) {
          const lit = c.args[2];
          if (lit?.type === 'string') scanned = scanned.slice(0, lit.pos) + ' '.repeat(lit.raw.length) + scanned.slice(lit.pos + lit.raw.length);
        }
      } catch { /* not PromQL — scan it whole */ }
      for (const [, braced, bare, bracketed] of scanned.matchAll(/\$\{(\w+)(?::[^}]*)?\}|\$(\w+)|\[\[(\w+)(?::[^\]]*)?\]\]/g)) {
        const name = braced ?? bare ?? bracketed;
        if (!declared.has(name)) undeclared.push(`$${name} (${where})`);
      }
    }
    assert.deepEqual(undeclared, []);
  });

  // The dashboard must show agency and nothing else: every selector carries the
  // environment and the service, the service variable's All is agency's regex
  // (the alert rules' selector), and the variables list agency's series only.
  test('every query is scoped to $environment and to agency\'s $service_name', () => {
    const d = loadDashboard();
    const regex = agencyRegex();
    assert.ok(regex, 'grafana/terraform/variables.tf: no agency_service_name_regex default');
    const problems = [];
    for (const e of allExpressions(d).filter((x) => x.ast && x.target)) {
      for (const sel of promqlFacts(e.ast).selectors) {
        if (!hasMatcher(sel, ENV_MATCHER)) problems.push(`${e.where}: ${sel.name ?? 'a nameless selector'} lacks deployment_environment=~"$environment"`);
        if (!hasMatcher(sel, SVC_MATCHER)) problems.push(`${e.where}: ${sel.name ?? 'a nameless selector'} lacks service_name=~"$service_name"`);
      }
    }
    for (const t of allTargets(d).filter((x) => x.dsType === 'loki')) {
      if (!/\{service_name=~"\$service_name"\}/.test(t.expr ?? '')) problems.push(`${t.panel} / ${t.refId}: Loki stream not scoped to $service_name`);
      if (!/deployment_environment=~"\$environment"/.test(t.expr ?? '')) problems.push(`${t.panel} / ${t.refId}: Loki query not scoped to $environment`);
    }
    const svc = d.templating.list.find((v) => v.name === 'service_name');
    if (!svc) problems.push('no service_name variable');
    else {
      if (svc.allValue !== regex) problems.push(`$service_name All value is ${JSON.stringify(svc.allValue)}, not agency's regex ${regex}`);
      if (!svc.includeAll) problems.push('$service_name has no All option');
    }
    for (const e of allExpressions(d).filter((x) => x.ast && x.variable)) {
      for (const sel of promqlFacts(e.ast).selectors) {
        const scoped = hasMatcher(sel, SVC_MATCHER) || hasMatcher(sel, { label: 'service_name', op: '=~', value: regex });
        if (!scoped) problems.push(`${e.where}: lists values from beyond agency's services`);
      }
    }
    assert.deepEqual(problems, [], `queries that can reach beyond agency:\n  ${problems.join('\n  ')}`);
  });

  test('every visualisation panel carries a description', () => {
    const panels = allPanels(loadDashboard());
    assert.deepEqual(panels.filter((p) => p.type !== 'row' && !p.description).map((p) => p.title), [], 'panels without a description');
  });
});
