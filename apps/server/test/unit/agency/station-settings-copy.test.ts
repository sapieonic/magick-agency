import { describe, expect, it } from 'vitest';
import { validateDailyTargetCalls } from '../../../src/agency/campaign-config.js';
import { stationTileIssues } from '../../../src/agency/station-tiles.js';
import { agentScriptIssues } from '../../../src/agency/agent-script.js';
import { contextDisplayIssues } from '../../../src/agency/customer-facts.js';

/**
 * The agent station's campaign settings speak to a supervisor (AS15): every refusal the redesign
 * added (the daily target, the number display, tile pictures, the script, the customer facts' roles
 * and types) is a plain sentence with no field name and no wire code; `field` says which setting.
 * FALSIFIED: put a field name back in any one message (`daily_target_calls must be …`) and this reds.
 */
const bad: Array<[string, Record<string, unknown>]> = [
  ['daily target', { daily_target_calls: 0 }],
  ['number display', { phone_display: 'hidden' }],
  ['an outcome\'s picture', { disposition_catalog: [{ code: 'paid', label: 'Paid', icon: 'unicorn' }] }],
  ['a break\'s picture', { break_reasons: [{ code: 'tea', label: 'Tea', icon: null }] }],
  ['script not an object', { agent_script: [] }],
  ['script unknown part', { agent_script: { title: 'x' } }],
  ['script opening too long', { agent_script: { opening: 'x'.repeat(301) } }],
  ['script steps not a list', { agent_script: { steps: 'Ask' } }],
  ['script step not an object', { agent_script: { steps: ['Ask'] } }],
  ['script step unknown part', { agent_script: { steps: [{ text: 'Ask', done: true }] } }],
  ['script unknown placeholder', { agent_script: { opening: 'Hello {Name}' } }],
  ['roles not an object', { context_display: { roles: ['Name'] } }],
  ['unknown role', { context_display: { roles: { phone: 'Mobile' } } }],
  ['types not an object', { context_display: { types: 'money' } }],
  ['unknown type', { context_display: { types: { Amount: 'currency' } } }],
  // AS19: the card's chosen facts and the script's keys per campaign.
  ['facts not a list', { context_display: { facts: { column: 'A' } } }],
  ['a fifth fact', { context_display: { facts: ['a', 'b', 'c', 'd', 'e'].map((k) => ({ column: k, label: k, key: k })) } }],
  ['a fact not an object', { context_display: { facts: ['Amount'] } }],
  ['a fact\'s unknown part', { context_display: { facts: [{ column: 'A', label: 'A', key: 'a', colour_code: 1 }] } }],
  ['a fact\'s column hidden', { context_display: { hidden: ['A'], facts: [{ column: 'A', label: 'A', key: 'a' }] } }],
  ['a fact\'s column is the name', { context_display: { roles: { name: 'A' }, facts: [{ column: 'A', label: 'A', key: 'a' }] } }],
  ['two facts on one column', { context_display: { facts: [{ column: 'A', label: 'A', key: 'a' }, { column: 'a', label: 'B', key: 'b' }] } }],
  ['a fact\'s column too long', { context_display: { facts: [{ column: 'x'.repeat(201), label: 'A', key: 'a' }] } }],
  ['a fact with no name', { context_display: { facts: [{ column: 'A', label: ' ', key: 'a' }] } }],
  ['a fact\'s name too long', { context_display: { facts: [{ column: 'A', label: 'x'.repeat(17), key: 'a' }] } }],
  ['two facts with one name', { context_display: { facts: [{ column: 'A', label: 'A', key: 'a' }, { column: 'B', label: 'a', key: 'b' }] } }],
  ['a fact\'s key badly formed', { context_display: { facts: [{ column: 'A', label: 'A', key: 'Due Date' }] } }],
  ['a fact\'s key too long', { context_display: { facts: [{ column: 'A', label: 'A', key: 'k'.repeat(33) }] } }],
  ['a fact\'s key is a fixed one', { context_display: { facts: [{ column: 'A', label: 'A', key: 'campaign_name' }] } }],
  ['two facts with one key', { context_display: { facts: [{ column: 'A', label: 'A', key: 'a' }, { column: 'B', label: 'B', key: 'a' }] } }],
  ['a highlight not on or off', { context_display: { facts: [{ column: 'A', label: 'A', key: 'a', highlight: 1 }] } }],
  ['two highlights', { context_display: { facts: [{ column: 'A', label: 'A', key: 'a', highlight: true }, { column: 'B', label: 'B', key: 'b', highlight: true }] } }],
  ['a script key that is not a fact', { context_display: { facts: [] }, agent_script: { opening: 'From {branch_code}' } }],
  ['script keys that are not facts', { context_display: { facts: [] }, agent_script: { opening: 'From {branch} and {emi}' } }],
];

function messages(record: Record<string, unknown>): string[] {
  return [
    ...validateDailyTargetCalls(record),
    ...stationTileIssues(record),
    ...agentScriptIssues(record),
    ...contextDisplayIssues(record),
  ].map((i) => i.message);
}

describe('the station settings\' refusals are words for a supervisor', () => {
  it.each(bad)('%s: refused, in a sentence with no field name or wire code', (_label, record) => {
    const said = messages(record);
    expect(said.length).toBeGreaterThan(0);
    for (const said1 of said) {
      // The script's placeholders (`{amount_due}`) are what a supervisor types in the script, so a
      // refusal may name them; nothing else may be an identifier.
      const m = said1.replace(/\{[a-z_]+\}/g, '{…}');
      // A snake_case identifier is a field name or a wire code (`daily_target_calls`, `amount_due`).
      expect(m, m).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
      for (const code of ['phone_display', 'agent_script', 'context_display', 'masked', 'icon must', 'null', 'rupee', 'thumbs_up']) {
        expect(m, m).not.toContain(code);
      }
      expect(m, m).toMatch(/^[A-Z'"{]/);
      expect(m.endsWith('.'), m).toBe(true);
    }
  });

  it('AS19: taking away a fact the stored script uses, in the words the spec gives', () => {
    const stored = { context_display: { facts: [{ column: 'Due Date', label: 'Due on', key: 'due_date' }] }, agent_script: { opening: 'By {due_date}.' } };
    expect(agentScriptIssues({ context_display: { facts: [] } }, stored)).toEqual([
      { field: 'context_display.facts', message: 'The script uses {due_date}. Take it out of the script first, or keep the fact.' },
    ]);
  });

  it('the daily target in the station\'s words, with Indian grouping', () => {
    expect(messages({ daily_target_calls: 2001 })).toEqual(['Daily target must be a whole number from 1 to 2,000. Leave it empty for no target.']);
  });
});
