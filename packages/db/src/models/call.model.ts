// PORT NOTE (magick-agency): a SUBSET of core `src/db/models/call.model.ts`
// (v1.123.2, lines 200-232), verbatim. Core's `calls` table (AI calls) is not
// carried; only the post-call analysis result shape survives, because the dialer
// analysis columns on `agency_calls` (`call_analysis`) and the analysis job reuse
// it ("the analysis service is call-type-agnostic"). Kept at core's path so
// `import type { CallAnalysisResult } from './call.model.js'` in ported models
// and repositories compiles unchanged.

export interface SentimentScore {
  label: 'positive' | 'negative' | 'neutral' | 'mixed';
  score: number;
}

export interface TurnSentiment {
  turn_index: number;
  role: 'assistant' | 'user';
  sentiment: SentimentScore;
}

export interface CallAnalysisResult {
  common: {
    overall_sentiment: SentimentScore;
    turn_sentiments: TurnSentiment[];
    key_topics: string[];
    conversation_quality: {
      coherence: number;
      resolution_achieved: boolean;
      effectiveness_score: number;
    };
    summary: string;
  };
  custom: Record<string, unknown>;
  _meta: {
    model: string;
    provider: 'openai' | 'gemini' | 'azure_openai';
    latency_ms: number;
    prompt_tokens: number;
    completion_tokens: number;
    analyzed_at: string;
  };
}
