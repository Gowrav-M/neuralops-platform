#!/usr/bin/env node

const apiBaseUrl = process.env.NEURALOPS_DEPLOYED_API_URL;
const frontendUrl = process.env.NEURALOPS_DEPLOYED_FRONTEND_URL;
const authToken = process.env.NEURALOPS_AUTH_TOKEN;
const qaToken = process.env.NEURALOPS_QA_AUTH_TOKEN;
const workspaceId = process.env.NEURALOPS_WORKSPACE_ID;
const failOn = process.env.NEURALOPS_DEPLOYED_FAIL_ON || 'review';

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

async function main() {
  const checks = [];

  const health = await getJson('/health');
  if (!health.response.ok || health.payload.ok !== true) {
    throw new Error(`/health failed with ${health.response.status}`);
  }
  if (health.payload.storage !== 'postgres') {
    throw new Error(`/health storage must be postgres in deployment, got ${health.payload.storage}`);
  }
  checks.push({ name: 'backend-health', status: 'pass', detail: 'storage=postgres' });

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
  for (const check of checks) {
    console.log(`${check.status.toUpperCase()} ${check.name}: ${check.detail}`);
  }
}

main().catch((error) => {
  console.error(`FAIL deployment verification: ${error.message}`);
  process.exit(1);
});
