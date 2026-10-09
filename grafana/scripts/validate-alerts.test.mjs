/**
 * Static contract between agency's alert rules (`grafana/terraform/alert-rules.tf`)
 * and the metrics agency actually exports.
 *
 * A rule over a metric that does not exist is the quietest failure alerting has:
 * the query returns no series, `no_data_state = "OK"` reads that as healthy, and
 * the rule sits green through the incident it was written for. So every rule is
 * read as TEXT — no Terraform, no Prometheus, no import of the metric modules —
 * and asserted against agency's declarations (`metric-declarations.mjs`):
 *
 *  1. every series a rule selects is declared, through something that reaches
 *     OTLP (Grafana Cloud is fed by OTLP alone), and none is a retired billing
 *     series;
 *  2. every label a rule matches, groups or joins on is declared;
 *  3. every `{{ $labels.x }}` in a description survives the aggregation;
 *  4. every grouping keeps `service_name` (the `deployment` routing label is
 *     templated from it) and none keeps `instance`;
 *  5. the pending-period arithmetic of zero-threshold rate()/increase() rules;
 *  6. every rule selects agency's deployments and nothing else;
 *  7. the routing labels the MagickVoice platform's notification policy keys on
 *     are present and spelled as the platform spells them (this module manages
 *     no routing of its own).
 *
 * PORT NOTE (magick-agency, B6): ported from the MagickVoice superproject's
 * `scripts/validate-grafana-alerts.test.mjs`@e32a5db, cut to one service: the
 * per-file uid prefixes, the core/master/all_services locals and the cross-file
 * scope checks are gone; 6 and 7 are new. See PORTING.md, "Grafana alerting (B6)".
 *
 *   pnpm test:grafana
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  root, loadDeclarations, scraperProblems, parsePromQL, promqlFacts, outputLabels, labelsInScope, RETIRED_SERIES,
} from './metric-declarations.mjs';

const tf = (name) => join(root, 'grafana/terraform', name);
const RULES_FILE = tf('alert-rules.tf');
const UID_PREFIX = 'agy-';

/**
 * Resource attributes Grafana Cloud's OTLP gateway promotes onto every series,
 * plus `le` (histogram buckets), `__name__`, and `otel_metric_overflow` (the
 * attribute the OTel SDK stamps on the series it folds a metric into at its
 * cardinality limit). None is in a declared label set.
 */
const IMPLICIT_LABELS = new Set([
  'deployment_environment', 'service_name', 'service_version', 'job', 'instance', 'le',
  '__name__', 'otel_metric_overflow',
]);

/**
 * `target_info` is minted by the OTLP gateway, and Grafana Cloud moves
 * `service.name` into `job` on it, so `group by (service_name)` over it may be
 * EMPTY — under `no_data_state = "OK"`, a rule healthy forever.
 */
const FORBIDDEN_METRICS = {
  target_info: 'target_info may carry no service_name (Grafana Cloud moves it to job), so a service_name-grouped rule over it can be silently empty — use nodejs_eventloop_utilization_ratio',
};

const PER_PROCESS_LABELS = new Set(['instance', 'service_instance_id']);

/**
 * The MagickVoice platform's `local.deployment_label`
 * (MagickVoice-platform/grafana/terraform/alert-rules.tf). Its notification
 * policy routes on the value this renders, so agency's copy must render
 * exactly the same — a drift here silently re-routes agency's pages.
 */
const PLATFORM_DEPLOYMENT_LABEL = '{{ if match "-Staging$" $labels.service_name }}staging{{ else if match "-Dedicated$" $labels.service_name }}dedicated{{ else if $labels.service_name }}production{{ else }}unknown{{ end }}';

/** The labels a rule may add of its own, and their allowed values (the platform's mute route). */
const RULE_LABELS = { nightly_window: ['mute'] };

/** Resources that belong to the platform module alone (one per stack, or routed to by name). */
const PLATFORM_ONLY_RESOURCES = ['grafana_notification_policy', 'grafana_contact_point', 'grafana_mute_timing', 'grafana_message_template'];

/** Names agency's selector must, and must not, select. */
const AGENCY_NAMES = ['magick-agency', 'magick-agency-Staging', 'magick-agency-Dedicated'];
const FOREIGN_NAMES = [
  'MagickVoice-Orchestrator', 'MagickVoice-Orchestrator-Staging', 'MagickVoice-Orchestrator-Dedicated', 'voice-ai-orchestrator',
  'MagickVoice-Platform', 'MagickVoice-Platform-Staging', 'MagickVoice-Platform-Dedicated', 'magick-master',
  'agency-dev-someone',
];

/** An HCL string literal's value: `\"`, `\n`, `\\`, and `$${` / `%%{` (literal `${` / `%{`). */
function unescape(raw) {
  return raw.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\').replace(/([$%])\1\{/g, '$1{');
}

function hclString(text, pattern) {
  const m = new RegExp(`${pattern}\\s*= "((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  return m && unescape(m[1]);
}

/** `agency_service_name_regex`'s default in variables.tf. */
function agencyRegex() {
  const block = /variable "agency_service_name_regex" \{[\s\S]*?\n\}/.exec(readFileSync(tf('variables.tf'), 'utf8'))?.[0] ?? '';
  return hclString(block, '\\n\\s+default');
}

/** `local.agency` from alerting.tf, with the variable's default substituted. */
function agencySelector() {
  const raw = hclString(readFileSync(tf('alerting.tf'), 'utf8'), '\\n\\s+agency');
  assert.ok(raw, 'alerting.tf: no local.agency');
  return raw.replace('${var.agency_service_name_regex}', agencyRegex());
}

function stringField(block, name) {
  const m = new RegExp(`\\n\\s+${name}\\s+= "((?:[^"\\\\]|\\\\.)*)"`).exec(block);
  return m?.[1];
}

/** One rule record per `uid =` line, running to the next one. */
function parseRules() {
  const text = readFileSync(RULES_FILE, 'utf8');
  const selector = agencySelector();
  const starts = [...text.matchAll(/\n\s+uid\s+= "([a-z0-9-]+)"/g)];
  return starts.map((start, i) => {
    const block = text.slice(start.index, i + 1 < starts.length ? starts[i + 1].index : text.length);
    const rawExpr = unescape(stringField(block, 'expr') ?? '');
    const datasource = stringField(block, 'datasource') ?? 'prom';
    const expr = rawExpr
      .replace(/\$\{local\.agency\}/g, selector)
      .replace(/\$\{local\.([a-z_]+)\}/g, (_, n) => `<unknown local.${n}>`)
      .replace(/\$\{var\.[a-z_]+\}/g, '.*');
    let ast = null;
    let parseError = null;
    if (datasource !== 'loki') {
      try { ast = parsePromQL(expr); } catch (err) { parseError = err.message; }
    }
    const labels = /\n\s+labels\s+= \{([^}]*)\}/.exec(block)?.[1];
    return {
      uid: start[1],
      block,
      rawExpr,
      expr,
      ast,
      parseError,
      facts: ast ? promqlFacts(ast) : { selectors: [], groupings: [], minted: new Set(), ranges: [], calls: [] },
      datasource,
      severity: stringField(block, 'severity'),
      noData: stringField(block, 'no_data_state'),
      op: stringField(block, 'op'),
      forDuration: stringField(block, 'for'),
      threshold: /\n\s+threshold\s+= ([^\n]+)/.exec(block)?.[1].trim(),
      summary: unescape(stringField(block, 'summary') ?? ''),
      description: unescape(stringField(block, 'description') ?? ''),
      labels: labels === undefined ? {} : Object.fromEntries([...labels.matchAll(/(\w+)\s*=\s*("[^"]*"|[\w.]+)/g)].map((m) => [m[1], m[2]])),
    };
  });
}

/** Each named selector, the series it names, and whether it carries agency's filter. */
function selectors(rule, selector) {
  return rule.facts.selectors.filter((s) => s.name).map((node) => {
    const filter = node.matchers.find((m) => m.label === 'service_name');
    return { raw: node.name, scoped: !!filter && `service_name${filter.op}"${filter.value}"` === selector, node };
  });
}

function durationSeconds(d) {
  if (!/^(\d+(ms|s|m|h|d|w))+$/.test(d ?? '')) return NaN;
  const unit = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return [...d.matchAll(/(\d+)(ms|s|m|h|d|w)/g)].reduce((sum, [, n, u]) => sum + Number(n) * unit[u], 0);
}

function windows(node, fn) {
  const out = [];
  const visit = (n) => {
    if (n.type === 'call' && n.fn === fn && n.args[0]?.type === 'range') out.push(durationSeconds(n.args[0].range));
    for (const c of [n.expr, n.left, n.right, ...(n.args ?? [])].filter(Boolean)) visit(c);
  };
  visit(node);
  return out.filter((w) => !Number.isNaN(w));
}

function firingSide(node) {
  if (node.type === 'paren') return firingSide(node.expr);
  if (node.type === 'binary' && (node.op === 'and' || node.op === 'unless')) return firingSide(node.left);
  if (node.type === 'binary' && node.op === 'or') return [...firingSide(node.left), ...firingSide(node.right)];
  return [node];
}

function load() {
  return { rules: parseRules(), declared: loadDeclarations(), selector: agencySelector() };
}

describe('agency alert rules', () => {
  test('parses every rule (a parser that finds nothing would pass everything below)', () => {
    const { rules } = load();
    assert.ok(rules.length >= 10, `only ${rules.length} rules parsed`);
    for (const r of rules) {
      assert.ok(r.rawExpr, `${r.uid} has no expr`);
      assert.doesNotMatch(r.expr, /<unknown local\./, `${r.uid} interpolates a local other than local.agency`);
    }
    const unparsed = rules.filter((r) => r.parseError).map((r) => `${r.uid}: ${r.parseError}`);
    assert.deepEqual(unparsed, [], `PromQL that does not parse:\n  ${unparsed.join('\n  ')}`);
  });

  test('reads agency\'s declarations (a scraper that misreads would pass or fail everything below)', () => {
    const problems = scraperProblems(load().declared);
    assert.deepEqual(problems, [], `metric declarations misread:\n  ${problems.join('\n  ')}`);
  });

  test('uids are unique, fit Grafana\'s 40-character limit, and carry the agy- prefix', () => {
    const uids = load().rules.map((r) => r.uid);
    assert.deepEqual(uids.filter((u) => u.length > 40), [], 'uids over 40 characters');
    assert.deepEqual(uids.filter((u, i) => uids.indexOf(u) !== i), [], 'duplicate rule uids');
    assert.deepEqual(uids.filter((u) => !u.startsWith(UID_PREFIX)), [], `uids without ${UID_PREFIX}`);
  });

  test('every rule has a severity, a threshold, a summary and a description', () => {
    const problems = [];
    for (const r of load().rules) {
      if (!['critical', 'warning'].includes(r.severity)) problems.push(`${r.uid}: severity ${r.severity}`);
      if (!['gt', 'lt'].includes(r.op)) problems.push(`${r.uid}: op ${r.op}`);
      if (!['OK', 'Alerting', 'NoData'].includes(r.noData)) problems.push(`${r.uid}: no_data_state ${r.noData}`);
      if (Number.isNaN(durationSeconds(r.forDuration))) problems.push(`${r.uid}: for "${r.forDuration}"`);
      if (!r.threshold) problems.push(`${r.uid}: no threshold`);
      if (r.summary.length < 10) problems.push(`${r.uid}: summary missing`);
      if (r.description.length < 80) problems.push(`${r.uid}: description is not a runbook (${r.description.length} chars)`);
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  });

  // One process, one service: nothing here may watch core's or master's series
  // (the platform module does), and nothing may reach past agency's selector.
  test('every rule selects agency\'s deployments and nothing else', () => {
    const { rules, selector } = load();
    const problems = [];
    for (const r of rules) {
      const scopes = [...r.rawExpr.matchAll(/\$\{(local\.[a-z_]+|var\.[a-z_]+)\}/g)].map((m) => m[1]);
      const allowed = r.datasource === 'loki' ? 'var.agency_service_name_regex' : 'local.agency';
      if (scopes.length === 0) problems.push(`${r.uid}: selects no service at all`);
      for (const x of scopes.filter((y) => y !== allowed)) problems.push(`${r.uid}: uses \${${x}} — use \${${allowed}} only`);
      if (r.datasource !== 'loki') {
        for (const s of r.facts.selectors) {
          const filter = s.matchers.find((m) => m.label === 'service_name');
          if (!filter || `service_name${filter.op}"${filter.value}"` !== selector) {
            problems.push(`${r.uid}: ${s.name ?? 'a nameless selector'} is not scoped to \${local.agency}`);
          }
        }
      }
    }
    assert.deepEqual(problems, [], `rules not scoped to agency:\n  ${problems.join('\n  ')}`);
  });

  test('agency\'s service regex selects its three deployments and no other service\'s names', () => {
    const text = agencyRegex();
    assert.ok(text, 'variables.tf: no default for agency_service_name_regex');
    const re = new RegExp(`^(?:${text})$`); // PromQL and Go's match() both anchor this way
    assert.deepEqual(AGENCY_NAMES.filter((n) => !re.test(n)), [], `${text} misses an agency deployment`);
    assert.deepEqual(FOREIGN_NAMES.filter((n) => re.test(n)), [], `${text} selects a name that is not an agency deployment`);
  });

  test('every metric a rule selects is declared, and none is a retired billing series', () => {
    const { rules, declared, selector } = load();
    const missing = [];
    for (const r of rules.filter((x) => x.datasource === 'prom')) {
      for (const sel of selectors(r, selector)) {
        const metric = declared.series.get(sel.raw)?.name ?? sel.raw;
        if (FORBIDDEN_METRICS[sel.raw]) missing.push(`${r.uid}: ${FORBIDDEN_METRICS[sel.raw]}`);
        else if (RETIRED_SERIES.includes(metric)) missing.push(`${r.uid}: ${sel.raw} is a retired billing series`);
        else if (!declared.series.has(sel.raw)) missing.push(`${r.uid}: ${sel.raw} is not a series agency exports`);
      }
    }
    assert.deepEqual(missing, [], `rules over series that do not exist:\n  ${missing.join('\n  ')}`);
  });

  test('agency declares none of the series retired with billing', () => {
    const { declarations } = load().declared;
    const back = RETIRED_SERIES.filter((n) => declarations.has(n)).map((n) => `${n} (${declarations.get(n).origin})`);
    assert.deepEqual(back, [], `agency declares a retired billing series:\n  ${back.join('\n  ')}`);
  });

  test('every metric a rule selects has an OTel instrument (Grafana Cloud only sees OTLP)', () => {
    const { rules, declared, selector } = load();
    const notOtel = [];
    for (const r of rules.filter((x) => x.datasource === 'prom')) {
      for (const sel of selectors(r, selector)) {
        const d = declared.series.get(sel.raw);
        if (d && !d.otel) notOtel.push(`${r.uid}: ${d.name} (declared via ${d.facade})`);
      }
    }
    assert.deepEqual(notOtel, [], `series with no OTel instrument never reach Grafana Cloud:\n  ${notOtel.join('\n  ')}`);
  });

  // Per selector: a matcher filters its OWN metric's raw series; a label list
  // may name what the selectors beneath it carry, or what is minted beneath it.
  test('every label a rule matches, groups or joins on is declared', () => {
    const { rules, declared } = load();
    const problems = [];
    for (const r of rules.filter((x) => x.datasource === 'prom')) {
      const own = (node) => new Set([...IMPLICIT_LABELS, ...((node.name && declared.series.get(node.name)?.labels) ?? [])]);
      for (const sel of r.facts.selectors) {
        const allowed = own(sel);
        for (const { label } of sel.matchers) if (!allowed.has(label)) problems.push(`${r.uid}: matcher ${label} on ${sel.name ?? 'a nameless selector'}`);
      }
      for (const g of r.facts.groupings) {
        const allowed = labelsInScope(g.node, own);
        for (const l of g.labels) if (!allowed.has(l)) problems.push(`${r.uid}: ${g.kind} (${l})`);
      }
    }
    assert.deepEqual(problems, [], `labels no selected metric declares:\n  ${problems.join('\n  ')}`);
  });

  test('every {{ $labels.x }} in a description survives the rule\'s aggregation', () => {
    const { rules, declared } = load();
    const problems = [];
    for (const r of rules.filter((x) => x.ast)) {
      const placeholders = [...r.description.matchAll(/\{\{\s*\$labels\.(\w+)\s*\}\}/g)].map((m) => m[1]);
      if (placeholders.length === 0) continue;
      const selectorLabels = (node) => {
        const d = node.name && declared.series.get(node.name);
        return d ? new Set([...IMPLICIT_LABELS, ...d.labels]) : null;
      };
      const { labels: kept } = outputLabels(r.ast, selectorLabels);
      if (kept === null) continue;
      for (const p of placeholders) if (!kept.has(p)) problems.push(`${r.uid}: {{ $labels.${p} }} (kept: ${[...kept].join(', ') || 'none'})`);
    }
    assert.deepEqual(problems, [], `placeholders that always render empty:\n  ${problems.join('\n  ')}`);
  });

  test('every grouping keeps service_name, so the deployment routing label resolves', () => {
    const problems = [];
    for (const r of load().rules.filter((x) => x.ast)) {
      for (const g of r.facts.groupings.filter((x) => x.kind !== 'without' && x.kind !== 'ignoring')) {
        for (const l of g.labels.filter((x) => PER_PROCESS_LABELS.has(x))) problems.push(`${r.uid}: ${g.kind} (${g.labels.join(', ')}) keeps ${l}`);
      }
      const gs = r.facts.groupings.filter((g) => g.kind !== 'group_left' && g.kind !== 'group_right');
      if (gs.length === 0) problems.push(`${r.uid}: no grouping at all — the result has no service_name`);
      for (const g of gs) {
        if (g.kind !== 'by' && g.kind !== 'on') problems.push(`${r.uid}: ${g.kind} (...) — use by/on`);
        else if (!g.labels.includes('service_name')) problems.push(`${r.uid}: ${g.kind} (${g.labels.join(', ')})`);
      }
    }
    assert.deepEqual(problems, [], `groupings that drop service_name or keep instance:\n  ${problems.join('\n  ')}`);
  });

  test('a zero-threshold rate() rule waits strictly longer than its rate window', () => {
    const problems = [];
    for (const r of load().rules.filter((x) => x.ast && x.threshold === '0' && x.op === 'gt')) {
      for (const w of windows(r.ast, 'rate')) if (durationSeconds(r.forDuration) <= w) problems.push(`${r.uid}: for ${r.forDuration} <= rate window ${w}s`);
    }
    assert.deepEqual(problems, [], `one increment satisfies the pending period:\n  ${problems.join('\n  ')}`);
  });

  test('a zero-threshold increase() rule\'s for is never equal to its window', () => {
    const problems = [];
    for (const r of load().rules.filter((x) => x.ast && x.threshold === '0' && x.op === 'gt')) {
      for (const w of firingSide(r.ast).flatMap((n) => windows(n, 'increase'))) {
        if (durationSeconds(r.forDuration) === w) problems.push(`${r.uid}: for ${r.forDuration} == increase window ${w}s`);
      }
    }
    assert.deepEqual(problems, [], `pending periods on the window boundary:\n  ${problems.join('\n  ')}`);
  });

  test('every expression has balanced delimiters', () => {
    const pairs = { '(': ')', '{': '}', '[': ']' };
    const unbalanced = [];
    for (const r of load().rules) {
      const stack = [];
      for (const ch of r.expr.replace(/"(?:[^"\\]|\\.)*"/g, '""')) {
        if (pairs[ch]) stack.push(pairs[ch]);
        else if (Object.values(pairs).includes(ch) && stack.pop() !== ch) { unbalanced.push(r.uid); break; }
      }
      if (stack.length) unbalanced.push(r.uid);
    }
    assert.deepEqual([...new Set(unbalanced)], [], 'unbalanced expressions');
  });

  // The platform module owns the stack's one notification policy; these alerts
  // reach Slack and PagerDuty only by carrying the labels it routes on.
  test('every rule carries the platform\'s routing labels, and this module manages no routing', () => {
    const alerting = readFileSync(tf('alerting.tf'), 'utf8');
    const problems = [];
    const labelsBlock = /\n\s+labels = merge\(\{([^}]*)\}, try\(rule\.value\.labels, \{\}\)\)/.exec(alerting)?.[1];
    if (!labelsBlock) problems.push('alerting.tf: the rule group\'s labels = merge({...}, try(rule.value.labels, {})) block is missing');
    else {
      const want = { severity: 'rule.value.severity', service: '"agency"', component: 'each.key', deployment: 'local.deployment_label' };
      for (const [k, v] of Object.entries(want)) {
        if (!new RegExp(`\\n\\s+${k}\\s+= ${v.replace(/[.()"]/g, '\\$&')}\\s*\\n`).test(labelsBlock)) problems.push(`alerting.tf: rule label ${k} must be ${v}`);
      }
    }
    if (hclString(alerting, '\\n\\s+deployment_label') !== PLATFORM_DEPLOYMENT_LABEL) {
      problems.push('alerting.tf: local.deployment_label differs from the platform\'s — the notification policy would route agency\'s alerts differently');
    }
    for (const r of load().rules) {
      for (const [k, v] of Object.entries(r.labels)) {
        if (!RULE_LABELS[k]) problems.push(`${r.uid}: label ${k} — rules may set only ${Object.keys(RULE_LABELS).join(', ')} (the routing labels come from alerting.tf)`);
        else if (!RULE_LABELS[k].includes(v.replace(/"/g, ''))) problems.push(`${r.uid}: ${k} = ${v}`);
      }
    }
    for (const file of readdirSync(tf('')).filter((f) => f.endsWith('.tf'))) {
      for (const res of PLATFORM_ONLY_RESOURCES) {
        if (new RegExp(`resource "${res}"`).test(readFileSync(tf(file), 'utf8'))) problems.push(`${file}: ${res} belongs to the platform module, not here`);
      }
    }
    assert.deepEqual(problems, [], `routing contract with the platform module broken:\n  ${problems.join('\n  ')}`);
  });
});
