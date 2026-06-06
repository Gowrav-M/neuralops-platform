export class NeuralOps {
  constructor({ apiKey, baseUrl = 'http://localhost:8000', fetchImpl = globalThis.fetch } = {}) {
    if (!apiKey) {
      throw new Error('NeuralOps apiKey is required');
    }
    if (!fetchImpl) {
      throw new Error('A fetch implementation is required');
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  async ingestTrace(trace) {
    const payload = normalizeTrace(trace);
    const response = await this.fetchImpl(`${this.baseUrl}/api/traces/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-neuralops-key': this.apiKey,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || `NeuralOps ingest failed with ${response.status}`);
    }
    return response.json();
  }

  async chatCompletions(payload) {
    const response = await this.fetchImpl(`${this.baseUrl}/api/gateway/openai/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-neuralops-key': this.apiKey,
      },
      body: JSON.stringify(normalizeChatCompletion(payload)),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || `NeuralOps gateway failed with ${response.status}`);
    }
    return response.json();
  }

  async traceModelCall({ session, environment = 'staging', model, prompt, call, toolCalls }) {
    const started = Date.now();
    try {
      const output = await call();
      return await this.ingestTrace({
        session,
        environment,
        model,
        tokens: estimateTokens(`${prompt}\n${output}`),
        latencyMs: Date.now() - started,
        costUsd: 0,
        status: 'success',
        score: 1,
        prompt,
        output: String(output),
        toolCalls,
      });
    } catch (error) {
      await this.ingestTrace({
        session,
        environment,
        model,
        tokens: estimateTokens(prompt),
        latencyMs: Date.now() - started,
        costUsd: 0,
        status: 'failed',
        score: 0,
        prompt,
        output: error instanceof Error ? error.message : String(error),
        toolCalls,
        riskFlags: ['sdk-captured-error'],
      });
      throw error;
    }
  }
}

export function traceFunction(name, fn, options = {}) {
  const started = Date.now();
  const session = options.session || `sdk-${Date.now()}`;
  const model = options.model || name;
  const prompt = options.prompt || `traceFunction:${name}`;
  const neuralops = options.neuralops;
  const strict = Boolean(options.strict);

  return Promise.resolve()
    .then(() => fn())
    .then(async (result) => {
      await safeIngest(neuralops, {
        session,
        environment: options.environment || 'staging',
        model,
        tokens: estimateTokens(`${prompt}\n${stringifyOutput(result)}`),
        latencyMs: Date.now() - started,
        costUsd: 0,
        status: 'success',
        score: 1,
        prompt,
        output: stringifyOutput(result),
        toolCalls: options.toolCalls,
        riskFlags: options.riskFlags || ['sdk-trace-function'],
      }, strict);
      return result;
    })
    .catch(async (error) => {
      await safeIngest(neuralops, {
        session,
        environment: options.environment || 'staging',
        model,
        tokens: estimateTokens(prompt),
        latencyMs: Date.now() - started,
        costUsd: 0,
        status: 'failed',
        score: 0,
        prompt,
        output: error instanceof Error ? error.message : String(error),
        toolCalls: options.toolCalls,
        riskFlags: ['sdk-captured-error'],
      }, false);
      throw error;
    });
}

export function wrapOpenAI(client, options = {}) {
  if (!client?.chat?.completions?.create) {
    throw new Error('wrapOpenAI requires a client with chat.completions.create');
  }
  return {
    ...client,
    chat: {
      ...client.chat,
      completions: {
        ...client.chat.completions,
        create: async (payload = {}) => captureOpenAICompletion(client, payload, options),
      },
    },
  };
}

export function wrapFetch(fetchImpl, options = {}) {
  if (!fetchImpl) {
    throw new Error('wrapFetch requires a fetch implementation');
  }
  return async function neuralOpsWrappedFetch(url, init = {}) {
    const started = Date.now();
    const method = String(init.method || 'GET').toUpperCase();
    const response = await fetchImpl(url, init);
    const output = await responseTextPreview(response);
    await safeIngest(options.neuralops, {
      session: options.session || `fetch-${Date.now()}`,
      environment: options.environment || 'staging',
      model: options.model || 'fetch',
      tokens: estimateTokens(`${method} ${url}\n${output}`),
      latencyMs: Date.now() - started,
      costUsd: 0,
      status: response.ok ? 'success' : response.status >= 500 ? 'failed' : 'warning',
      score: response.ok ? 1 : 0.5,
      prompt: `${method} ${url}`,
      output: output || `HTTP ${response.status}`,
      toolCalls: options.toolCalls || 'fetch',
      riskFlags: options.riskFlags || ['sdk-fetch'],
    }, Boolean(options.strict));
    return response;
  };
}

async function captureOpenAICompletion(client, payload, options) {
  const started = Date.now();
  const prompt = messagesText(payload.messages || []);
  try {
    const response = await client.chat.completions.create(payload);
    await safeIngest(options.neuralops, {
      session: payload.metadata?.session || options.session || `openai-${Date.now()}`,
      environment: payload.metadata?.environment || options.environment || 'staging',
      model: payload.model || response?.model || options.model || 'openai-compatible',
      tokens: Number(response?.usage?.total_tokens ?? estimateTokens(`${prompt}\n${openAIResponseText(response)}`)),
      latencyMs: Date.now() - started,
      costUsd: 0,
      status: 'success',
      score: 1,
      prompt,
      output: openAIResponseText(response),
      toolCalls: openAIToolCalls(response),
      riskFlags: options.riskFlags || ['sdk-openai-wrapper'],
    }, Boolean(options.strict));
    return response;
  } catch (error) {
    await safeIngest(options.neuralops, {
      session: payload.metadata?.session || options.session || `openai-${Date.now()}`,
      environment: payload.metadata?.environment || options.environment || 'staging',
      model: payload.model || options.model || 'openai-compatible',
      tokens: estimateTokens(prompt),
      latencyMs: Date.now() - started,
      costUsd: 0,
      status: 'failed',
      score: 0,
      prompt,
      output: error instanceof Error ? error.message : String(error),
      riskFlags: ['sdk-captured-error'],
    }, false);
    throw error;
  }
}

async function safeIngest(neuralops, trace, strict) {
  if (!neuralops?.ingestTrace) {
    return;
  }
  try {
    await neuralops.ingestTrace(trace);
  } catch (error) {
    if (strict) {
      throw error;
    }
  }
}

async function responseTextPreview(response) {
  try {
    if (response?.clone) {
      return truncate(await response.clone().text());
    }
  } catch {
    return '';
  }
  return '';
}

function messagesText(messages) {
  return messages.map((message) => `${message.role || 'message'}: ${contentText(message.content)}`).join('\n');
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(contentText).join(' ');
  if (content && typeof content === 'object') return JSON.stringify(content);
  return String(content ?? '');
}

function openAIResponseText(response) {
  const message = response?.choices?.[0]?.message;
  return stringifyOutput(message?.content ?? response?.output_text ?? response);
}

function openAIToolCalls(response) {
  const toolCalls = response?.choices?.[0]?.message?.tool_calls;
  return toolCalls ? JSON.stringify(toolCalls) : undefined;
}

function stringifyOutput(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value) {
  const text = String(value ?? '');
  return text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
}

function normalizeChatCompletion(payload = {}) {
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new Error('NeuralOps gateway field "messages" is required');
  }
  return {
    ...payload,
    stream: Boolean(payload.stream ?? false),
    messages: payload.messages,
  };
}

function normalizeTrace(trace) {
  return {
    session: required(trace.session, 'session'),
    environment: trace.environment || 'staging',
    model: required(trace.model, 'model'),
    tokens: Number(trace.tokens ?? 0),
    latencyMs: Number(trace.latencyMs ?? 0),
    costUsd: Number(trace.costUsd ?? 0),
    status: trace.status || 'success',
    score: Number(trace.score ?? 1),
    prompt: required(trace.prompt, 'prompt'),
    output: required(trace.output, 'output'),
    toolCalls: trace.toolCalls,
    riskFlags: trace.riskFlags || [],
  };
}

function required(value, field) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`NeuralOps trace field "${field}" is required`);
  }
  return String(value);
}

function estimateTokens(text) {
  return Math.max(1, String(text).split(/\s+/).filter(Boolean).length + Math.floor(String(text).length / 5));
}
