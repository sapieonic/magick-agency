import { describe, it, expect, vi } from 'vitest';

vi.mock('openai', () => ({
  default: class { chat = { completions: { create: vi.fn() } }; },
  AzureOpenAI: class { chat = { completions: { create: vi.fn() } }; },
}));
vi.mock('@google/genai', () => ({}));

const { createAiClient, aiClientConfigProblem, AiError } = await import('../../../src/ai/index.js');

describe('createAiClient', () => {
  it('builds one client per provider, each reporting its provider, model and capabilities', () => {
    const compat = createAiClient({ provider: 'openai_compatible', apiKey: 'k', model: 'gpt-4o-mini' });
    const azure = createAiClient({ provider: 'azure_openai', apiKey: 'k', model: 'gpt-4o', endpoint: 'https://r.openai.azure.com', apiVersion: 'v' });
    const gemini = createAiClient({ provider: 'gemini', apiKey: 'k', model: 'gemini-3.5-flash' });

    expect([compat.provider, azure.provider, gemini.provider]).toEqual(['openai_compatible', 'azure_openai', 'gemini']);
    expect([compat.model, azure.model, gemini.model]).toEqual(['gpt-4o-mini', 'gpt-4o', 'gemini-3.5-flash']);
    expect([compat.capabilities.fileInput, azure.capabilities.fileInput, gemini.capabilities.fileInput]).toEqual([false, false, true]);
  });

  it('refuses an incomplete config with invalid_config instead of building a broken client', () => {
    expect(() => createAiClient({ provider: 'gemini', apiKey: '', model: 'gemini-3.5-flash' }))
      .toThrow(expect.objectContaining({ kind: 'invalid_config', provider: 'gemini' }));
    expect(() => createAiClient({ provider: 'gemini', apiKey: 'k', model: '' })).toThrow(AiError);
  });
});

describe('aiClientConfigProblem', () => {
  it('openai_compatible needs a key, unless a base URL points at a keyless endpoint', () => {
    expect(aiClientConfigProblem({ provider: 'openai_compatible', model: 'm' })).toMatch(/no API key/);
    expect(aiClientConfigProblem({ provider: 'openai_compatible', model: 'm', apiKey: 'k' })).toBeNull();
    expect(aiClientConfigProblem({ provider: 'openai_compatible', model: 'm', baseUrl: 'http://localhost:8000/v1' })).toBeNull();
  });

  it('azure_openai needs a key and an endpoint; gemini needs a key; everything needs a model', () => {
    const azure = { provider: 'azure_openai' as const, model: 'm', apiKey: 'k', endpoint: 'https://r', apiVersion: 'v' };
    expect(aiClientConfigProblem(azure)).toBeNull();
    expect(aiClientConfigProblem({ ...azure, apiKey: '' })).toMatch(/no API key/);
    expect(aiClientConfigProblem({ ...azure, endpoint: '' })).toMatch(/no endpoint/);
    expect(aiClientConfigProblem({ provider: 'gemini', model: 'm', apiKey: '' })).toMatch(/no API key/);
    expect(aiClientConfigProblem({ provider: 'gemini', model: '', apiKey: 'k' })).toMatch(/no model/);
  });
});
