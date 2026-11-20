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
    expect(issues(null)).toEqual(['agent_script: agent_script must be an object with an opening line and steps. Send {} for no script.']);
    expect(issues(['Namaste'])).toHaveLength(1);
    expect(issues('Namaste')).toHaveLength(1);
    expect(issues({ opening: 'Hi', title: 'x' })).toEqual([
      "agent_script.title: Unknown script field 'title'. A script has only an opening line and steps.",
    ]);
    expect(issues({ opening: 42 })).toEqual(['agent_script.opening: The opening line must be text.']);
    expect(issues({ steps: 'Ask' })).toEqual(['agent_script.steps: steps must be a list of steps.']);
    expect(issues({ steps: ['Ask'] })).toEqual(['agent_script.steps[0]: Each step must be an object with its text.']);
    expect(issues({ steps: [{ text: 'Ask', done: true }] })).toEqual([
      "agent_script.steps[0].done: Unknown step field 'done'. A step has only its text.",
    ]);
  });

  it('both campaign-config validators refuse what the rule refuses, keyed on the field', () => {
    for (const validate of [validateInternal, validatePublic]) {
      expect(validate({ agent_script: SCRIPT })).toEqual([]);
      expect(validate({ agent_script: { steps: [{ text: 'Hi {customer_name}' }] } }).map((i) => i.field))
        .toEqual(['agent_script.steps[0].text']);
    }
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
