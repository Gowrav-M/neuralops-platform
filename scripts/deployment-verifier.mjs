import { createHash, randomUUID } from 'node:crypto';

const DEFAULT_RETRY_MS = 1_000;

function safeRetryDelay(response, remainingMs) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  const requested = Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1_000
    : DEFAULT_RETRY_MS;
  return Math.max(1, Math.min(requested, remainingMs));
}

export async function waitForDeploymentReadiness({
  apiBaseUrl,
  timeoutMs = 90_000,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
}) {
  const startedAt = now();
  let attempts = 0;
  let lastState = 'checking';

  while (now() - startedAt < timeoutMs) {
    attempts += 1;
    let response;
    let payload = {};
    try {
      response = await fetchImpl(`${apiBaseUrl.replace(/\/$/, '')}/ready`);
      const raw = await response.text();
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      lastState = 'warming';
    }

    const reportedState = payload.startup || payload.state;
    if (response?.ok && payload.ok === true && payload.storage === 'postgres' && reportedState === 'ready') {
      return { state: 'ready', attempts, elapsedMs: now() - startedAt, payload };
    }

    lastState = reportedState || 'warming';
    const remainingMs = timeoutMs - (now() - startedAt);
    if (remainingMs <= 0) break;
    await sleep(safeRetryDelay(response, remainingMs));
  }

  throw new Error(`backend unavailable after ${Math.round(timeoutMs / 1_000)} seconds (last state: ${lastState})`);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function buildDeploymentCanaryIdentity(canaryId) {
  return {
    displayName: `Deployment canary ${canaryId.slice(0, 8)}`,
    owner: 'deployment-canary@neuralops.invalid',
    environment: 'staging',
    riskLevel: 'Major',
    providerAccess: ['local'],
    permissions: ['metadata:read', 'shell:execute'],
    captureMode: 'metadata_only',
  };
}

export async function ensureGovernanceSimulation({ requestJson }) {
  const evidence = await requestJson('/api/data-governance/evidence');
  if (!evidence.response.ok) {
    throw new Error(`governance evidence check failed with ${evidence.response.status}`);
  }
  if (evidence.payload.latestSimulation?.id) {
    return {
      name: 'governance-simulation',
      status: 'pass',
      detail: `existing=${evidence.payload.latestSimulation.id}`,
    };
  }

  const simulation = await requestJson('/api/data-governance/purge/simulate', {
    method: 'POST',
    body: '{}',
  });
  if (!simulation.response.ok || !simulation.payload.id) {
    throw new Error(`governance simulation failed with ${simulation.response.status}`);
  }
  return {
    name: 'governance-simulation',
    status: 'pass',
    detail: `created=${simulation.payload.id}; destructive=false`,
  };
}

export async function verifyHighRiskFailsClosed({ requestJson, identityId, agentCredential }) {
  const requestId = randomUUID();
  const { response, payload } = await requestJson('/api/agent-control/authorize', {
    method: 'POST',
    headers: { 'x-neuralops-agent-key': agentCredential },
    body: JSON.stringify({
      identityId,
      action: 'shell',
      toolCategory: 'shell',
      operation: 'deployment-canary',
      environment: 'staging',
      provider: 'local',
      contextHash: sha256(`deployment-context:${requestId}`),
      contentHash: sha256(`deployment-content:${requestId}`),
      idempotencyKey: `deployment-high-risk-${requestId}`,
    }),
  });

  if (!response.ok) {
    throw new Error(`high-risk authorization check failed with ${response.status}`);
  }
  if (payload.decision === 'allow') {
    throw new Error('high-risk shell action was allowed without current explicit approval');
  }
  if (!['review', 'deny', 'block'].includes(payload.decision)) {
    throw new Error(`high-risk authorization returned unknown decision ${payload.decision || 'missing'}`);
  }
  return { name: 'high-risk-fail-closed', status: 'pass', detail: `decision=${payload.decision}` };
}
