import { describe, it, expect } from 'vitest';
import { buildAnalysisPrompt, buildJsonSchema, uniqueDimensions } from '../../../src/analysis/prompt-builder.js';
import type { ConversationEntry } from '@magick-agency/db/models/conversation-entry.model';
import type { AnalyticsConfig } from '@magick-agency/db/models/prompt.model';


function makeConversationLog(turns: number): ConversationEntry[] {
  return Array.from({ length: turns }, (_, i) => ({
    role: i % 2 === 0 ? 'assistant' as const : 'user' as const,
    content: `Turn ${i} content`,
    timestamp: new Date(Date.now() + i * 1000).toISOString(),
    language: 'en',
  }));
}

const emptyConfig: AnalyticsConfig = { custom_dimensions: [] };

const customConfig: AnalyticsConfig = {
  custom_dimensions: [
    { key: 'payment_intent', description: 'Whether the recipient expressed willingness to pay', type: 'boolean' },
    { key: 'objection_category', description: 'Primary objection raised', type: 'enum', options: ['affordability', 'dispute', 'timing'] },
    { key: 'satisfaction_score', description: 'Satisfaction on a 1-10 scale', type: 'number' },
    { key: 'key_takeaway', description: 'One sentence summarizing the key takeaway', type: 'string' },
  ],
};

describe('buildAnalysisPrompt', () => {
  it('includes common analysis instructions in system prompt', () => {
    const { systemPrompt } = buildAnalysisPrompt(makeConversationLog(4), emptyConfig, 200);
    expect(systemPrompt).toContain('overall_sentiment');
    expect(systemPrompt).toContain('turn_sentiments');
    expect(systemPrompt).toContain('key_topics');
    expect(systemPrompt).toContain('conversation_quality');
    expect(systemPrompt).toContain('summary');
  });

  it('includes custom dimensions in system prompt when provided', () => {
    const { systemPrompt } = buildAnalysisPrompt(makeConversationLog(4), customConfig, 200);
    expect(systemPrompt).toContain('Custom Dimensions');
    expect(systemPrompt).toContain('payment_intent');
    expect(systemPrompt).toContain('objection_category');
    expect(systemPrompt).toContain('affordability');
    expect(systemPrompt).toContain('satisfaction_score');
    expect(systemPrompt).toContain('key_takeaway');
  });

  it('does not include custom dimensions section when empty', () => {
    const { systemPrompt } = buildAnalysisPrompt(makeConversationLog(4), emptyConfig, 200);
    expect(systemPrompt).not.toContain('Custom Dimensions');
  });

  it('formats transcript in user prompt', () => {
    const log = makeConversationLog(4);
    const { userPrompt } = buildAnalysisPrompt(log, emptyConfig, 200);
    expect(userPrompt).toContain('4 turns');
    expect(userPrompt).toContain('ASSISTANT');
    expect(userPrompt).toContain('USER');
    expect(userPrompt).toContain('Turn 0 content');
    expect(userPrompt).toContain('Turn 3 content');
  });

  it('truncates conversation log to maxConversationTurns', () => {
    const log = makeConversationLog(50);
    const { userPrompt } = buildAnalysisPrompt(log, emptyConfig, 10);
    expect(userPrompt).toContain('40 earlier turns omitted');
    expect(userPrompt).toContain('50 turns');
    expect(userPrompt).not.toContain('Turn 0 content');
    expect(userPrompt).toContain('Turn 49 content');
  });

  it('does not truncate when log fits within maxConversationTurns', () => {
    const log = makeConversationLog(5);
    const { userPrompt } = buildAnalysisPrompt(log, emptyConfig, 200);
    expect(userPrompt).not.toContain('omitted');
    expect(userPrompt).toContain('Turn 0 content');
  });

  it('handles language tags in transcript', () => {
    const log: ConversationEntry[] = [
      { role: 'assistant', content: 'Hello', timestamp: new Date().toISOString(), language: 'hi-IN' },
    ];
    const { userPrompt } = buildAnalysisPrompt(log, emptyConfig, 200);
    expect(userPrompt).toContain('[hi-IN]');
  });
});

describe('audio input', () => {
  it('tells the model the recording is attached, and how to use it, only in audio mode', () => {
    const audio = buildAnalysisPrompt(makeConversationLog(4), emptyConfig, 200, 'Collections call', { audio: true });
    expect(audio.systemPrompt).toContain('## Call Recording');
    expect(audio.systemPrompt).toContain('HOW things are said');
    expect(audio.systemPrompt).toContain('`turn_index`');
    // Business context stays first; the audio section comes before the common instructions.
    expect(audio.systemPrompt.indexOf('## Business Context')).toBeLessThan(audio.systemPrompt.indexOf('## Call Recording'));
    expect(audio.userPrompt).toContain('using the attached recording and this transcript');

    const text = buildAnalysisPrompt(makeConversationLog(4), emptyConfig, 200, 'Collections call');
    expect(text.systemPrompt).not.toContain('## Call Recording');
    expect(text.userPrompt).not.toContain('attached recording');
  });
});

describe('transcript provenance in the analysis input', () => {
  const log: ConversationEntry[] = [
    { role: 'assistant', content: 'Namaste, this is a recorded introduction.', timestamp: 't0', source: 'intro_clip' },
    { role: 'user', content: 'haan boliye', timestamp: 't1' },
    { role: 'assistant', content: '[Silence]', timestamp: 't2', source: 'silent_marker' },
    { role: 'assistant', content: 'Hello?', timestamp: 't3', source: 'nudge_fallback' },
    { role: 'assistant', content: 'Aapka payment pending hai.', timestamp: 't4' },
  ];

  it('drops a silent_marker entry the caller never heard', () => {
    const { userPrompt } = buildAnalysisPrompt(log, emptyConfig, 200);
    expect(userPrompt).not.toContain('[Silence]');
  });

  it('labels the recording and the canned re-prompt, and leaves model turns as they were', () => {
    const { userPrompt } = buildAnalysisPrompt(log, emptyConfig, 200);
    expect(userPrompt).toContain('[0] ASSISTANT (recording): Namaste, this is a recorded introduction.');
    expect(userPrompt).toContain('[3] ASSISTANT (canned re-prompt): Hello?');
    expect(userPrompt).toContain('[4] ASSISTANT: Aapka payment pending hai.');
  });

  it('counts only the turns it shows: the dropped marker is not a turn', () => {
    const { userPrompt } = buildAnalysisPrompt(log, emptyConfig, 200);
    expect(userPrompt).toContain('## Conversation Transcript (4 turns)');
  });

  it('counts the recording and the canned re-prompt as turns — the caller heard both', () => {
    const platformOnly: ConversationEntry[] = [
      { role: 'assistant', content: 'Recorded intro', timestamp: 't0', source: 'intro_clip' },
      { role: 'assistant', content: 'Hello?', timestamp: 't1', source: 'nudge_fallback' },
    ];
    expect(buildAnalysisPrompt(platformOnly, emptyConfig, 200).userPrompt).toContain('## Conversation Transcript (2 turns)');
  });

  it('a markers-only log formats to no lines and "0 turns" (the call-end gate never sends one)', () => {
    const markers: ConversationEntry[] = [
      { role: 'assistant', content: '[Silence]', timestamp: 't0', source: 'silent_marker' },
      { role: 'assistant', content: '(no response)', timestamp: 't1', source: 'silent_marker', language: 'hi' },
    ];
    const { userPrompt } = buildAnalysisPrompt(markers, emptyConfig, 200);
    expect(userPrompt).toContain('## Conversation Transcript (0 turns)');
    expect(userPrompt).not.toMatch(/\[\d+\] /);
    expect(userPrompt).not.toContain('no response');
  });

  it('drops a marker by its SOURCE, never by its text: an audible "[Silence]" model turn stays in', () => {
    const spoken: ConversationEntry[] = [{ role: 'assistant', content: '[Silence]', timestamp: 't0' }];
    const { userPrompt } = buildAnalysisPrompt(spoken, emptyConfig, 200);
    expect(userPrompt).toContain('[0] ASSISTANT: [Silence]');
    expect(userPrompt).toContain('(1 turns)');
  });

  it('puts the provenance label before the language tag', () => {
    const tagged: ConversationEntry[] = [
      { role: 'assistant', content: 'Hello ji?', timestamp: 't0', source: 'nudge_fallback', language: 'hi' },
    ];
    expect(buildAnalysisPrompt(tagged, emptyConfig, 200).userPrompt).toContain('[0] ASSISTANT (canned re-prompt) [hi]: Hello ji?');
  });

  it('an explicit source "model" is an ordinary turn: no label', () => {
    const explicit: ConversationEntry[] = [{ role: 'assistant', content: 'Namaste', timestamp: 't0', source: 'model' }];
    expect(buildAnalysisPrompt(explicit, emptyConfig, 200).userPrompt).toContain('[0] ASSISTANT: Namaste');
  });

  it('keeps each entry\'s index stable across the dropped marker (turn_index addresses conversation_log)', () => {
    const { userPrompt } = buildAnalysisPrompt(log, emptyConfig, 200);
    expect(userPrompt).toContain('[1] USER: haan boliye');
    expect(userPrompt).not.toMatch(/\[2\] /);
  });
});

// PR #399 review: the maxTurns window counts SPOKEN entries. Markers are dropped
// from the transcript, so letting them take slots showed the model fewer than
// maxTurns real turns and overstated the omitted count.
describe('maxConversationTurns counts spoken turns, not silent markers', () => {
  const marker = (i: number): ConversationEntry =>
    ({ role: 'assistant', content: '[Silence]', timestamp: `m${i}`, source: 'silent_marker' });
  const spokenLines = (prompt: string) => prompt.split('\n').filter((l) => /^\[\d+\] /.test(l));

  it('a tail full of markers still yields maxTurns spoken turns', () => {
    // 20 spoken turns, then 8 markers: the old raw-length slice kept 2 real turns.
    const log = [...makeConversationLog(20), ...Array.from({ length: 8 }, (_, i) => marker(i))];
    const { userPrompt } = buildAnalysisPrompt(log, emptyConfig, 10);
    const lines = spokenLines(userPrompt);
    expect(lines).toHaveLength(10);
    expect(lines[0]).toContain('Turn 10 content');
    expect(lines[9]).toContain('Turn 19 content');
    expect(userPrompt).not.toContain('Turn 9 content');
    expect(userPrompt).not.toContain('[Silence]');
  });

  it('the truncation note counts omitted spoken turns only', () => {
    // Markers interleaved everywhere: 30 spoken, 15 markers, limit 10 → 20 omitted.
    const log = makeConversationLog(30).flatMap((e, i) => (i % 2 === 0 ? [e, marker(i)] : [e]));
    const { userPrompt } = buildAnalysisPrompt(log, emptyConfig, 10);
    expect(userPrompt).toContain('[... 20 earlier turns omitted ...]');
    expect(userPrompt).toContain('(30 turns)');
    expect(spokenLines(userPrompt)).toHaveLength(10);
    expect(userPrompt).toContain('Turn 20 content');
    expect(userPrompt).not.toContain('Turn 19 content');
  });

  it('no truncation note when only the markers push the log over the limit', () => {
    const log = [...makeConversationLog(10), ...Array.from({ length: 5 }, (_, i) => marker(i))];
    const { userPrompt } = buildAnalysisPrompt(log, emptyConfig, 10);
    expect(userPrompt).not.toContain('omitted');
    expect(spokenLines(userPrompt)).toHaveLength(10);
    expect(userPrompt).toContain('Turn 0 content');
  });

  it('numbering is the raw position in the shown window, markers included, as before', () => {
    // 3 spoken, marker, 2 spoken; limit 3 → window starts at "Turn 2": [0] T2, [1] marker (dropped), [2] T3, [3] T4.
    const base = makeConversationLog(5);
    const log = [...base.slice(0, 3), marker(0), ...base.slice(3)];
    const { userPrompt } = buildAnalysisPrompt(log, emptyConfig, 3);
    expect(userPrompt).toContain('[... 2 earlier turns omitted ...]');
    expect(userPrompt).toContain('[0] ASSISTANT [en]: Turn 2 content');
    expect(userPrompt).toContain('[2] USER [en]: Turn 3 content');
    expect(userPrompt).toContain('[3] ASSISTANT [en]: Turn 4 content');
    expect(userPrompt).not.toMatch(/\[1\] /);
  });
});

describe('interrupted lines in the analysis input', () => {
  it('marks a line a barge-in cut off, and only that line', () => {
    const log: ConversationEntry[] = [
      { role: 'assistant', content: 'Aapka payment due hai', timestamp: 't0', interrupted: true },
      { role: 'user', content: 'haan ruko', timestamp: 't1', language: 'hi' },
      { role: 'assistant', content: 'Ji boliye', timestamp: 't2', language: 'hi' },
    ];
    const { userPrompt } = buildAnalysisPrompt(log, emptyConfig, 200);
    expect(userPrompt).toContain('[0] ASSISTANT (cut off): Aapka payment due hai');
    expect(userPrompt).toContain('[1] USER [hi]: haan ruko');
    expect(userPrompt).toContain('[2] ASSISTANT [hi]: Ji boliye');
  });

  it('composes with the provenance and language tags, in that order: role, source, cut off, language', () => {
    const log: ConversationEntry[] = [
      { role: 'assistant', content: 'Hello?', timestamp: 't0', source: 'nudge_fallback', interrupted: true, language: 'hi' },
    ];
    const { userPrompt } = buildAnalysisPrompt(log, emptyConfig, 200);
    expect(userPrompt).toContain('[0] ASSISTANT (canned re-prompt) (cut off) [hi]: Hello?');
  });

  it('`interrupted: false` (or absent) is an ordinary line', () => {
    const log: ConversationEntry[] = [
      { role: 'assistant', content: 'Ji boliye', timestamp: 't0', interrupted: false },
    ];
    const { userPrompt } = buildAnalysisPrompt(log, emptyConfig, 200);
    expect(userPrompt).toContain('[0] ASSISTANT: Ji boliye');
    expect(userPrompt).not.toContain('cut off');
  });

  it('a cut-off line is still a counted turn (it was partly heard), unlike a silent marker', () => {
    const log: ConversationEntry[] = [
      { role: 'assistant', content: 'Aapka EMI', timestamp: 't0', interrupted: true },
      { role: 'assistant', content: '[Silence]', timestamp: 't1', source: 'silent_marker' },
      { role: 'user', content: 'haan', timestamp: 't2' },
    ];
    const { userPrompt } = buildAnalysisPrompt(log, emptyConfig, 200);
    expect(userPrompt).toContain('## Conversation Transcript (2 turns)');
    expect(userPrompt).toContain('[0] ASSISTANT (cut off): Aapka EMI');
  });
});

describe('buildJsonSchema', () => {
  it('returns schema with common and custom properties', () => {
    const schema = buildJsonSchema(emptyConfig);
    expect(schema.name).toBe('call_analysis');
    expect(schema.strict).toBe(true);
    const props = (schema.schema as any).properties;
    expect(props.common).toBeDefined();
    expect(props.custom).toBeDefined();
  });

  it('includes custom dimension properties with correct types', () => {
    const schema = buildJsonSchema(customConfig);
    const customProps = (schema.schema as any).properties.custom.properties;
    expect(customProps.payment_intent.type).toBe('boolean');
    expect(customProps.objection_category.type).toBe('string');
    expect(customProps.objection_category.enum).toEqual(['affordability', 'dispute', 'timing']);
    expect(customProps.satisfaction_score.type).toBe('number');
    expect(customProps.key_takeaway.type).toBe('string');
  });

  it('lists custom dimensions as required', () => {
    const schema = buildJsonSchema(customConfig);
    const customRequired = (schema.schema as any).properties.custom.required;
    expect(customRequired).toContain('payment_intent');
    expect(customRequired).toContain('objection_category');
    expect(customRequired).toContain('satisfaction_score');
    expect(customRequired).toContain('key_takeaway');
  });

  it('has empty custom properties for empty config', () => {
    const schema = buildJsonSchema(emptyConfig);
    const customProps = (schema.schema as any).properties.custom.properties;
    expect(Object.keys(customProps)).toHaveLength(0);
  });

  it('includes all common analysis fields in schema', () => {
    const schema = buildJsonSchema(emptyConfig);
    const commonProps = (schema.schema as any).properties.common.properties;
    expect(commonProps.overall_sentiment).toBeDefined();
    expect(commonProps.turn_sentiments).toBeDefined();
    expect(commonProps.key_topics).toBeDefined();
    expect(commonProps.conversation_quality).toBeDefined();
    expect(commonProps.summary).toBeDefined();
  });
});

describe('duplicate dimension keys in a stored config', () => {
  // Rows saved before the validator rejected duplicates can still carry them; a
  // repeated key must not reach the strict schema's `required` array.
  const dupConfig: AnalyticsConfig = {
    custom_dimensions: [
      { key: 'payment_intent', description: 'First wording', type: 'boolean' },
      { key: 'satisfaction_score', description: 'Satisfaction on a 1-10 scale', type: 'number' },
      { key: 'payment_intent', description: 'Second wording', type: 'enum', options: ['yes', 'no'] },
    ],
  };

  it('keeps the first occurrence of each key', () => {
    expect(uniqueDimensions(dupConfig.custom_dimensions).map((d) => d.description))
      .toEqual(['First wording', 'Satisfaction on a 1-10 scale']);
  });

  it('emits a required list with no repeats, typed from the first occurrence', () => {
    const custom = (buildJsonSchema(dupConfig).schema as any).properties.custom;
    expect(custom.required).toEqual(['payment_intent', 'satisfaction_score']);
    expect(custom.properties.payment_intent).toEqual({ type: 'boolean' });
  });

  it('describes each key once in the prompt, matching the schema', () => {
    const { systemPrompt } = buildAnalysisPrompt(makeConversationLog(2), dupConfig, 200);
    expect(systemPrompt.match(/\*\*payment_intent\*\*/g)).toHaveLength(1);
    expect(systemPrompt).toContain('First wording');
    expect(systemPrompt).not.toContain('Second wording');
  });
});
