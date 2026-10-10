/*
 * The factory has no fallback to a live pipeline's key (there are no live pipelines);
 * the fallback lives in the env reader (OPENAI_API_KEY /
 * GEMINI_API_KEY -> `postCallAnalysis.apiKey`) and is tested in
 * test/unit/config/analysis-config.test.ts. "returns null when no API key" now just
 * omits the key.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: vi.fn() } };
    constructor() {}
  },
  AzureOpenAI: class MockAzureOpenAI {
    chat = { completions: { create: vi.fn() } };
    constructor() {}
  },
}));

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  Traced: Object.assign(
    () => (_method: any, _ctx: any) => _method,
    { getSpan: () => ({ setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() }) },
  ),
}));

import { createAnalysisService } from '../../../src/analysis/index.js';
import type { AppConfig } from '../../../src/config/schema.js';

function makeConfig(overrides: Record<string, any> = {}): AppConfig {
  return {
    postCallAnalysis: {
      enabled: true,
      provider: 'openai_compatible',
      model: 'gpt-4o-mini',
      timeoutMs: 30000,
      maxConversationTurns: 200,
      apiKey: 'test-key',
      headers: {},
      structuredOutput: 'json_schema',
      temperature: 0.3,
      azureApiVersion: '2024-12-01-preview',
      ...overrides,
    },
  } as unknown as AppConfig;
}

describe('createAnalysisService (factory)', () => {
  it('returns null when disabled', () => {
    const service = createAnalysisService(makeConfig({ enabled: false }));
    expect(service).toBeNull();
  });

  it('creates openai_compatible service with dedicated API key', () => {
    const service = createAnalysisService(makeConfig({ provider: 'openai_compatible', apiKey: 'my-openai-key' }));
    expect(service).not.toBeNull();
  });

  it('creates gemini service with dedicated API key', () => {
    const service = createAnalysisService(makeConfig({ provider: 'gemini', apiKey: 'my-gemini-key' }));
    expect(service).not.toBeNull();
  });

  it('returns null when no API key available', () => {
    const service = createAnalysisService(makeConfig({ provider: 'openai_compatible', apiKey: undefined }));
    expect(service).toBeNull();
  });

  it('creates a keyless openai_compatible service only when a base URL is set (self-hosted endpoint)', () => {
    expect(createAnalysisService(makeConfig({
      provider: 'openai_compatible', apiKey: undefined, baseUrl: 'http://localhost:11434/v1',
    }))).not.toBeNull();
  });

  it('returns null for gemini without an API key', () => {
    expect(createAnalysisService(makeConfig({ provider: 'gemini', apiKey: undefined }))).toBeNull();
  });

  it('creates azure_openai service with dedicated azure key', () => {
    const service = createAnalysisService(makeConfig({
      provider: 'azure_openai',
      azureApiKey: 'azure-specific-key',
      azureEndpoint: 'https://myresource.openai.azure.com',
      azureDeployment: 'gpt-4o',
    }));
    expect(service).not.toBeNull();
  });

  it('azure_openai falls back to shared apiKey when no azureApiKey', () => {
    const service = createAnalysisService(makeConfig({
      provider: 'azure_openai',
      apiKey: 'shared-key',
      azureApiKey: undefined,
      azureEndpoint: 'https://myresource.openai.azure.com',
      azureDeployment: 'gpt-4o',
    }));
    expect(service).not.toBeNull();
  });

  it('returns null for azure_openai when endpoint is missing', () => {
    const service = createAnalysisService(makeConfig({
      provider: 'azure_openai',
      azureApiKey: 'azure-key',
      azureEndpoint: undefined,
      azureDeployment: 'gpt-4o',
    }));
    expect(service).toBeNull();
  });
});
