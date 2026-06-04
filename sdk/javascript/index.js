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
