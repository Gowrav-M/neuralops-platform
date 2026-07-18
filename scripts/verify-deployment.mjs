#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  buildDeploymentCanaryIdentity,
  ensureGovernanceSimulation,
  waitForDeploymentReadiness,
  verifyHighRiskFailsClosed,
} from './deployment-verifier.mjs';

const apiBaseUrl = process.env.NEURALOPS_DEPLOYED_API_URL;
const frontendUrl = process.env.NEURALOPS_DEPLOYED_FRONTEND_URL;
const authToken = process.env.NEURALOPS_AUTH_TOKEN;
const qaToken = process.env.NEURALOPS_QA_AUTH_TOKEN;
const workspaceId = process.env.NEURALOPS_WORKSPACE_ID;
const failOn = process.env.NEURALOPS_DEPLOYED_FAIL_ON || 'review';
const artifactPath = process.env.NEURALOPS_DEPLOYMENT_EVIDENCE_PATH || 'artifacts/deployment-verification.json';

if (!apiBaseUrl) {
  console.error('NEURALOPS_DEPLOYED_API_URL is required.');
  process.exit(1);
}

const headers = {
  'Content-Type': 'application/json',
  ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  ...(qaToken ? { 'x-neuralops-qa-token': qaToken } : {}),
  ...(workspaceId ? { 'x-neuralops-workspace-id': workspaceId } : {}),
};
const checks = [];

async function getJson(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  return { response, payload };
}

async function assertPublicFrontend() {
  if (!frontendUrl) return { name: 'frontend', status: 'skipped', detail: 'NEURALOPS_DEPLOYED_FRONTEND_URL not set' };
  const response = await fetch(frontendUrl);
  if (!response.ok) {
    throw new Error(`frontend returned ${response.status}`);
  }
  return { name: 'frontend', status: 'pass', detail: `${response.status}` };
}

async function verifyTenantIsolation() {
  if (!(authToken || qaToken)) {
    return { name: 'tenant-isolation', status: 'skipped', detail: 'authenticated deployment credential not set' };
  }
  const otherWorkspace = `deployment-isolation-${randomUUID()}`;
  const result = await getJson('/api/system/status', {
    headers: { 'x-neuralops-workspace-id': otherWorkspace },
  });
  if (result.response.status !== 403) {
    throw new Error(`cross-workspace request must return 403, got ${result.response.status}`);
  }
  return { name: 'tenant-isolation', status: 'pass', detail: 'cross-workspace access denied' };
}

async function verifySyntheticAgentFlow() {
  if (!(authToken || qaToken)) {
    return [{ name: 'synthetic-agent-flow', status: 'skipped', detail: 'authenticated deployment credential not set' }];
  }

  const canaryId = randomUUID();
  const registration = await getJson('/api/agent-control/identities', {
    method: 'POST',
    headers: { 'Idempotency-Key': `deployment-agent-${canaryId}` },
    body: JSON.stringify(buildDeploymentCanaryIdentity(canaryId)),
  });
  if (!registration.response.ok || !registration.payload.identity?.id || !registration.payload.credential) {
    throw new Error(`synthetic agent registration failed with ${registration.response.status}`);
  }

  const identityId = registration.payload.identity.id;
  const credential = registration.payload.credential;
  try {
    const lowRisk = await getJson('/api/agent-control/authorize', {
      method: 'POST',
      headers: { 'x-neuralops-agent-key': credential },
      body: JSON.stringify({
        identityId,
        action: 'metadata_read',
        toolCategory: 'metadata',
        operation: 'deployment-canary',
        environment: 'staging',
        provider: 'local',
        contextHash: `sha256:${'1'.repeat(64)}`,
        contentHash: `sha256:${'2'.repeat(64)}`,
        idempotencyKey: `deployment-low-risk-${canaryId}`,
      }),
    });
    if (!lowRisk.response.ok || lowRisk.payload.decision !== 'allow' || lowRisk.payload.lease?.status !== 'active') {
      throw new Error(`synthetic low-risk authorization failed with ${lowRisk.response.status}`);
    }

    const highRisk = await verifyHighRiskFailsClosed({
      requestJson: getJson,
      identityId,
      agentCredential: credential,
    });
    return [
      { name: 'synthetic-low-risk-agent', status: 'pass', detail: 'active scoped lease issued' },
      highRisk,
    ];
  } finally {
    const revoked = await getJson(`/api/agent-control/identities/${identityId}/revoke`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `deployment-revoke-${canaryId}` },
      body: JSON.stringify({ reason: 'Deployment canary cleanup' }),
    });
    if (!revoked.response.ok) {
      throw new Error(`deployment canary cleanup failed with ${revoked.response.status}`);
    }
  }
}

async function writeEvidence(checks, outcome, error = null) {
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    outcome,
    apiBaseUrl,
    frontendUrl: frontendUrl || null,
    checks,
    error: error ? error.message : null,
  };
  const normalizedPath = artifactPath.replace(/\\/g, '/');
  const directory = normalizedPath.includes('/') ? normalizedPath.slice(0, normalizedPath.lastIndexOf('/')) : '.';
  await mkdir(directory, { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

async function main() {
  const wake = await waitForDeploymentReadiness({ apiBaseUrl, timeoutMs: 90_000 });
  checks.push({
    name: 'backend-readiness',
    status: 'pass',
    detail: `state=ready; attempts=${wake.attempts}; elapsedMs=${wake.elapsedMs}`,
  });

  const health = await getJson('/health');
  if (!health.response.ok || health.payload.ok !== true) {
    throw new Error(`/health failed with ${health.response.status}`);
  }
  if (health.payload.storage !== 'postgres') {
    throw new Error(`/health storage must be postgres in deployment, got ${health.payload.storage}`);
  }
  checks.push({ name: 'backend-health', status: 'pass', detail: 'storage=postgres' });
  checks.push(await verifyTenantIsolation());

  const status = await getJson('/api/system/status');
  if (status.response.status === 401 && !authToken) {
    checks.push({ name: 'auth-gate', status: 'pass', detail: 'private API requires bearer token' });
  } else if (status.response.ok) {
    checks.push({
      name: 'system-status',
      status: 'pass',
      detail: `workspace=${status.payload.workspaceId}; auth=${status.payload.authRequired}`,
    });
  } else {
    throw new Error(`/api/system/status failed with ${status.response.status}`);
  }

  if (authToken || qaToken) {
    checks.push(await ensureGovernanceSimulation({ requestJson: getJson }));
  }

  const readiness = await getJson('/api/production/readiness');
  if (readiness.response.status === 401 && !(authToken || qaToken)) {
    checks.push({ name: 'production-readiness-auth', status: 'pass', detail: 'readiness endpoint is private' });
  } else if (readiness.response.ok) {
    if (readiness.payload.decision === 'block' || (failOn === 'review' && readiness.payload.decision === 'review')) {
      throw new Error(
        `/api/production/readiness returned ${readiness.payload.decision} score=${readiness.payload.score}; blockers=${(readiness.payload.blockers || []).join('; ') || 'none'}`
      );
    }
    checks.push({
      name: 'production-readiness',
      status: 'pass',
      detail: `decision=${readiness.payload.decision}; score=${readiness.payload.score}; workspace=${readiness.payload.workspaceId}`,
    });
  } else {
    throw new Error(`/api/production/readiness failed with ${readiness.response.status}`);
  }

  const dryRun = await getJson('/api/connector-deliveries/process', {
    method: 'POST',
    body: JSON.stringify({ limit: 1, sendExternal: false }),
  });
  if (dryRun.response.status === 401 && !authToken) {
    checks.push({ name: 'connector-worker-auth', status: 'pass', detail: 'worker endpoint is private' });
  } else if (dryRun.response.ok && dryRun.payload.mode === 'dry_run') {
    checks.push({ name: 'connector-worker-dry-run', status: 'pass', detail: `skipped=${dryRun.payload.skipped}` });
  } else {
    throw new Error(`/api/connector-deliveries/process dry-run failed with ${dryRun.response.status}`);
  }

  checks.push(await assertPublicFrontend());
  checks.push(...await verifySyntheticAgentFlow());
  for (const check of checks) {
    console.log(`${check.status.toUpperCase()} ${check.name}: ${check.detail}`);
  }
  await writeEvidence(checks, 'pass');
}

main().catch((error) => {
  console.error(`FAIL deployment verification: ${error.message}`);
  writeEvidence(checks, 'fail', error)
    .catch((artifactError) => console.error(`FAIL evidence write: ${artifactError.message}`))
    .finally(() => process.exit(1));
});
