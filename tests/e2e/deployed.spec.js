import { expect, test } from '@playwright/test';

const loginEmail = globalThis.process?.env?.DEPLOYED_LOGIN_EMAIL;
const loginPassword = globalThis.process?.env?.DEPLOYED_LOGIN_PASSWORD;
const qaToken = globalThis.process?.env?.DEPLOYED_QA_TOKEN;

test.skip(
  !(loginEmail && loginPassword) && !qaToken,
  'DEPLOYED_LOGIN_EMAIL/DEPLOYED_LOGIN_PASSWORD or DEPLOYED_QA_TOKEN is required for deployed production E2E.'
);

async function authenticate(page) {
  await expect(page.getByText('AUTH REQUIRED')).toBeVisible();
  if (loginEmail && loginPassword) {
    await page.getByPlaceholder('operator@company.com').fill(loginEmail);
    await page.getByPlaceholder('Password').fill(loginPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    return;
  }
  await page.getByPlaceholder('Deployment QA token').fill(qaToken);
  await page.getByRole('button', { name: 'Continue with QA token' }).click();
}

test('deployed production app authenticates and core enterprise workflows run', async ({ page }) => {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

  await page.goto('/');
  await authenticate(page);

  await expect(page.getByRole('button', { name: /NeuralOps/i })).toBeVisible();
  await expect(page.getByText(/API LIVE|API LOADING/i)).toBeVisible();
  const sidebar = page.locator('.sidebar-container');

  for (const tab of ['Dashboard', 'Traces', 'Connect', 'Evidence', 'Automations', 'Settings']) {
    await sidebar.getByRole('button', { name: tab, exact: true }).click();
    await expect(page.locator('.main-content-panel h2', { hasText: tab })).toBeVisible();
  }

  await sidebar.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByPlaceholder('service name').fill(`deployed-prod-${Date.now()}`);
  await page.getByRole('button', { name: 'Create Ingest Key' }).click();
  await expect(page.getByPlaceholder(/Paste NEURALOPS_API_KEY/i)).toHaveValue(/nop_sk_/);
  const verifyResponse = page.waitForResponse((response) => response.url().includes('/api/connect/verify'));
  await page.getByRole('button', { name: /Verify Connection/i }).click();
  expect((await verifyResponse).ok()).toBe(true);
  await expect(page.getByText('verified', { exact: true })).toBeVisible();

  await sidebar.getByRole('button', { name: 'Evidence', exact: true }).click();
  const gateResponse = page.waitForResponse((response) => response.url().includes('/api/release-gate/run'));
  await page.getByRole('button', { name: /Run Current Config/i }).click();
  expect((await gateResponse).ok()).toBe(true);
  await expect(page.getByText(/Release gate completed|Deployment Blockers/i).first()).toBeVisible();

  await sidebar.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByPlaceholder('Webhook receiver name').fill(`Deployed Prod Webhook ${Date.now()}`);
  await page.getByPlaceholder('https://yourserver.com/webhook').fill('https://hooks.example.test/neuralops');
  const webhookResponse = page.waitForResponse((response) => response.url().includes('/api/settings/webhooks'));
  await page.getByRole('button', { name: 'Register Endpoint' }).click();
  expect((await webhookResponse).ok()).toBe(true);

  await sidebar.getByRole('button', { name: 'Automations', exact: true }).click();
  const ruleName = `Deployed Prod Webhook Rule ${Date.now()}`;
  await page.locator('form.automation-form input').first().fill(ruleName);
  await page.locator('form.automation-form select').nth(1).selectOption('audit_only');
  const createAutomationResponse = page.waitForResponse((response) => response.url().includes('/api/automations') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save Automation Rule' }).click();
  expect((await createAutomationResponse).ok()).toBe(true);
  await expect(page.getByText(/Automation rule saved/i)).toBeVisible();
  const ruleRow = page.locator('.automation-rule-row', { hasText: ruleName }).first();
  await expect(ruleRow).toBeVisible();
  const testAutomationResponse = page.waitForResponse((response) => response.url().includes('/run-test') && response.request().method() === 'POST');
  await ruleRow.getByRole('button', { name: 'Test' }).click();
  const testAutomationResult = await testAutomationResponse;
  expect(testAutomationResult.ok()).toBe(true);
  expect((await testAutomationResult.json()).ruleName).toBe(ruleName);
  const dryRunResponse = page.waitForResponse((response) => response.url().includes('/api/connector-deliveries/process'));
  await page.getByRole('button', { name: 'Dry Run Worker' }).click();
  expect((await dryRunResponse).ok()).toBe(true);
  await expect(page.getByText(/Dry run found/i)).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(overflow).toBe(false);
  expect(errors).toEqual([]);

  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page.getByText('AUTH REQUIRED')).toBeVisible();
});
