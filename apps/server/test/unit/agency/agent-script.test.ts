import { describe, expect, it } from 'vitest';
import {
  AGENCY_SCRIPT_OPENING_MAX_CHARS,
  AGENCY_SCRIPT_STEP_MAX_CHARS,
  AGENCY_SCRIPT_STEPS_MAX,
} from '@magick-agency/contracts/agency';
import {
  agentScriptForBootstrap,
  agentScriptIssues,
  normalizeAgentScript,
  unknownScriptPlaceholders,
} from '../../../src/agency/agent-script.js';
import { validateAgencyCampaignConfig as validateInternal } from '../../../src/agency/campaign-config.js';
import { validateAgencyCampaignConfig as validatePublic } from '../../../src/agency/agency-campaign-config.js';
import { campaignConfigChange } from '../../../src/agency/campaign-config-audit.js';

/**
 * The campaign script (BE-8, `src/agency/agent-script.ts`): the write's rules (shape, bounds,
 * placeholders), the trimmed form it is stored in, and the bootstrap's reading (absent when the
 * campaign has none). The routes and the bootstrap on real Postgres:
 * `test/integration/api/agent-station-script-facts.test.ts`.
 */

const SCRIPT = {
  opening: 'Namaste {name}, I am {agent_name} calling from {campaign_name}.',
  steps: [
    { text: 'Tell them {amount_due} is due on {due_date}.' },
    { text: 'Ask when they can pay.' },
  ],
};

const issues = (script: unknown) => agentScriptIssues({ agent_script: script }).map((i) => `${i.field}: ${i.message}`);

describe('agentScriptIssues: the write', () => {
  it('accepts a script, an opening alone, steps alone, and {} (no script)', () => {
    expect(issues(SCRIPT)).toEqual([]);
    expect(issues({ opening: 'Namaste.' })).toEqual([]);
    expect(issues({ steps: [{ text: 'Ask about the payment.' }] })).toEqual([]);
    expect(issues({})).toEqual([]);
    expect(issues({ steps: [] })).toEqual([]);
    // Absent from the body: nothing to judge.
    expect(agentScriptIssues({ name: 'x' })).toEqual([]);
  });

  it('refuses an unknown placeholder, naming it, and lists the ones it can fill', () => {
    expect(issues({ opening: 'Namaste {customer}, about {amount_due}.' })).toEqual([
      'agent_script.opening: {customer} is not a word the script can fill in. Use only: {name}, {place}, {amount_due}, {due_date}, {agent_name}, {campaign_name}.',
    ]);
    expect(issues({ steps: [{ text: 'ok' }, { text: '{ name } owes {Amount_Due}' }] })).toEqual([
      'agent_script.steps[1].text: { name }, {Amount_Due} are not words the script can fill in. Use only: {name}, {place}, {amount_due}, {due_date}, {agent_name}, {campaign_name}.',
    ]);
    // Every placeholder of the list is accepted; a lone brace is plain text.
    expect(issues({ opening: '{name} {place} {amount_due} {due_date} {agent_name} {campaign_name}' })).toEqual([]);
    expect(issues({ opening: 'Press { to start, } to end.' })).toEqual([]);
    expect(unknownScriptPlaceholders('{x} {name} {x} {} {Name} { place }')).toEqual(['{x}', '{Name}', '{ place }']);
  });

  it('holds the bounds: opening and step length in code points after trimming, at most 12 steps', () => {
    expect(issues({ opening: 'a'.repeat(AGENCY_SCRIPT_OPENING_MAX_CHARS) })).toEqual([]);
    expect(issues({ opening: ` ${'a'.repeat(AGENCY_SCRIPT_OPENING_MAX_CHARS)} ` })).toEqual([]);
    expect(issues({ opening: 'a'.repeat(AGENCY_SCRIPT_OPENING_MAX_CHARS + 1) })).toEqual([
      'agent_script.opening: The opening line must be 1 to 300 characters.',
    ]);
    expect(issues({ opening: '   ' })).toEqual(['agent_script.opening: The opening line must be 1 to 300 characters.']);
    // Telugu and Hindi count by character, not by UTF-16 unit.
    expect(issues({ steps: [{ text: 'నమస్తే'.repeat(Math.floor(AGENCY_SCRIPT_STEP_MAX_CHARS / 6)) }] })).toEqual([]);
    expect(issues({ steps: [{ text: '😀'.repeat(AGENCY_SCRIPT_STEP_MAX_CHARS) }] })).toEqual([]);
    expect(issues({ steps: [{ text: 'a'.repeat(AGENCY_SCRIPT_STEP_MAX_CHARS + 1) }] })).toEqual([
      'agent_script.steps[0].text: Step 1 must be 1 to 200 characters.',
    ]);
    expect(issues({ steps: [{ text: '' }] })).toEqual(['agent_script.steps[0].text: Step 1 must be 1 to 200 characters.']);
    const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `Step ${i + 1}` }));
    expect(issues({ steps: steps(AGENCY_SCRIPT_STEPS_MAX) })).toEqual([]);
    expect(issues({ steps: steps(AGENCY_SCRIPT_STEPS_MAX + 1) })).toEqual(['agent_script.steps: A script can have at most 12 steps.']);
  });

  it('refuses a wrong shape: not an object, unknown keys, steps not a list, a step not { text }', () => {
    expect(issues(null)).toEqual(['agent_script: The script must have an opening line and steps. Leave both empty for no script.']);
    expect(issues(['Namaste'])).toHaveLength(1);
    expect(issues('Namaste')).toHaveLength(1);
    expect(issues({ opening: 'Hi', title: 'x' })).toEqual([
      'agent_script.title: A script has only an opening line and steps.',
    ]);
    expect(issues({ opening: 42 })).toEqual(['agent_script.opening: The opening line must be text.']);
    expect(issues({ steps: 'Ask' })).toEqual(['agent_script.steps: The steps must be a list, one step after another.']);
    expect(issues({ steps: ['Ask'] })).toEqual(['agent_script.steps[0]: Step 1 must have its words.']);
    expect(issues({ steps: [{ text: 'Ask', done: true }] })).toEqual([
      'agent_script.steps[0].done: Step 1 can have only its words.',
    ]);
  });

  it('both campaign-config validators refuse what the rule refuses, keyed on the field', () => {
    for (const validate of [validateInternal, validatePublic]) {
      expect(validate({ agent_script: SCRIPT })).toEqual([]);
      expect(validate({ agent_script: { steps: [{ text: 'Hi', extra: 1 }] } }).map((i) => i.field))
        .toEqual(['agent_script.steps[0].extra']);
    }
    // The keys need the campaign's display (AS19): the internal validator has the stored row (here
    // a create's, no display); the public one only the body's, so it judges keys when the body
    // carries `context_display`, and leaves the rest to the internal handler.
    const unknownKey = { agent_script: { steps: [{ text: 'Hi {customer_name}' }] } };
    expect(validateInternal(unknownKey).map((i) => i.field)).toEqual(['agent_script.steps[0].text']);
    expect(validatePublic(unknownKey)).toEqual([]);
    expect(validatePublic({ ...unknownKey, context_display: {} }).map((i) => i.field)).toEqual(['agent_script.steps[0].text']);
  });
});

describe('the script\'s keys per campaign (AS19): against the resulting context_display, both ways', () => {
  const FACTS = {
    roles: { name: 'Customer Name' },
    facts: [
      { column: 'Amount Due', label: 'Amount', key: 'amount_due' },
      { column: 'Due Date', label: 'Due on', key: 'due_date' },
      { column: 'Branch', label: 'Branch', key: 'branch' },
    ],
  };
  const LEGACY = { hero: ['Loan No'] };
  const said = (record: Record<string, unknown>, base: Parameters<typeof agentScriptIssues>[1] = {}) =>
    agentScriptIssues(record, base).map((i) => `${i.field}: ${i.message}`);

  it('with facts: the fixed keys and each fact\'s key; a legacy-only key is unknown', () => {
    const ok = { opening: '{name} {place} {agent_name} {campaign_name} {amount_due} {due_date} {branch}' };
    expect(said({ agent_script: ok }, { context_display: FACTS })).toEqual([]);
    expect(said({ agent_script: { opening: 'Hi {name} from {branch}.' } }, { context_display: { facts: [] } })).toEqual([
      'agent_script.opening: The script uses {branch}, which is not a fact on the card. Add it as a fact or take it out.',
    ]);
    expect(said({ agent_script: { steps: [{ text: '{emi} and {Branch} and {emi}' }] } }, { context_display: FACTS })).toEqual([
      'agent_script.steps[0].text: The script uses {emi} and {Branch}, which are not facts on the card. Add them as facts or take them out.',
    ]);
    // `facts: []`: only the fixed four.
    expect(said({ agent_script: { opening: '{amount_due}' } }, { context_display: { facts: [] } })).toHaveLength(1);
  });

  it('without facts: the legacy six and the BE-8 wording, exactly as before', () => {
    expect(said({ agent_script: { opening: '{amount_due} {due_date}' } }, { context_display: LEGACY })).toEqual([]);
    expect(said({ agent_script: { opening: 'From {branch}' } }, { context_display: LEGACY })).toEqual([
      'agent_script.opening: {branch} is not a word the script can fill in. Use only: {name}, {place}, {amount_due}, {due_date}, {agent_name}, {campaign_name}.',
    ]);
  });

  it('a script in the body is judged against the body\'s display when it carries one (the pair), else the stored one', () => {
    const script = { opening: 'From {branch}' };
    // Stored legacy, the body brings facts with {branch}: accepted as a pair.
    expect(said({ agent_script: script, context_display: FACTS }, { context_display: LEGACY })).toEqual([]);
    // Stored facts with {branch}, the body takes it away and keeps the script: refused on the script.
    expect(said({ agent_script: script, context_display: { facts: [] } }, { context_display: FACTS })).toEqual([
      'agent_script.opening: The script uses {branch}, which is not a fact on the card. Add it as a fact or take it out.',
    ]);
    // Only the script in the body: the stored facts allow it.
    expect(said({ agent_script: script }, { context_display: FACTS })).toEqual([]);
  });

  it('a display write that takes away a key the stored script uses is refused on context_display.facts', () => {
    const stored = { context_display: FACTS, agent_script: { opening: 'Hi {name}.', steps: [{ text: '{amount_due} by {due_date}, {branch}.' }] } };
    const without = (...keys: string[]) => ({ ...FACTS, facts: FACTS.facts.filter((f) => !keys.includes(f.key)) });
    expect(said({ context_display: without('due_date') }, stored)).toEqual([
      'context_display.facts: The script uses {due_date}. Take it out of the script first, or keep the fact.',
    ]);
    expect(said({ context_display: without('due_date', 'branch') }, stored)).toEqual([
      'context_display.facts: The script uses {due_date} and {branch}. Take them out of the script first, or keep the facts.',
    ]);
    // Back to the legacy model: {branch} goes, {amount_due} and {due_date} stay.
    expect(said({ context_display: LEGACY }, stored)).toEqual([
      'context_display.facts: The script uses {branch}. Take it out of the script first, or keep the fact.',
    ]);
    // A key the script does not use may go; a reorder or rename keeps every key.
    expect(said({ context_display: { ...FACTS, facts: [...FACTS.facts].reverse() } }, stored)).toEqual([]);
    expect(said({ context_display: FACTS }, { ...stored, agent_script: { opening: 'Hi {name}.' } })).toEqual([]);
    expect(said({ context_display: without('branch') }, { ...stored, agent_script: { opening: '{amount_due}' } })).toEqual([]);
    // A legacy campaign moving to facts: its {amount_due} must come along as a fact.
    expect(said({ context_display: { facts: [] } }, { context_display: LEGACY, agent_script: { opening: 'Pay {amount_due}' } })).toEqual([
      'context_display.facts: The script uses {amount_due}. Take it out of the script first, or keep the fact.',
    ]);
    // With the script in the same body, the pair is judged as the script instead.
    expect(said({ context_display: without('branch'), agent_script: { opening: 'Hi.' } }, stored)).toEqual([]);
  });

  it('a key the stored script already could not fill does not block an edit of the card', () => {
    const stored = { context_display: FACTS, agent_script: { opening: 'Hi {Name} at {emi}' } };
    expect(said({ context_display: { facts: [] } }, stored)).toEqual([]);
  });

  it('where the stored campaign is unknown (the public layer): keys only when the body carries the display', () => {
    expect(said({ agent_script: { opening: 'From {branch}' } }, null)).toEqual([]);
    expect(said({ agent_script: { opening: 'From {branch}' }, context_display: { facts: [] } }, null)).toHaveLength(1);
    expect(said({ context_display: { facts: [] } }, null)).toEqual([]);
    // The shape rules still hold.
    expect(said({ agent_script: { opening: '' } }, null)).toEqual(['agent_script.opening: The opening line must be 1 to 300 characters.']);
  });

  it('the internal validator judges the body against the stored row; the public one cannot', () => {
    const body = { agent_script: { opening: 'From {branch}' } };
    expect(validateInternal(body, { context_display: FACTS })).toEqual([]);
    expect(validateInternal(body, { context_display: LEGACY }).map((i) => i.field)).toEqual(['agent_script.opening']);
    expect(validateInternal({ context_display: { facts: [] } }, { context_display: FACTS, agent_script: body.agent_script }).map((i) => i.field))
      .toEqual(['context_display.facts']);
    expect(validatePublic(body)).toEqual([]);
    expect(validatePublic({ ...body, context_display: { facts: [] } }).map((i) => i.field)).toEqual(['agent_script.opening']);
  });
});

describe('normalizeAgentScript: stored trimmed', () => {
  it('trims the opening and every step, and leaves the rest alone', () => {
    expect(normalizeAgentScript({ opening: '  Namaste  ', steps: [{ text: ' Ask. ' }] }))
      .toEqual({ opening: 'Namaste', steps: [{ text: 'Ask.' }] });
    expect(normalizeAgentScript({})).toEqual({});
    expect(normalizeAgentScript(null)).toBeNull();
  });
});

describe('agentScriptForBootstrap: the read', () => {
  it('the script as stored, when it has an opening or a step', () => {
    expect(agentScriptForBootstrap(SCRIPT)).toEqual(SCRIPT);
    expect(agentScriptForBootstrap({ opening: 'Namaste' })).toEqual({ opening: 'Namaste' });
    expect(agentScriptForBootstrap({ steps: [{ text: 'Ask' }] })).toEqual({ steps: [{ text: 'Ask' }] });
  });

  it('absent when the campaign has none: {}, no steps and no opening, or nothing readable', () => {
    expect(agentScriptForBootstrap({})).toBeUndefined();
    expect(agentScriptForBootstrap({ steps: [] })).toBeUndefined();
    expect(agentScriptForBootstrap({ opening: '  ', steps: [{ text: '' }] })).toBeUndefined();
    expect(agentScriptForBootstrap(null)).toBeUndefined();
    expect(agentScriptForBootstrap(undefined)).toBeUndefined();
    expect(agentScriptForBootstrap('Namaste')).toBeUndefined();
  });

  it('lenient on a hand-written row: a malformed part is left out, never a failed join', () => {
    expect(agentScriptForBootstrap({ opening: 7, steps: [{ text: 'Ask' }, 'bare', { text: 3 }, null] }))
      .toEqual({ steps: [{ text: 'Ask' }] });
    const many = Array.from({ length: 20 }, (_, i) => ({ text: `s${i}` }));
    expect(agentScriptForBootstrap({ steps: many })?.steps).toHaveLength(AGENCY_SCRIPT_STEPS_MAX);
  });
});

describe('the audit: a script change is named, never carried', () => {
  it('names agent_script without its kilobytes of text', () => {
    const change = campaignConfigChange({ agent_script: SCRIPT }, { agent_script: {} }, { agent_script: SCRIPT });
    expect(change).toEqual({ fields: ['agent_script'], changes: {} });
    expect(campaignConfigChange({ agent_script: SCRIPT }, { agent_script: SCRIPT }, { agent_script: SCRIPT })).toBeNull();
  });
});
