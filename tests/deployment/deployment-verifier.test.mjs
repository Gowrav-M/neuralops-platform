import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDeploymentCanaryIdentity,
  ensureGovernanceSimulation,
  waitForDeploymentReadiness,
  verifyHighRiskFailsClosed,
} from '../../scripts/deployment-verifier.mjs';

function jsonResponse(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('deployment canary registration matches the production identity contract', () => {
  const payload = buildDeploymentCanaryIdentity('12345678-aaaa-bbbb-cccc-123456789abc');

  assert.deepEqual(payload, {
    displayName: 'Deployment canary 12345678',
    owner: 'deployment-canary@neuralops.invalid',
    environment: 'staging',
    riskLevel: 'Major',
    providerAccess: ['local'],
    permissions: ['metadata:read', 'shell:execute'],
    captureMode: 'metadata_only',
  });
});

test('deployment verifier creates missing non-destructive governance evidence', async () => {
  const requests = [];
  const check = await ensureGovernanceSimulation({
    requestJson: async (path, options = {}) => {
      requests.push({ path, options });
      if (path === '/api/data-governance/evidence') {
        return { response: jsonResponse(200, { latestSimulation: null }), payload: { latestSimulation: null } };
      }
      return {
        response: jsonResponse(200, { id: 'purge_sim_release' }),
        payload: { id: 'purge_sim_release' },
      };
    },
  });

  assert.equal(check.status, 'pass');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].path, '/api/data-governance/purge/simulate');
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.body, '{}');
});

test('deployment verifier reuses existing governance evidence', async () => {
  let calls = 0;
  const check = await ensureGovernanceSimulation({
    requestJson: async () => {
      calls += 1;
      return {
        response: jsonResponse(200, { latestSimulation: { id: 'purge_sim_existing' } }),
        payload: { latestSimulation: { id: 'purge_sim_existing' } },
      };
    },
  });

  assert.equal(check.status, 'pass');
  assert.equal(calls, 1);
  assert.match(check.detail, /purge_sim_existing/);
});

test('waitForDeploymentReadiness preserves warming state and becomes ready within the deadline', async () => {
  const calls = [];
  const responses = [
    jsonResponse(503, { ok: false, startup: 'checking', storage: 'postgres' }, { 'retry-after': '1' }),
    jsonResponse(200, { ok: true, startup: 'ready', storage: 'postgres' }),
  ];
  let now = 0;

  const result = await waitForDeploymentReadiness({
    apiBaseUrl: 'https://api.example.test',
    timeoutMs: 90_000,
    fetchImpl: async (url) => {
      calls.push(url);
      return responses.shift();
    },
    now: () => now,
    sleep: async (duration) => {
      now += duration;
    },
  });

  assert.equal(result.state, 'ready');
  assert.equal(result.attempts, 2);
  assert.deepEqual(calls, [
    'https://api.example.test/ready',
    'https://api.example.test/ready',
  ]);
});

test('waitForDeploymentReadiness fails honestly after the bounded pilot window', async () => {
  let now = 0;

  await assert.rejects(
    waitForDeploymentReadiness({
      apiBaseUrl: 'https://api.example.test',
      timeoutMs: 3_000,
      fetchImpl: async () => jsonResponse(503, { ok: false, state: 'warming' }),
      now: () => now,
      sleep: async (duration) => {
        now += duration;
      },
    }),
    /unavailable after 3 seconds/,
  );
});

test('verifyHighRiskFailsClosed accepts only an explicit non-allow decision', async () => {
  const check = await verifyHighRiskFailsClosed({
    requestJson: async () => ({
      response: jsonResponse(200, { decision: 'review', reason: 'Explicit approval required' }),
      payload: { decision: 'review', reason: 'Explicit approval required' },
    }),
    identityId: 'agent_123',
    agentCredential: 'secret-used-only-by-request-layer',
  });

  assert.equal(check.status, 'pass');
  assert.match(check.detail, /review/);
});

test('verifyHighRiskFailsClosed rejects an accidentally allowed shell action', async () => {
  await assert.rejects(
    verifyHighRiskFailsClosed({
      requestJson: async () => ({
        response: jsonResponse(200, { decision: 'allow' }),
        payload: { decision: 'allow' },
      }),
      identityId: 'agent_123',
      agentCredential: 'secret-used-only-by-request-layer',
    }),
    /high-risk shell action was allowed/,
  );
});
