import type { ConversationEntry } from '@magick-agency/db/models/conversation-entry.model';
import type { AnalyticsConfig, AnalyticsDimension } from '@magick-agency/db/models/prompt.model';
import { isSpokenEntry } from '../core/transcript-quality.js';

const COMMON_ANALYSIS_INSTRUCTIONS = `You are a post-call analysis system. Analyze the following conversation transcript and produce a structured JSON analysis.

## Common Analysis (always required)

Evaluate these dimensions for every conversation:

1. **overall_sentiment**: The overall emotional tone of the conversation.
   - label: one of "positive", "negative", "neutral", or "mixed"
   - score: a number from -1.0 (most negative) to 1.0 (most positive)

2. **turn_sentiments**: Per-turn sentiment analysis. For each conversation turn, provide:
   - turn_index: zero-based index of the turn
   - role: "assistant" or "user"
   - sentiment: { label, score } same format as overall_sentiment

3. **key_topics**: An array of 3 to 7 key topics or themes discussed in the conversation. Use short descriptive phrases.

4. **conversation_quality**: Evaluate the quality of the interaction:
   - coherence: 0-10 score for how logical and well-structured the conversation flowed
   - resolution_achieved: boolean — whether the conversation reached a meaningful conclusion or resolution
   - effectiveness_score: 0-10 score for how effectively the assistant handled the interaction

5. **summary**: A concise 2-3 sentence summary of what happened in the conversation.`;

/**
 * Drops repeated dimension keys, keeping the FIRST occurrence. The validators
 * reject duplicates at save time (`analyticsDimensionsSchema`), but rows written
 * before that check — and snapshots already taken from them — can still carry
 * one, and a duplicate key puts a duplicate entry in the strict JSON schema's
 * `required` array, which the provider rejects: every analysis for that
 * prompt/profile fails. The prompt text and the schema both read this list, so
 * the model is never told about a dimension the schema does not contain.
 */
export function uniqueDimensions(dimensions: AnalyticsDimension[]): AnalyticsDimension[] {
  const seen = new Set<string>();
  return dimensions.filter((d) => {
    if (seen.has(d.key)) return false;
    seen.add(d.key);
    return true;
  });
}

function buildCustomDimensionsPrompt(dimensions: AnalyticsDimension[]): string {
  if (dimensions.length === 0) return '';

  const lines = dimensions.map((d) => {
    let typeDesc: string;
    switch (d.type) {
      case 'boolean':
        typeDesc = 'true or false';
        break;
      case 'number':
        typeDesc = 'a number';
        break;
      case 'enum':
        typeDesc = `one of: ${d.options?.map(o => `"${o}"`).join(', ')}`;
        break;
      case 'string':
      default:
        typeDesc = 'a short text string';
        break;
    }
    return `- **${d.key}** (${typeDesc}): ${d.description}`;
  });

  return `\n\n## Custom Dimensions

Evaluate these additional dimensions specific to this use case. Return each as a key-value pair in the "custom" object:

${lines.join('\n')}`;
}

function formatTranscript(conversationLog: ConversationEntry[], maxTurns: number): string {
  let turns = conversationLog;
  let truncationNote = '';

  // The limit counts SPOKEN entries. A `[Silence]` marker is dropped below and
  // is not a turn, so letting markers take slots showed the model fewer than
  // `maxTurns` real turns and overstated what was omitted. The window starts at
  // the `maxTurns`-th spoken entry from the end; a marker inside it still holds
  // its raw position in the numbering, as before.
  const spokenTotal = conversationLog.filter(isSpokenEntry).length;
  if (spokenTotal > maxTurns) {
    let start = conversationLog.length;
    for (let kept = 0; kept < maxTurns; start--) {
      if (isSpokenEntry(conversationLog[start - 1]!)) kept++;
    }
    turns = conversationLog.slice(start);
    truncationNote = `[... ${spokenTotal - maxTurns} earlier turns omitted ...]\n\n`;
  }

  // Provenance (`source`, absent on every model turn and on every row written
  // before it existed) labels a line the platform played rather than the model,
  // and drops a `[Silence]` token the caller never heard. Numbering is taken
  // BEFORE the drop so `turn_index` in the result addresses the same entries it
  // always did.
  const formatted = turns.map((entry, i) => {
    if (entry.source === 'silent_marker') return null;
    const langTag = entry.language ? ` [${entry.language}]` : '';
    const sourceTag = entry.source === 'intro_clip'
      ? ' (recording)'
      : entry.source === 'nudge_fallback' ? ' (canned re-prompt)' : '';
    // A barge-in cut this line off: the text is what the model generated, and
    // the caller heard only part of it (`ConversationEntry.interrupted`).
    const cutTag = entry.interrupted ? ' (cut off)' : '';
    return `[${i}] ${entry.role.toUpperCase()}${sourceTag}${cutTag}${langTag}: ${entry.content}`;
  }).filter((line): line is string => line !== null).join('\n');

  return truncationNote + formatted;
}

export interface AnalysisPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export function buildAnalysisPrompt(
  conversationLog: ConversationEntry[],
  analyticsConfig: AnalyticsConfig,
  maxConversationTurns: number,
  context?: string | null,
): AnalysisPrompt {
  const customSection = buildCustomDimensionsPrompt(uniqueDimensions(analyticsConfig.custom_dimensions));
  // Business context (dialer analysis profiles) is prepended so the model reads it
  // before the common/custom instructions. Absent for AI calls — behaviour unchanged.
  const contextSection = context && context.trim()
    ? `## Business Context\n\n${context.trim()}\n\n`
    : '';
  const systemPrompt = contextSection + COMMON_ANALYSIS_INSTRUCTIONS + customSection;

  const transcript = formatTranscript(conversationLog, maxConversationTurns);
  // Counts what the model is shown: a `[Silence]` marker is dropped from the
  // transcript (see formatTranscript), so it is not a turn either.
  const spokenTurns = conversationLog.filter(isSpokenEntry).length;
  const userPrompt = `## Conversation Transcript (${spokenTurns} turns)\n\n${transcript}\n\nAnalyze this conversation and return the structured JSON result.`;

  return { systemPrompt, userPrompt };
}

export function buildJsonSchema(analyticsConfig: AnalyticsConfig): Record<string, unknown> {
  const customProperties: Record<string, unknown> = {};
  const customRequired: string[] = [];

  for (const dim of uniqueDimensions(analyticsConfig.custom_dimensions)) {
    customRequired.push(dim.key);
    switch (dim.type) {
      case 'boolean':
        customProperties[dim.key] = { type: 'boolean' };
        break;
      case 'number':
        customProperties[dim.key] = { type: 'number' };
        break;
      case 'enum':
        customProperties[dim.key] = { type: 'string', enum: dim.options };
        break;
      case 'string':
      default:
        customProperties[dim.key] = { type: 'string' };
        break;
    }
  }

  return {
    name: 'call_analysis',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        common: {
          type: 'object',
          properties: {
            overall_sentiment: {
              type: 'object',
              properties: {
                label: { type: 'string', enum: ['positive', 'negative', 'neutral', 'mixed'] },
                score: { type: 'number' },
              },
              required: ['label', 'score'],
              additionalProperties: false,
            },
            turn_sentiments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  turn_index: { type: 'number' },
                  role: { type: 'string', enum: ['assistant', 'user'] },
                  sentiment: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', enum: ['positive', 'negative', 'neutral', 'mixed'] },
                      score: { type: 'number' },
                    },
                    required: ['label', 'score'],
                    additionalProperties: false,
                  },
                },
                required: ['turn_index', 'role', 'sentiment'],
                additionalProperties: false,
              },
            },
            key_topics: { type: 'array', items: { type: 'string' } },
            conversation_quality: {
              type: 'object',
              properties: {
                coherence: { type: 'number' },
                resolution_achieved: { type: 'boolean' },
                effectiveness_score: { type: 'number' },
              },
              required: ['coherence', 'resolution_achieved', 'effectiveness_score'],
              additionalProperties: false,
            },
            summary: { type: 'string' },
          },
          required: ['overall_sentiment', 'turn_sentiments', 'key_topics', 'conversation_quality', 'summary'],
          additionalProperties: false,
        },
        custom: {
          type: 'object',
          properties: customProperties,
          required: customRequired,
          additionalProperties: false,
        },
      },
      required: ['common', 'custom'],
      additionalProperties: false,
    },
  };
}
