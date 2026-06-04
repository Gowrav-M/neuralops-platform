import { expect, test } from '@playwright/test';

const tabs = [
  'Dashboard',
  'Traces',
  'Prompts',
  'Evaluations',
  'RAG Quality',
  'Cost',
  'Policies',
  'Incidents',
  'Agents',
  'Labs',
  'Connect',
  'Autopilot',
  'Evidence',
  'Automations',
  'Settings',
];

test('all product tabs render without console errors and Evidence gate runs', async ({ page }) => {
  const errors = [];
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      errors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

  await page.goto('/');
  await expect(page.getByRole('button', { name: /NeuralOps/i })).toBeVisible();
  await expect(page.getByText(/API LIVE|API LOADING/i)).toBeVisible();
  await expect(page.getByLabel('NeuralOps operator workflow')).toBeVisible();
  await expect(page.getByText('Production Readiness Path')).toBeVisible();
  await expect(page.getByRole('button', { name: /Open Evidence Center/i })).toBeVisible();
  const sidebar = page.locator('.sidebar-container');

  await page.getByRole('button', { name: /Gate Release proof/i }).click();
  await expect(page.locator('.main-content-panel h2', { hasText: 'Evidence' })).toBeVisible();

  for (const tab of tabs) {
    await sidebar.getByRole('button', { name: tab, exact: true }).click();
    await expect(page.locator('.main-content-panel h2', { hasText: tab })).toBeVisible();
  }

  await sidebar.getByRole('button', { name: 'Evidence', exact: true }).click();
  await expect(page.getByText('Feature Truth Contract')).toBeVisible();
  await expect(page.locator('.dark-panel-title', { hasText: 'Saved Release Gates' })).toBeVisible();
  await page.getByRole('button', { name: /Run Current Config/i }).click();
  await expect(page.getByText(/Release gate completed|Deployment Blockers/i)).toBeVisible();

  await page.locator('input[value="Production AI Release Gate"]').fill('Playwright Release Gate');
  await page.getByRole('button', { name: 'Save Gate Definition' }).click();
  await expect(page.locator('strong', { hasText: 'Playwright Release Gate' }).first()).toBeVisible();
  const savedGateResponse = page.waitForResponse((response) => response.url().includes('/api/release-gates/') && response.url().endsWith('/run'));
  await page.getByRole('button', { name: 'Run Saved Gate' }).first().click();
  expect((await savedGateResponse).ok()).toBe(true);
  await expect(page.getByText(/Saved gate Playwright Release Gate/i)).toBeVisible();

  await sidebar.getByRole('button', { name: 'Autopilot', exact: true }).click();
  await expect(page.getByText('Release Autopilot')).toBeVisible();
  const autopilotResponse = page.waitForResponse((response) => response.url().includes('/api/release-autopilot/run'));
  await page.getByRole('button', { name: 'Run Autopilot' }).click();
  expect((await autopilotResponse).ok()).toBe(true);
  await expect(page.getByText('GitHub PR Comment Preview')).toBeVisible();

  await sidebar.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByPlaceholder('Webhook receiver name').fill(`Ops Webhook ${Date.now()}`);
  await page.getByPlaceholder('https://yourserver.com/webhook').fill('https://hooks.example.test/neuralops');
  const webhookResponse = page.waitForResponse((response) => response.url().includes('/api/settings/webhooks'));
  await page.getByRole('button', { name: 'Register Endpoint' }).click();
  expect((await webhookResponse).ok()).toBe(true);
  await expect(page.getByText(/Backend registered webhook/i)).toBeVisible();

  await sidebar.getByRole('button', { name: 'Automations', exact: true }).click();
  await expect(page.getByText('Automation Center')).toBeVisible();
  await page.locator('form.automation-form input').first().fill('Playwright Webhook Rule');
  await page.locator('form.automation-form select').nth(1).selectOption('webhook_record');
  await page.getByRole('button', { name: 'Save Automation Rule' }).click();
  await expect(page.getByText(/Automation rule saved/i)).toBeVisible();
  await page.locator('.automation-rule-row').first().getByRole('button', { name: 'Test' }).click();
  await expect(page.getByText(/Automation test recorded/i)).toBeVisible();
  await expect(page.locator('td', { hasText: /manual-test/i }).first()).toBeVisible();
  await expect(page.getByText('Connector Delivery Attempts')).toBeVisible();
  await expect(page.locator('td', { hasText: 'pending' }).first()).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflow).toBe(false);
  expect(errors).toEqual([]);
});

test('Connect page creates a key and stores a verification trace', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.locator('.sidebar-container');
  await sidebar.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect Your AI App' })).toBeVisible();

  await page.getByPlaceholder('service name').fill('playwright-service');
  await page.getByRole('button', { name: 'Create Ingest Key' }).click();
  await expect(page.getByPlaceholder(/Paste NEURALOPS_API_KEY/i)).toHaveValue(/nop_sk_/);

  const verifyResponse = page.waitForResponse((response) => response.url().includes('/api/connect/verify'));
  await page.getByRole('button', { name: /Verify Connection/i }).click();
  expect((await verifyResponse).ok()).toBe(true);
  await expect(page.getByText('verified', { exact: true })).toBeVisible();
  await expect(page.getByText(/trace: tr_conn_/i)).toBeVisible();

  await sidebar.getByRole('button', { name: 'Traces', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'neuralops-connect-javascript' }).first()).toBeVisible();
});

test('Settings workspace members persist through backend RBAC API', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.locator('.sidebar-container');
  await sidebar.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('Active Team Members & Role RBAC')).toBeVisible();

  const suffix = Date.now();
  const email = `trust-${suffix}@example.com`;

  await page.getByPlaceholder('e.g. Trust Engineering').fill('Trust Engineering');
  await page.getByPlaceholder('trust@example.com').fill(email);
  await page.locator('form.settings-member-form select').selectOption('Security');
  const createResponse = page.waitForResponse((response) => response.url().includes('/api/workspace/members') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Add Member' }).click();
  expect((await createResponse).ok()).toBe(true);

  const row = page.locator('tr', { hasText: email });
  await expect(row).toBeVisible();
  const patchResponse = page.waitForResponse((response) => response.url().includes('/api/workspace/members/') && response.request().method() === 'PATCH');
  await row.getByLabel(`Role for ${email}`).selectOption('Viewer');
  expect((await patchResponse).ok()).toBe(true);
  await expect(row.getByText('Read Only')).toBeVisible();

  const deleteResponse = page.waitForResponse((response) => response.url().includes('/api/workspace/members/') && response.request().method() === 'DELETE');
  await row.getByRole('button', { name: 'Remove' }).click();
  expect((await deleteResponse).ok()).toBe(true);
  await expect(page.getByText(email)).toHaveCount(0);
});

test('Settings provider gateway connection persists and reports missing key truthfully', async ({ page }) => {
  await page.goto('/');
  const sidebar = page.locator('.sidebar-container');
  await sidebar.getByRole('button', { name: 'Settings', exact: true }).click();

  const card = page.locator('.card-container', { hasText: 'AI Provider Gateway Connections' });
  await expect(card).toBeVisible();
  const label = `Playwright Gateway ${Date.now()}`;

  await card.locator('select').first().selectOption('custom');
  await card.getByPlaceholder('e.g. Production OpenRouter').fill(label);
  await card.getByPlaceholder('https://provider.example.com/v1').fill('https://gateway.example.com/v1');
  await card.getByPlaceholder('provider/model-name').fill('playwright-model');

  const createResponse = page.waitForResponse((response) => response.url().includes('/api/providers/connections') && response.request().method() === 'POST');
  await card.getByRole('button', { name: 'Save Provider' }).click();
  expect((await createResponse).ok()).toBe(true);

  const row = card.locator('tr', { hasText: label });
  await expect(row).toBeVisible();
  await expect(row.getByText('untested')).toBeVisible();

  const testResponse = page.waitForResponse((response) => response.url().includes('/api/providers/connections/') && response.url().endsWith('/test'));
  await row.getByRole('button', { name: 'Test' }).click();
  expect((await testResponse).ok()).toBe(true);
  await expect(row.getByText('not_configured')).toBeVisible();
  await expect(page.getByText(/Provider test failed/i)).toBeVisible();
});

test('dark mode remains readable and uptime clock is contained', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('neuralops-theme', 'dark');
  });
  await page.goto('/');
  await expect(page.locator('[data-theme="dark"], html[data-theme="dark"]')).toHaveCount(1);

  const gaugeBox = await page.locator('.circular-gauge-container').boundingBox();
  const textBox = await page.locator('.gauge-text-overlay').boundingBox();
  expect(gaugeBox).not.toBeNull();
  expect(textBox).not.toBeNull();
  expect(textBox.x).toBeGreaterThanOrEqual(gaugeBox.x);
  expect(textBox.x + textBox.width).toBeLessThanOrEqual(gaugeBox.x + gaugeBox.width + 1);
});
