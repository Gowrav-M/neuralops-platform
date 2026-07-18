export class NeuralOps {
  constructor({ apiKey, agentCredential, baseUrl = 'http://localhost:8000', fetchImpl = globalThis.fetch, retry = {} } = {}) {
    if (!apiKey && !agentCredential) {
      throw new Error('NeuralOps apiKey or agentCredential is required');
    }
    if (!fetchImpl) {
      throw new Error('A fetch implementation is required');
    }
    this.apiKey = apiKey;
    this.agentCredential = agentCredential;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.retry = normalizeRetryOptions(retry);
  }

  async ingestTrace(trace) {
    this.requireApiKey();
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

  async ingestTraces(traces) {
    this.requireApiKey();
    if (!Array.isArray(traces) || traces.length === 0) {
      throw new Error('NeuralOps ingestTraces requires at least one trace');
    }
    const response = await this.fetchImpl(`${this.baseUrl}/api/traces/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-neuralops-key': this.apiKey,
      },
      body: JSON.stringify({ traces: traces.map((trace) => normalizeTrace(trace)) }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || `NeuralOps batch ingest failed with ${response.status}`);
    }
    return response.json();
  }

  async chatCompletions(payload) {
    this.requireApiKey();
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

  async authorizeAction(metadata) {
    const normalizedMetadata = normalizeAgentMetadata(metadata);
    const response = await this.agentControlPost(
      '/api/agent-control/authorize',
      normalizedMetadata,
      false,
      (candidate, payload) => isCanonicalAuthorizeResponse(candidate, payload),
    );
    if (response.decision === 'review') {
      throw new NeuralOpsAuthorizationError('NeuralOps denied authorization pending explicit approval', {
        code: 'approval_required',
        approval: safeApproval(response.approval),
        idempotencyKey: normalizedMetadata.idempotencyKey,
      });
    }
    return response.lease;
  }

  async requestApproval(metadata) {
    return this.agentControlPost(
      '/api/agent-control/approvals', metadata, false,
      (candidate, payload) => isCanonicalApproval(candidate, payload),
    );
  }

  async validateLease(metadata) {
    return this.agentControlPost(
      '/api/agent-control/leases/validate', metadata, true,
      (candidate, payload) => isCanonicalBoundLease(candidate, payload, 'active'),
    );
  }

  async consumeLease(metadata) {
    return this.agentControlPost(
      '/api/agent-control/leases/consume', metadata, true,
      (candidate, payload) => isCanonicalBoundLease(candidate, payload, 'consumed'),
      false,
      false,
    );
  }

  requireApiKey() {
    if (!this.apiKey) {
      throw new Error('NeuralOps apiKey is required for telemetry and gateway operations');
    }
  }

  async agentControlPost(
    path, metadata, includeLease = false, validateResponse = isRecord,
    retryInvalidResponse = true, retryRequestFailures = true,
  ) {
    if (!this.agentCredential) {
      throw new NeuralOpsAuthorizationError('NeuralOps agentCredential is required', { code: 'credential_required' });
    }
    const payload = normalizeAgentMetadata(metadata, includeLease);
    const idempotencyKey = payload.idempotencyKey;
    const startedAt = Date.now();
    let attempt = 0;
    while (attempt < this.retry.maxAttempts && Date.now() - startedAt <= this.retry.maxElapsedMs) {
      attempt += 1;
      let response;
      try {
        response = await fetchWithDeadline(this.fetchImpl, `${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-neuralops-agent-key': this.agentCredential,
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(payload),
        }, Math.max(0, this.retry.maxElapsedMs - (Date.now() - startedAt)));
      } catch {
        if (!retryRequestFailures || !this.canRetry(attempt, startedAt)) {
          throw unavailableError();
        }
        await this.waitBeforeRetry(attempt, startedAt);
        continue;
      }
      if (response.ok) {
        try {
          const result = await response.json();
          if (!validateResponse(result, payload)) {
            throw new TypeError('Invalid NeuralOps agent control response');
          }
          return result;
        } catch {
          if (retryInvalidResponse && this.canRetry(attempt, startedAt)) {
            await this.waitBeforeRetry(attempt, startedAt);
            continue;
          }
          throw unavailableError(response.status);
        }
      }
      if (retryRequestFailures && RETRYABLE_AGENT_STATUSES.has(response.status) && this.canRetry(attempt, startedAt)) {
        await this.waitBeforeRetry(attempt, startedAt);
        continue;
      }
      if (RETRYABLE_AGENT_STATUSES.has(response.status)) {
        throw unavailableError(response.status);
      }
      throw new NeuralOpsAuthorizationError(`NeuralOps agent control returned HTTP ${response.status}`, {
        code: 'request_rejected',
        status: response.status,
      });
    }
    throw unavailableError();
  }

  canRetry(attempt, startedAt) {
    return attempt < this.retry.maxAttempts && Date.now() - startedAt < this.retry.maxElapsedMs;
  }

  async waitBeforeRetry(attempt, startedAt) {
    const delay = Math.min(
      this.retry.initialDelayMs * (2 ** Math.max(0, attempt - 1)),
      this.retry.maxDelayMs,
      Math.max(0, this.retry.maxElapsedMs - (Date.now() - startedAt)),
    );
    if (delay > 0) {
      await this.retry.sleepImpl(delay);
    }
  }
}

export class NeuralOpsAuthorizationError extends Error {
  constructor(message, { code = 'authorization_failed', status, approval, idempotencyKey } = {}) {
    super(message);
    this.name = 'NeuralOpsAuthorizationError';
    this.code = code;
    this.status = status;
    this.approval = approval;
    this.idempotencyKey = idempotencyKey;
  }
}

export const AGENT_ACTIONS = Object.freeze({
  METADATA_READ: 'metadata_read',
  SHELL: 'shell',
});

export const AGENT_TOOL_CATEGORIES = Object.freeze({
  METADATA: 'metadata',
  SHELL: 'shell',
});

const RETRYABLE_AGENT_STATUSES = new Set([408, 425, 429, 502, 503, 504]);
const AGENT_METADATA_FIELDS = [
  'identityId', 'action', 'toolCategory', 'operation', 'contextHash', 'contentHash', 'provider',
  'environment', 'model', 'timingMs', 'tokens', 'costUsd', 'status', 'policyFindings',
];

function normalizeRetryOptions(retry) {
  const maxAttempts = retry.maxAttempts === undefined ? Number.POSITIVE_INFINITY : Number(retry.maxAttempts);
  const maxElapsedMs = retry.maxElapsedMs === undefined ? 90_000 : Number(retry.maxElapsedMs);
  const initialDelayMs = retry.initialDelayMs === undefined ? 250 : Number(retry.initialDelayMs);
  const maxDelayMs = retry.maxDelayMs === undefined ? 5_000 : Number(retry.maxDelayMs);
  if (!(maxAttempts > 0) || !(maxElapsedMs >= 0) || !(initialDelayMs >= 0) || !(maxDelayMs >= 0)) {
    throw new Error('NeuralOps retry values must be non-negative and maxAttempts must be positive');
  }
  return {
    maxAttempts,
    maxElapsedMs,
    initialDelayMs,
    maxDelayMs,
    sleepImpl: retry.sleepImpl || ((delay) => new Promise((resolve) => setTimeout(resolve, delay))),
  };
}

function normalizeAgentMetadata(metadata = {}, includeLease = false) {
  const payload = {};
  for (const field of AGENT_METADATA_FIELDS) {
    if (metadata[field] !== undefined && metadata[field] !== null) {
      payload[field] = metadata[field];
    }
  }
  for (const field of ['identityId', 'action', 'toolCategory', 'operation', 'contextHash', 'contentHash', 'provider']) {
    if (typeof payload[field] !== 'string' || payload[field].length === 0) {
      throw new NeuralOpsAuthorizationError(`NeuralOps agent metadata field "${field}" is required`, { code: 'invalid_metadata' });
    }
  }
  payload.idempotencyKey = String(metadata.idempotencyKey || generateIdempotencyKey());
  if (includeLease) {
    if (typeof metadata.leaseId !== 'string' || metadata.leaseId.length === 0) {
      throw new NeuralOpsAuthorizationError('NeuralOps agent metadata field "leaseId" is required', { code: 'invalid_metadata' });
    }
    payload.leaseId = metadata.leaseId;
  }
  return payload;
}

function generateIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) {
    return `nop_action_${globalThis.crypto.randomUUID()}`;
  }
  return `nop_action_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function safeApproval(approval) {
  return { id: approval.id, status: approval.status };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCanonicalAuthorizeResponse(response, request) {
  if (!isRecord(response) || typeof response.reason !== 'string' || response.reason.length === 0) {
    return false;
  }
  if (response.decision === 'review') {
    return isRecord(response.approval)
      && typeof response.approval.id === 'string'
      && response.approval.id.length > 0
      && response.approval.status === 'pending';
  }
  if (response.decision !== 'allow' || !isRecord(response.lease)) {
    return false;
  }
  const lease = response.lease;
  if (typeof lease.id !== 'string' || lease.id.length === 0 || lease.status !== 'active') {
    return false;
  }
  for (const field of ['identityId', 'action', 'toolCategory', 'operation', 'contextHash', 'contentHash', 'provider', 'idempotencyKey']) {
    if (lease[field] !== request[field]) return false;
  }
  for (const field of ['environment', 'model']) {
    if (request[field] !== undefined && lease[field] !== request[field]) return false;
  }
  return lease.risk === 'low' || lease.risk === 'high';
}

function hasCanonicalBinding(response, request) {
  for (const field of [
    'identityId', 'action', 'toolCategory', 'operation', 'contextHash',
    'contentHash', 'provider', 'idempotencyKey',
  ]) {
    if (response[field] !== request[field]) return false;
  }
  for (const field of ['environment', 'model']) {
    if (request[field] !== undefined && response[field] !== request[field]) return false;
  }
  return true;
}

function isCanonicalApproval(response, request) {
  return isRecord(response)
    && typeof response.id === 'string'
    && response.id.length > 0
    && response.status === 'pending'
    && response.risk === 'high'
    && ['prod', 'staging', 'dev'].includes(response.environment)
    && typeof response.requestedBy === 'string'
    && response.requestedBy.length > 0
    && typeof response.createdAt === 'string'
    && response.createdAt.length > 0
    && typeof response.expiresAt === 'string'
    && response.expiresAt.length > 0
    && hasCanonicalBinding(response, request);
}

function isCanonicalBoundLease(response, request, expectedStatus) {
  return isRecord(response)
    && typeof response.id === 'string'
    && response.id === request.leaseId
    && response.status === expectedStatus
    && (response.risk === 'low' || response.risk === 'high')
    && ['prod', 'staging', 'dev'].includes(response.environment)
    && typeof response.createdAt === 'string'
    && response.createdAt.length > 0
    && typeof response.expiresAt === 'string'
    && response.expiresAt.length > 0
    && (expectedStatus !== 'consumed'
      || (typeof response.consumedAt === 'string' && response.consumedAt.length > 0))
    && hasCanonicalBinding(response, request);
}

function unavailableError(status) {
  return new NeuralOpsAuthorizationError('NeuralOps agent control is unavailable; action denied', {
    code: 'backend_unavailable',
    status,
  });
}

async function fetchWithDeadline(fetchImpl, url, options, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller?.abort();
      reject(new TypeError('NeuralOps agent control request timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchImpl(url, { ...options, signal: controller?.signal }),
      deadline,
    ]);
  } finally {
    clearTimeout(timeout);
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
  const payload = {
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
  if (trace.idempotencyKey) {
    payload.idempotencyKey = String(trace.idempotencyKey);
  }
  return payload;
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
