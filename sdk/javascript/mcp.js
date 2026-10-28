import { createHash, randomUUID } from 'node:crypto';
import { AGENT_ACTIONS, AGENT_TOOL_CATEGORIES, NeuralOpsAuthorizationError } from './index.js';

const ACTION_CATEGORIES = new Map([
  [AGENT_ACTIONS.METADATA_READ, AGENT_TOOL_CATEGORIES.METADATA],
  [AGENT_ACTIONS.WRITE, AGENT_TOOL_CATEGORIES.WRITE],
  [AGENT_ACTIONS.SHELL, AGENT_TOOL_CATEGORIES.SHELL],
  [AGENT_ACTIONS.BROWSER, AGENT_TOOL_CATEGORIES.BROWSER],
  [AGENT_ACTIONS.EXTERNAL_POST, AGENT_TOOL_CATEGORIES.EXTERNAL_POST],
  [AGENT_ACTIONS.SECRET, AGENT_TOOL_CATEGORIES.SECRET],
  [AGENT_ACTIONS.DESTRUCTIVE, AGENT_TOOL_CATEGORIES.DESTRUCTIVE],
]);

/**
 * Wrap an MCP tool handler so NeuralOps authorizes and atomically consumes a
 * lease immediately before the handler can perform its side effect.
 *
 * `createApprovalPreview` must return an already-redacted summary, resource,
 * and impact. It is called only when the identity's workspace enables the
 * redacted-preview policy. Tool arguments are otherwise hashed locally and
 * never added to authorization metadata.
 */
export function guardMcpTool(neuralops, configuration, handler) {
  if (!neuralops || typeof neuralops.authorizeAction !== 'function' || typeof neuralops.consumeLease !== 'function') {
    throw new Error('guardMcpTool requires a NeuralOps agent-control client');
  }
  if (typeof handler !== 'function') throw new Error('guardMcpTool requires a tool handler');
  const settings = normalizeConfiguration(configuration);
  const pendingIdempotencyKeys = new Map();

  return async function neuralOpsGuardedMcpTool(args, ...handlerContext) {
    const contextHash = hashCanonical({
      identityId: settings.identityId,
      toolName: settings.toolName,
      action: settings.action,
      toolCategory: settings.toolCategory,
      context: settings.context,
    });
    const fingerprint = hashCanonical({ contextHash, contentHash: hashCanonical(args ?? {}) });
    const configuredIdempotencyKey = settings.idempotencyKey?.(args ?? {}, ...handlerContext);
    if (configuredIdempotencyKey !== undefined && (typeof configuredIdempotencyKey !== 'string' || configuredIdempotencyKey.trim().length === 0)) {
      throw new Error('idempotencyKey must return a non-empty string');
    }
    const idempotencyKey = configuredIdempotencyKey !== undefined
      ? `nop_mcp_${createHash('sha256').update(configuredIdempotencyKey).digest('hex')}`
      : pendingIdempotencyKeys.get(fingerprint) || `nop_action_${randomUUID()}`;
    if (!configuredIdempotencyKey) pendingIdempotencyKeys.set(fingerprint, idempotencyKey);
    const metadata = {
      identityId: settings.identityId,
      action: settings.action,
      toolCategory: settings.toolCategory,
      operation: settings.operation,
      contextHash,
      contentHash: hashCanonical(args ?? {}),
      provider: settings.provider,
      environment: settings.environment,
      idempotencyKey,
    };
    if (settings.model) metadata.model = settings.model;

    try {
      if (settings.action !== AGENT_ACTIONS.METADATA_READ) {
        if (typeof neuralops.getApprovalPreviewPolicy !== 'function') {
          throw new NeuralOpsAuthorizationError('NeuralOps approval privacy policy is unavailable; action denied', {
            code: 'backend_unavailable',
          });
        }
        const policy = await neuralops.getApprovalPreviewPolicy(settings.identityId);
        if (policy.mode === 'redacted_preview' && settings.createApprovalPreview) {
          let preview;
          try {
            preview = settings.createApprovalPreview(args ?? {});
          } catch {
            throw new NeuralOpsAuthorizationError('Approval preview generation failed; action denied', {
              code: 'invalid_metadata',
            });
          }
          metadata.approvalPreview = normalizeApprovalPreview(preview);
        }
      }

      const lease = await neuralops.authorizeAction(metadata);
      await neuralops.consumeLease({
        ...metadata,
        approvalPreview: undefined,
        leaseId: lease.id,
      });
      const result = await handler(args, ...handlerContext);
      if (!configuredIdempotencyKey) pendingIdempotencyKeys.delete(fingerprint);
      return result;
    } catch (error) {
      if (!configuredIdempotencyKey && error?.code !== 'approval_required' && error?.code !== 'backend_unavailable') {
        pendingIdempotencyKeys.delete(fingerprint);
      }
      throw error;
    }
  };
}

function normalizeConfiguration(configuration = {}) {
  const settings = {
    identityId: required(configuration.identityId, 'identityId'),
    toolName: required(configuration.toolName, 'toolName'),
    action: required(configuration.action, 'action'),
    toolCategory: required(configuration.toolCategory, 'toolCategory'),
    provider: required(configuration.provider || 'mcp', 'provider'),
    environment: configuration.environment || 'staging',
    operation: configuration.operation || `${configuration.toolName}.call`,
    model: configuration.model,
    context: configuration.context ?? {},
    createApprovalPreview: configuration.createApprovalPreview,
    idempotencyKey: configuration.idempotencyKey,
  };
  if (settings.toolName.length > 120 || settings.operation.length > 120) {
    throw new Error('MCP tool name and operation must be 120 characters or fewer');
  }
  if (ACTION_CATEGORIES.get(settings.action) !== settings.toolCategory) {
    throw new Error('MCP action and toolCategory must match the NeuralOps agent-control contract');
  }
  if (!['dev', 'staging', 'prod'].includes(settings.environment)) {
    throw new Error('MCP environment must be dev, staging, or prod');
  }
  if (settings.createApprovalPreview !== undefined && typeof settings.createApprovalPreview !== 'function') {
    throw new Error('createApprovalPreview must be a function');
  }
  if (settings.idempotencyKey !== undefined && typeof settings.idempotencyKey !== 'function') {
    throw new Error('idempotencyKey must be a function');
  }
  return settings;
}

function normalizeApprovalPreview(preview) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) {
    throw new Error('Approval preview must be a redacted object');
  }
  const result = {};
  const maxLength = { summary: 240, resource: 160, impact: 240 };
  for (const field of Object.keys(maxLength)) {
    if (preview[field] !== undefined) {
      if (typeof preview[field] !== 'string' || preview[field].length === 0 || preview[field].length > maxLength[field]) {
        throw new Error(`Approval preview ${field} must be a non-empty string of at most ${maxLength[field]} characters`);
      }
      result[field] = preview[field];
    }
  }
  if (Object.keys(result).length === 0) throw new Error('Approval preview must contain a summary, resource, or impact');
  return result;
}

function hashCanonical(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('Tool arguments must be JSON-serializable');
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

function required(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`MCP ${field} is required`);
  return value;
}
