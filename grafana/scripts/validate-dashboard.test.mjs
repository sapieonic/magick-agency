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
 * `$service_name`, whose All value is agency's regex. A rate()/increase() over
 * the compliance and abandonment-cause counters must count a series' first
 * increment (`FIRST_INCREMENT_COUNTERS`), in the one structure that does, and the
 * Answer → Audio Connected panel must draw the grace
 * `packages/domain/src/abandonment-predicate.ts` applies.
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
  parsePromQL, promqlFacts, outputLabels, labelsInScope, walkPromQL,
} from './metric-declarations.mjs';

const dashboardPath = join(root, 'grafana/dashboards/magick-agency-overview.json');

/** Resource attributes promoted onto every OTLP series, plus `le`, `__name__`, `otel_metric_overflow`. */
const IMPLICIT_LABELS = new Set([
  'deployment_environment', 'service_name', 'service_version', 'job', 'instance', 'le', '__name__', 'otel_metric_overflow',
]);

const BUILTIN_VARIABLES = new Set([
  '__rate_interval', '__rate_interval_ms', '__range', '__range_s', '__range_ms', '__interval', '__interval_ms', '__all',
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

/**
 * Counters whose every increment is a number someone reconciles against SQL: the compliance
 * numerator and denominator and the abandonment causes. A series is born at its first increment,
 * already at 1 (a new campaign, and every label set again on each release, which changes
 * `service_version`), and `rate()` / `increase()` take that first sample as the baseline: the
 * increment is lost (23 Nov on Staging: `agency_abandoned_reason_total` read 7 of 11, one lost
 * per new series). Few increments per series, so the loss is a large share of these. A panel
 * over one of these must add the new-series arm (grafana/README.md, "Counting a sparse
 * counter's first increment").
 */
const FIRST_INCREMENT_COUNTERS = new Set(['agency_answered_total', 'agency_abandoned_total', 'agency_abandoned_reason_total']);

const unparen = (n) => { while (n?.type === 'paren') n = n.expr; return n; };

/** A selector's identity: its name and its matchers, order-free. */
function selectorKey(n) {
  const s = unparen(n);
  if (s?.type !== 'selector') return null;
  return `${s.name}{${s.matchers.map((m) => `${m.label}${m.op}${JSON.stringify(m.value)}`).sort().join(',')}}`;
}

const childrenOf = (n) => [n.expr, n.left, n.right, ...(n.args ?? [])].filter(Boolean);

/** Each node's parent, for walking up from a call to the operators around it. */
function parentsOf(ast) {
  const parents = new Map();
  walkPromQL(ast, (n) => { for (const c of childrenOf(n)) parents.set(c, n); });
  return parents;
}

/** The nearest ancestor of `node` that is not a parenthesis. */
function enclosing(parents, node) {
  let p = parents.get(node);
  while (p?.type === 'paren') p = parents.get(p);
  return p;
}

/** `key offset range`, as `node` (parentheses aside). */
const isOffsetOf = (node, key, range) => {
  const o = unparen(node);
  return o?.type === 'offset' && o.offset === range && selectorKey(o.expr) === key;
};

/** `fn(key[range])`, as `node` (parentheses aside). */
const isCallOver = (node, fn, key, range) => {
  const c = unparen(node);
  return c?.type === 'call' && c.fn === fn && c.args.length === 1 && c.args[0].type === 'range'
    && !c.args[0].subquery && c.args[0].range === range && selectorKey(c.args[0].expr) === key;
};

/** A plain binary `op`: no `on`/`ignoring`, no `group_*`, no `bool`. */
const isBinary = (node, op) => node?.type === 'binary' && node.op === op && !node.matching && !node.group && !node.bool;

/** Grafana's interval variables, and the variables that give each in seconds or in milliseconds. */
const INTERVAL_IN_SECONDS = {
  __rate_interval: { s: null, ms: '__rate_interval_ms' },
  __interval: { s: null, ms: '__interval_ms' },
  __range: { s: '__range_s', ms: '__range_ms' },
};
const variableName = (raw) => /^\$(?:\{(\w+)\}|(\w+))$/.exec(raw ?? '')?.slice(1).find(Boolean);

/**
 * Whether `node` is `range` in seconds: `($__rate_interval_ms / 1000)` for `$__rate_interval`
 * (likewise `$__interval`; `$__range_s` or `$__range_ms / 1000` for `$__range`), or the number
 * of seconds for a fixed range (`3600` for `1h`).
 */
function isRangeSeconds(node, range) {
  const n = unparen(node);
  const v = INTERVAL_IN_SECONDS[variableName(range)];
  if (!v) return n?.type === 'number' && durationSeconds(range) > 0 && Number(n.raw) === durationSeconds(range);
  if (n?.type === 'number') return v.s !== null && variableName(n.raw) === v.s;
  const [l, r] = [unparen(n?.left), unparen(n?.right)];
  return isBinary(n, '/') && l?.type === 'number' && variableName(l.raw) === v.ms && r?.type === 'number' && Number(r.raw) === 1000;
}

/**
 * Why `call`, a `rate()`/`increase()` over a first-increment counter, does not count the series
 * born in its window, or null when it does. It must be the old-series arm of exactly
 *
 *   (rate(X[r]) and X offset r) or ((max_over_time(X[r]) unless X offset r) / (r in seconds))
 *   (increase(X[r]) and X offset r) or (max_over_time(X[r]) unless X offset r)
 *
 * with X the same selector throughout. The structure is the point: a search for the two arms
 * anywhere in the expression passes an undivided new-series arm beside a rate (a count added to
 * a per-second rate), `+` in place of `or` (each old series then counted twice wherever both
 * arms have a value) and a correct pair beside a second, plain `rate(X)`.
 */
function firstIncrementProblem(parents, call) {
  const { fn } = call;
  const key = selectorKey(call.args[0].expr);
  const { range } = call.args[0];
  const and = enclosing(parents, call);
  if (!isBinary(and, 'and') || unparen(and.left) !== call || !isOffsetOf(and.right, key, range)) {
    return `is not the left of \`and <the same selector> offset ${range}\``;
  }
  const or = enclosing(parents, and);
  if (!isBinary(or, 'or') || unparen(or.left) !== and) return 'and its `and` is not the left of an `or`';
  let arm = unparen(or.right);
  if (fn === 'rate') {
    if (!isBinary(arm, '/') || !isRangeSeconds(arm.right, range)) {
      return `and the new-series arm is not divided by [${range}] in seconds (a count added to a per-second rate)`;
    }
    arm = unparen(arm.left);
  }
  if (!isBinary(arm, 'unless') || !isCallOver(arm.left, 'max_over_time', key, range) || !isOffsetOf(arm.right, key, range)) {
    return `and the right of its \`or\` is not \`max_over_time(<the same selector>[${range}]) unless <it> offset ${range}\`${fn === 'rate' ? ' over the window in seconds' : ''}`;
  }
  return null;
}

/** Every `rate()`/`increase()` over a first-increment counter in `ast`, and what is wrong with each. */
function firstIncrementProblems(ast) {
  const parents = parentsOf(ast);
  const calls = promqlFacts(ast).calls.filter((c) => ['rate', 'increase'].includes(c.fn) && c.args[0]?.type === 'range'
    && FIRST_INCREMENT_COUNTERS.has(unparen(c.args[0].expr)?.name));
  const problems = calls.flatMap((c) => {
    const why = firstIncrementProblem(parents, c);
    return why ? [`${c.fn}(${unparen(c.args[0].expr).name}[${c.args[0].range}]) ${why}`] : [];
  });
  return { seen: calls.length, problems };
}

/**
 * The abandonment grace in seconds, read from the domain rule itself
 * (`ABANDONMENT_BRIDGE_GRACE_MS`, AG1), so the dashboard cannot drift from it.
 */
function abandonmentGraceSeconds() {
  const source = readFileSync(join(root, 'packages/domain/src/abandonment-predicate.ts'), 'utf8');
  const ms = /export const ABANDONMENT_BRIDGE_GRACE_MS\s*=\s*([\d_]+)\s*;/.exec(source)?.[1];
  assert.ok(ms, 'packages/domain/src/abandonment-predicate.ts: no `export const ABANDONMENT_BRIDGE_GRACE_MS = <number>;`');
  return Number(ms.replaceAll('_', '')) / 1000;
}

const ANSWER_TO_BRIDGE_BUCKET = 'agency_answer_to_bridge_seconds_bucket';

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

  // A counter series is created by its first increment, already at 1, and rate()/increase()
  // measure only growth after their first sample in the window, so the first increment of every
  // new series is lost. On the counters someone reconciles against SQL, every rate()/increase()
  // carries the arm that counts a series born inside its window at its whole value.
  test('every rate()/increase() over a first-increment counter counts the series born in its window', () => {
    const problems = [];
    let seen = 0;
    for (const e of allExpressions(loadDashboard()).filter((x) => x.ast && x.target)) {
      const found = firstIncrementProblems(e.ast);
      seen += found.seen;
      problems.push(...found.problems.map((p) => `${e.where}: ${p}`));
    }
    // Canary: the Throughput and Abandonment Causes panels read these three counters.
    assert.ok(seen >= 3, `only ${seen} rate()/increase() over ${[...FIRST_INCREMENT_COUNTERS].join(', ')} found`);
    assert.deepEqual(problems, [], `panels that undercount by one per new series:\n  ${problems.join('\n  ')}`);
  });

  // The check above on queries written to pass it and to fail it. A check that looks only for an
  // `and` arm and an `unless` arm somewhere in the expression passes the first four broken ones.
  describe('the first-increment check', () => {
    const X = 'agency_abandoned_total{tenant_id=~"$tenant_id"}';
    const NEW = `(max_over_time(${X}[$__rate_interval]) unless ${X} offset $__rate_interval)`;
    const OLD = `(rate(${X}[$__rate_interval]) and ${X} offset $__rate_interval)`;
    const passing = {
      'the panels\' rate form': `sum(${OLD} or (${NEW} / ($__rate_interval_ms / 1000)))`,
      'the rate form per minute': `sum by (reason) (${OLD} or (${NEW} / ($__rate_interval_ms / 1000))) * 60`,
      'a fixed window over its seconds': `sum((rate(${X}[1h]) and ${X} offset 1h) or ((max_over_time(${X}[1h]) unless ${X} offset 1h) / 3600))`,
      'the increase form': `sum((increase(${X}[16h]) and ${X} offset 16h) or (max_over_time(${X}[16h]) unless ${X} offset 16h))`,
      'the increase form over $__range': `sum((increase(${X}[$__range]) and ${X} offset $__range) or (max_over_time(${X}[$__range]) unless ${X} offset $__range))`,
    };
    const failing = {
      'a plain rate': `sum(rate(${X}[$__rate_interval]))`,
      'a plain increase': `sum(increase(${X}[1h]))`,
      'a rate whose new-series arm is not divided by the window': `sum(${OLD} or ${NEW})`,
      '+ in place of or': `sum(${OLD} + (${NEW} / ($__rate_interval_ms / 1000)))`,
      'a correct pair beside a plain rate': `sum(${OLD} or (${NEW} / ($__rate_interval_ms / 1000))) + sum(rate(${X}[$__rate_interval]))`,
      'a new-series arm over the wrong seconds': `sum((rate(${X}[1h]) and ${X} offset 1h) or ((max_over_time(${X}[1h]) unless ${X} offset 1h) / 60))`,
      'the arms swapped round the or': `sum((${NEW} / ($__rate_interval_ms / 1000)) or ${OLD})`,
      'an offset over another range': `sum((increase(${X}[1h]) and ${X} offset 5m) or (max_over_time(${X}[1h]) unless ${X} offset 1h))`,
      'a new-series arm over another selector': `sum((increase(${X}[1h]) and ${X} offset 1h) or (max_over_time(agency_abandoned_total[1h]) unless agency_abandoned_total offset 1h))`,
      'an and under a matching clause': `sum((rate(${X}[$__rate_interval]) and on (campaign_id) ${X} offset $__rate_interval) or (${NEW} / ($__rate_interval_ms / 1000)))`,
    };
    for (const [name, expr] of Object.entries(passing)) {
      test(`passes ${name}`, () => {
        const { seen, problems } = firstIncrementProblems(parsePromQL(expr));
        assert.equal(seen, 1);
        assert.deepEqual(problems, []);
      });
    }
    for (const [name, expr] of Object.entries(failing)) {
      test(`fails ${name}`, () => {
        const { seen, problems } = firstIncrementProblems(parsePromQL(expr));
        assert.ok(seen >= 1, 'the fixture reads no first-increment counter');
        assert.notDeepEqual(problems, [], `passed: ${expr}`);
      });
    }
  });

  // The Answer → Audio Connected panel draws the abandonment grace three ways: the `le` bucket its
  // share reads, the threshold line, and the text that names it. All must be the grace the
  // compliance predicate applies, or changing the grace leaves a panel that measures another rule.
  test('the answer → audio connected panel reads the abandonment grace (ABANDONMENT_BRIDGE_GRACE_MS)', () => {
    const grace = abandonmentGraceSeconds();
    assert.ok(grace > 0, `ABANDONMENT_BRIDGE_GRACE_MS reads as ${grace}s`);
    const d = loadDashboard();
    const panels = allPanels(d).filter((p) => (p.targets ?? []).some((t) => (t.expr ?? '').includes(ANSWER_TO_BRIDGE_BUCKET)));
    assert.equal(panels.length, 1, `${panels.length} panels read ${ANSWER_TO_BRIDGE_BUCKET}`);
    const [panel] = panels;
    const problems = [];
    const shareTargets = new Set();
    for (const t of panel.targets) {
      for (const sel of promqlFacts(parsePromQL(t.expr)).selectors.filter((x) => x.name === ANSWER_TO_BRIDGE_BUCKET)) {
        for (const m of sel.matchers.filter((x) => x.label === 'le')) {
          shareTargets.add(t);
          if (m.op !== '=' || m.value !== String(grace)) problems.push(`${t.refId} reads le${m.op}"${m.value}"`);
        }
      }
    }
    assert.equal(shareTargets.size, 1, `${shareTargets.size} targets read an le bucket of ${ANSWER_TO_BRIDGE_BUCKET}`);
    const steps = (panel.fieldConfig.defaults.thresholds?.steps ?? []).filter((s) => s.value !== null);
    if (steps.length !== 1 || steps[0].value !== grace) problems.push(`threshold steps at ${JSON.stringify(steps.map((s) => s.value))}`);
    const legend = [...shareTargets][0].legendFormat ?? '';
    if (!legend.startsWith(`share over ${grace}s`)) problems.push(`share legend ${JSON.stringify(legend)}`);
    const rendered = legend.replace(/\{\{\s*\w+\s*\}\}/g, 'voicelink');
    const overrides = panel.fieldConfig.overrides.filter((o) => o.matcher.id === 'byRegexp' && /share over/.test(o.matcher.options));
    if (overrides.length !== 1 || !overrides[0].matcher.options.includes(`share over ${grace}s`) || !new RegExp(overrides[0].matcher.options).test(rendered)) {
      problems.push(`share override ${JSON.stringify(overrides.map((o) => o.matcher.options))} for the series ${JSON.stringify(rendered)}`);
    }
    if (!panel.title.includes(`${grace}s grace`)) problems.push(`title ${JSON.stringify(panel.title)}`);
    // Every "Ns grace" and "share over Ns" on the dashboard, and every le="N" this panel's text
    // names, is the grace.
    for (const p of allPanels(d)) {
      const texts = [p.title ?? '', p.description ?? ''];
      const mentions = texts.flatMap((text) => [...text.matchAll(/(\d+(?:\.\d+)?)s grace|share over (\d+(?:\.\d+)?)s\b/g)]);
      if (p === panel) mentions.push(...texts.flatMap((text) => [...text.matchAll(/le="(\d+(?:\.\d+)?)"/g)]));
      for (const m of mentions) if (Number(m[1] ?? m[2]) !== grace) problems.push(`${p.title}: "${m[0]}"`);
    }
    const distinct = [...new Set(problems)];
    assert.deepEqual(distinct, [], `the panel does not read the ${grace}s grace:\n  ${distinct.join('\n  ')}`);
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
