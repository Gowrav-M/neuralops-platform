import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AGENT_ACTIONS,
  AGENT_TOOL_CATEGORIES,
  NeuralOps,
} from '../../sdk/javascript/index.js';


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForService(baseUrl, child, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`FastAPI exited before readiness: ${output.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`FastAPI did not become ready: ${output.join('')}`);
}

function action(identityId, actionName, toolCategory, idempotencyKey) {
  return {
    identityId,
    action: actionName,
    toolCategory,
    operation: actionName === AGENT_ACTIONS.METADATA_READ ? 'inspect' : 'exec',
    contextHash: `sha256:${'a'.repeat(64)}`,
    contentHash: `sha256:${'b'.repeat(64)}`,
    provider: 'gateway',
    environment: 'staging',
    idempotencyKey,
  };
}

test('JavaScript SDK canonical contract works against a real FastAPI service', { timeout: 30_000 }, async (t) => {
  const workdir = await mkdtemp(path.join(tmpdir(), 'neuralops-js-contract-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const python = path.join(ROOT, 'backend', '.venv', 'Scripts', 'python.exe');
  const output = [];
  const env = { ...process.env, NEURALOPS_DB_PATH: path.join(workdir, 'contract.sqlite3') };
  delete env.NEURALOPS_DATABASE_URL;
  delete env.SUPABASE_DB_URL;
  delete env.DATABASE_URL;
  delete env.NEURALOPS_AUTH_REQUIRED;
  const child = spawn(python, [
    '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning',
  ], { cwd: path.join(ROOT, 'backend'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    await rm(workdir, { recursive: true, force: true });
  });

  await waitForService(baseUrl, child, output);
  const registered = await fetch(`${baseUrl}/api/agent-control/identities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: 'JavaScript Contract Agent',
      owner: 'js-contract@example.com',
      environment: 'staging',
      riskLevel: 'Critical',
      providerAccess: ['gateway'],
      permissions: ['metadata:read', 'shell:execute'],
    }),
  });
  if (registered.status !== 200) {
    assert.fail(`Identity registration returned ${registered.status}: ${await registered.text()}`);
  }
  const registration = await registered.json();
  const sdk = new NeuralOps({ agentCredential: registration.credential, baseUrl });
  const identityId = registration.identity.id;

  const lowRisk = action(
    identityId,
    AGENT_ACTIONS.METADATA_READ,
    AGENT_TOOL_CATEGORIES.METADATA,
    'javascript-low-risk-contract',
  );
  const lease = await sdk.authorizeAction(lowRisk);
  assert.equal(lease.risk, 'low');
  assert.equal(lease.action, AGENT_ACTIONS.METADATA_READ);
  assert.equal(lease.toolCategory, AGENT_TOOL_CATEGORIES.METADATA);
  const binding = { ...lowRisk, leaseId: lease.id };
  assert.equal((await sdk.validateLease(binding)).status, 'active');
  assert.equal((await sdk.consumeLease(binding)).status, 'consumed');

  const highRisk = action(
    identityId,
    AGENT_ACTIONS.SHELL,
    AGENT_TOOL_CATEGORIES.SHELL,
    'javascript-high-risk-contract',
  );
  const requestedApproval = await sdk.requestApproval(highRisk);
  assert.equal(requestedApproval.status, 'pending');
  assert.equal(requestedApproval.identityId, identityId);
  let firstApproval;
  await assert.rejects(sdk.authorizeAction(highRisk), (error) => {
    firstApproval = error.approval;
    return error.code === 'approval_required' && error.idempotencyKey === highRisk.idempotencyKey;
  });
  await assert.rejects(sdk.authorizeAction(highRisk), (error) => (
    error.code === 'approval_required'
    && error.idempotencyKey === highRisk.idempotencyKey
    && error.approval.id === firstApproval.id
    && error.approval.id === requestedApproval.id
  ));
});
