import { expect, test } from '@playwright/test';

const identity = {
  id: 'agent_identity_external',
  agentId: 'agent_identity_external',
  displayName: 'Revenue Researcher',
  owner: 'Growth Engineering',
  environment: 'staging',
  status: 'active',
  riskLevel: 'Major',
  permissions: ['metadata:read', 'browser:request'],
  providerAccess: ['groq'],
  requiresApproval: true,
  captureMode: 'metadata_only',
  credentialStatus: 'active',
  credentialPreview: 'nop_agent_123...abcd',
  productionAccessStatus: 'pending_review',
  killSwitchReason: null,
  createdAt: '2026-07-16T00:00:00',
  updatedAt: '2026-07-16T00:00:00',
  lastApprovedAt: null,
};

const approval = {
  id: 'agent_approval_shell',
  identityId: identity.id,
  action: 'shell_execute',
  toolCategory: 'shell',
  operation: 'deploy_release',
  contextHash: `sha256:${'1'.repeat(64)}`,
  contentHash: `sha256:${'2'.repeat(64)}`,
  provider: 'groq',
  model: 'llama-3.3-70b',
  environment: 'staging',
  risk: 'high',
  status: 'pending',
  idempotencyKey: 'release-42',
  requestedBy: 'developer@pilot.test',
  createdAt: '2026-07-16T00:00:00',
  expiresAt: '2026-07-17T00:00:00',
};

const productionRequest = {
  id: 'agent_access_external',
  agentId: identity.id,
  targetEnvironment: 'prod',
  status: 'pending_review',
  decision: 'review',
  justification: 'Production canary passed with signed release evidence.',
  evidenceId: 'evidence_release_42',
  requestedBy: 'developer@pilot.test',
  createdAt: '2026-07-16T00:00:00',
};

const lease = {
  id: 'agent_lease_active',
  identityId: identity.id,
  action: 'metadata_read',
  toolCategory: 'metadata',
  operation: 'read_run_posture',
  contextHash: `sha256:${'3'.repeat(64)}`,
  contentHash: `sha256:${'4'.repeat(64)}`,
  provider: 'groq',
  environment: 'staging',
  risk: 'low',
  status: 'active',
  idempotencyKey: 'posture-read-42',
  approvalId: null,
  createdAt: '2026-07-16T00:00:00',
  expiresAt: '2026-07-17T00:00:00',
  consumedAt: null,
  policyFindings: [],
};

async function mockCommandCenter(page, { identityFailures = 0, identityFailureStatus = 503, approvalFailures = 0 } = {}) {
  const state = {
    identities: [{ ...identity }],
    approvals: [{ ...approval }],
    leases: [{ ...lease }],
    production: [{ ...productionRequest }],
    lastDecisionBody: null,
    killBody: null,
    identityAttempts: 0,
    decisionAttempts: [],
  };

  await page.route('**/api/agent-control/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const body = request.postDataJSON?.() ?? null;

    if (path === '/api/agent-control/identities' && request.method() === 'GET') {
      state.identityAttempts += 1;
      if (state.identityAttempts <= identityFailures) {
        return route.fulfill({ status: identityFailureStatus, json: { detail: identityFailureStatus === 401 ? `Authentication required\n${'x'.repeat(400)}` : 'Service is waking' } });
      }
      return route.fulfill({ json: state.identities });
    }
    if (path === '/api/agent-control/identities' && request.method() === 'POST') {
      const created = { ...identity, id: 'agent_identity_new', agentId: 'agent_identity_new', displayName: body.displayName, owner: body.owner };
      state.identities.push(created);
      return route.fulfill({ json: { identity: created, credential: 'nop_agent_one_time_secret' } });
    }
    if (path === '/api/agent-control/approvals' && request.method() === 'GET') {
      return route.fulfill({ json: state.approvals });
    }
    if (path === '/api/agent-control/leases' && request.method() === 'GET') {
      return route.fulfill({ json: state.leases });
    }
    if (path === '/api/agent-control/production-access' && request.method() === 'GET') {
      return route.fulfill({ json: state.production });
    }
    if (/\/api\/agent-control\/approvals\/[^/]+\/(approve|block|revoke)$/.test(path)) {
      state.lastDecisionBody = body;
      state.decisionAttempts.push({ body, idempotencyKey: request.headers()['idempotency-key'] });
      if (state.decisionAttempts.length <= approvalFailures) {
        return route.fulfill({ status: 503, json: { detail: 'Backend warming' } });
      }
      const status = path.endsWith('/approve') ? 'approved' : path.endsWith('/block') ? 'blocked' : 'revoked';
      state.approvals[0] = { ...state.approvals[0], ...body, status };
      return route.fulfill({ json: state.approvals[0] });
    }
    if (/\/api\/agent-control\/production-access\/[^/]+\/(approve|block|revoke)$/.test(path)) {
      const status = path.endsWith('/approve') ? 'approved' : path.endsWith('/block') ? 'blocked' : 'revoked';
      state.production[0] = { ...state.production[0], ...body, status };
      return route.fulfill({ json: state.production[0] });
    }
    if (path.endsWith('/kill-switch')) {
      state.killBody = body;
      state.identities[0] = { ...state.identities[0], status: 'disabled', killSwitchReason: body.reason };
      return route.fulfill({ json: { identity: state.identities[0], revokedLeases: 2, cancelledJobs: 1 } });
    }
    if (path.endsWith('/rotate')) {
      return route.fulfill({ json: { identity: state.identities[0], credential: 'nop_agent_rotated_once' } });
    }
    if (path.endsWith('/revoke')) {
      state.identities[0] = { ...state.identities[0], status: 'revoked', credentialStatus: 'revoked' };
      return route.fulfill({ json: state.identities[0] });
    }
    return route.fallback();
  });

  await page.route('**/api/agent-runtime/runs', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/agent-runtime/jobs', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/agent-runtime/jobs/summary', (route) => route.fulfill({ json: { queued: 0, running: 0, blocked: 0 } }));
  await page.route('**/api/agent-runtime/definitions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/agent-runtime/providers', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/agents', (route) => route.fulfill({ json: [] }));
  return state;
}

async function openCommandCenter(page) {
  await page.goto('/release/agents');
  await expect(page.getByRole('heading', { name: 'Agent Command Center' })).toBeVisible();
}

test('onboards an external identity and reveals its credential once', async ({ page }) => {
  await mockCommandCenter(page);
  await openCommandCenter(page);

  await page.getByRole('button', { name: 'Register external agent' }).click();
  await page.getByLabel('Agent name').fill('Release Operator');
  await page.getByLabel('Owner').fill('Platform Engineering');
  await page.getByLabel('Allowed providers').fill('groq, openai');
  await page.getByLabel('Allowed permissions').fill('metadata:read, release:request');
  await page.getByRole('button', { name: 'Issue one-time credential' }).click();

  const dialog = page.getByRole('dialog', { name: 'One-time agent credential' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('nop_agent_one_time_secret')).toBeVisible();
  await expect(dialog.getByText(/will not be shown again/i)).toBeVisible();
  await dialog.getByRole('button', { name: 'I saved it — close' }).click();
  await expect(page.getByText('nop_agent_one_time_secret')).toHaveCount(0);
});

test('approves a persisted high-risk request with review evidence', async ({ page }) => {
  const state = await mockCommandCenter(page, { approvalFailures: 1 });
  await openCommandCenter(page);

  const request = page.locator('[data-approval-id="agent_approval_shell"]');
  await expect(request).toContainText('deploy_release');
  await request.getByRole('button', { name: 'Review request' }).click();
  await page.getByLabel('Decision reason').fill('Validated release evidence and exact tool boundary.');
  await page.getByLabel('Evidence hash').fill('ticket-42');
  await expect(page.getByText('Required format: sha256 followed by 64 lowercase hexadecimal characters.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve action' })).toBeDisabled();
  await page.getByLabel('Evidence hash').fill(`sha256:${'a'.repeat(64)}`);
  await page.getByRole('button', { name: 'Approve action' }).click();

  await expect(page.getByRole('status', { name: '' }).filter({ hasText: 'Decision pending backend confirmation' })).toBeVisible();
  await expect(request).toContainText('approved');
  expect(state.lastDecisionBody).toEqual({
    reason: 'Validated release evidence and exact tool boundary.',
    evidenceHash: `sha256:${'a'.repeat(64)}`,
  });
  expect(state.decisionAttempts).toHaveLength(2);
  expect(state.decisionAttempts[1].idempotencyKey).toBe(state.decisionAttempts[0].idempotencyKey);
  expect(state.decisionAttempts[1].body).toEqual(state.decisionAttempts[0].body);
});

test('shows workspace lease posture without exposing action content', async ({ page }) => {
  await mockCommandCenter(page);
  await openCommandCenter(page);

  const identityCard = page.locator('[data-identity-id="agent_identity_external"]');
  await expect(identityCard.getByText('1 active', { exact: true })).toBeVisible();
  const leaseRow = page.locator('[data-lease-id="agent_lease_active"]');
  await expect(leaseRow).toContainText('read_run_posture');
  await expect(leaseRow).toContainText('active');
  await expect(leaseRow).toContainText('staging');
  await expect(page.getByRole('region', { name: 'Authorization lease posture' }).getByRole('columnheader', { name: 'Expires' })).toBeVisible();
});

test('shows warming honestly and retries the initial read until ready', async ({ page }) => {
  const state = await mockCommandCenter(page, { identityFailures: 2 });
  await page.goto('/release/agents');

  const connectionStatus = page.locator('.agent-command__signal');
  await expect(connectionStatus).toContainText('warming');
  await expect(connectionStatus).toContainText('Control plane live', { timeout: 12_000 });
  await expect(page.locator('[data-identity-id="agent_identity_external"]')).toBeVisible();
  expect(state.identityAttempts).toBe(3);
});

test('fails immediately on authentication errors instead of claiming warming', async ({ page }) => {
  const state = await mockCommandCenter(page, { identityFailures: 99, identityFailureStatus: 401 });
  await page.goto('/release/agents');

  const connectionStatus = page.locator('.agent-command__signal');
  await expect(connectionStatus).toContainText('unavailable', { timeout: 3_000 });
  expect(state.identityAttempts).toBe(1);
  await expect(connectionStatus).not.toContainText('warming');
  const toast = page.locator('.toast-item').filter({ hasText: 'Authentication required' });
  await expect(toast).toBeVisible();
  expect((await toast.textContent()).length).toBeLessThan(250);
});

test('emergency stop is confirmed and remains usable at mobile width', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'));
  const state = await mockCommandCenter(page);
  await openCommandCenter(page);

  const identityCard = page.locator('[data-identity-id="agent_identity_external"]');
  await identityCard.getByRole('button', { name: 'Emergency stop' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm emergency stop' });
  await dialog.getByLabel('Emergency stop reason').fill('Suspected credential compromise during production trial.');
  await dialog.getByRole('button', { name: 'Stop agent now' }).click();

  await expect(identityCard).toContainText('disabled');
  expect(state.killBody).toEqual({ reason: 'Suspected credential compromise during production trial.' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
});
