import { Agent } from 'undici';
import type { RequestInit } from 'undici';
import { getOpenAIConfig, getLLMStreamTimeouts } from './config';

describe('LLM stream timeouts', () => {
  const saved = {
    first: process.env.LLM_FIRST_BYTE_TIMEOUT_MS,
    idle: process.env.LLM_STREAM_IDLE_TIMEOUT_MS,
  };

  afterEach(() => {
    if (saved.first === undefined) {
      delete process.env.LLM_FIRST_BYTE_TIMEOUT_MS;
    } else {
      process.env.LLM_FIRST_BYTE_TIMEOUT_MS = saved.first;
    }
    if (saved.idle === undefined) {
      delete process.env.LLM_STREAM_IDLE_TIMEOUT_MS;
    } else {
      process.env.LLM_STREAM_IDLE_TIMEOUT_MS = saved.idle;
    }
  });

  it('adds nothing when the timeouts are not configured', () => {
    delete process.env.LLM_FIRST_BYTE_TIMEOUT_MS;
    delete process.env.LLM_STREAM_IDLE_TIMEOUT_MS;
    expect(getLLMStreamTimeouts()).toBeNull();
    const result = getOpenAIConfig('key', {
      reverseProxyUrl: 'http://bifrost:4120/v1',
    });
    expect(result.configOptions?.fetchOptions).toBeUndefined();
  });

  it('reads both limits and fills an unset one with the 300s default', () => {
    process.env.LLM_FIRST_BYTE_TIMEOUT_MS = '90000';
    process.env.LLM_STREAM_IDLE_TIMEOUT_MS = '';
    expect(getLLMStreamTimeouts()).toEqual({ headersTimeout: 90_000, bodyTimeout: 300_000 });
    process.env.LLM_STREAM_IDLE_TIMEOUT_MS = 'not-a-number';
    expect(getLLMStreamTimeouts()).toEqual({ headersTimeout: 90_000, bodyTimeout: 300_000 });
  });

  it('gives custom endpoints a dispatcher with the shorter limits', () => {
    process.env.LLM_FIRST_BYTE_TIMEOUT_MS = '90000';
    process.env.LLM_STREAM_IDLE_TIMEOUT_MS = '60000';
    const result = getOpenAIConfig('key', {
      reverseProxyUrl: 'http://bifrost:4120/v1',
    });
    const fetchOptions = result.configOptions?.fetchOptions as RequestInit | undefined;
    expect(fetchOptions?.dispatcher).toBeInstanceOf(Agent);

    const again = getOpenAIConfig('key', { reverseProxyUrl: 'http://bifrost:4120/v1' });
    expect((again.configOptions?.fetchOptions as RequestInit).dispatcher).toBe(
      fetchOptions?.dispatcher,
    );
  });

  it('keeps the proxy dispatcher when a proxy is configured', () => {
    process.env.LLM_FIRST_BYTE_TIMEOUT_MS = '90000';
    process.env.LLM_STREAM_IDLE_TIMEOUT_MS = '60000';
    const result = getOpenAIConfig('key', { proxy: 'http://proxy.example.com:8080' });
    const dispatcher = (result.configOptions?.fetchOptions as RequestInit).dispatcher;
    expect(dispatcher).toBeDefined();
    expect(dispatcher?.constructor.name).toBe('ProxyAgent');
  });
});
