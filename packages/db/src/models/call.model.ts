// Only the post-call analysis result shape lives here: the dialer analysis
// columns on `agency_calls` (`call_analysis`) and the analysis job use it
// ("the analysis service is call-type-agnostic"). There is no AI-call `calls`
// table, so models and repositories import it with
// `import type { CallAnalysisResult } from './call.model.js'`.

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
    /** `openai` is how rows written before the AI layer's `openai_compatible` name read. */
    provider: 'openai_compatible' | 'azure_openai' | 'gemini' | 'openai';
    /** What the model was given. Absent on rows written before audio input existed (= transcript). */
    input?: 'transcript' | 'audio';
    latency_ms: number;
    prompt_tokens: number;
    completion_tokens: number;
    analyzed_at: string;
  };
}
