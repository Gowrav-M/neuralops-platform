import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function fillPilotApplication(form) {
  await form.getByLabel('Name').fill('Asha Rao');
  await form.getByLabel('Work email').fill('asha@acme.ai');
  await form.getByLabel('Company').fill('Acme AI');
  await form.getByLabel('Role').fill('AI Platform Lead');
  await form.getByLabel('Team size').selectOption('6-20');
  await form.getByLabel('Expected managed agents').fill('12');
  await form.getByLabel('Primary use case').fill('Supervise production support agents before shell and external communication actions.');
  await form.getByLabel(/I agree to be contacted/i).check();
}

test('public landing explains the product honestly and opens sign in', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: /Stop unsafe agent actions before they happen/i })).toBeVisible();
  await expect(page.getByText(/Identity-bound authorization and human approval/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: /Metadata in\. Sensitive content out/i })).toBeVisible();
  await expect(page.getByText(/free-tier backend may need up to 90 seconds to wake/i)).toBeVisible();

  const pricing = page.getByRole('region', { name: 'Pricing' });
  await expect(pricing.getByText('$0', { exact: true })).toBeVisible();
  await expect(pricing.getByText('$149', { exact: true })).toBeVisible();
  await expect(pricing.getByText('$499', { exact: true })).toBeVisible();
  await expect(pricing.getByText('Custom', { exact: true })).toBeVisible();

  const signIn = page.getByRole('button', { name: 'Sign in' }).first();
  await signIn.click();
  await expect(page.getByRole('dialog', { name: 'Sign in to NeuralOps' })).toBeVisible();
  await expect(page.getByPlaceholder('operator@company.com')).toBeVisible();
  await page.getByRole('button', { name: 'Close sign in' }).click();
  await expect(signIn).toBeFocused();
});

test('pilot application submits metadata with a bounded idempotency key', async ({ page }) => {
  const captured = [];
  await page.route('**/api/public/pilot-applications', async (route) => {
    captured.push({
      headers: route.request().headers(),
      body: route.request().postDataJSON(),
    });
    if (captured.length === 1) {
      return route.fulfill({ status: 503, json: { detail: 'Backend warming' } });
    }
    await route.fulfill({
      status: 202,
      json: {
        applicationId: 'pilot_application_42',
        status: 'received',
        submittedAt: '2026-07-16T10:00:00Z',
      },
    });
  });

  await page.goto('/');
  await page.getByRole('link', { name: 'Request pilot access' }).click();
  const form = page.getByRole('form', { name: 'Invited pilot application' });
  await fillPilotApplication(form);
  await form.getByRole('button', { name: 'Submit pilot application' }).click();

  await expect(form.getByText(/Application received/i)).toBeVisible();
  expect(captured).toHaveLength(2);
  expect(captured[0].headers['idempotency-key']).toMatch(/^pilot_[a-z0-9-]{12,}$/);
  expect(captured[1].headers['idempotency-key']).toBe(captured[0].headers['idempotency-key']);
  expect(captured[0].body).toEqual(captured[1].body);
  expect(captured[0].body).toEqual({
    name: 'Asha Rao',
    workEmail: 'asha@acme.ai',
    company: 'Acme AI',
    role: 'AI Platform Lead',
    teamSize: '6-20',
    expectedAgents: 12,
    primaryUseCase: 'Supervise production support agents before shell and external communication actions.',
    consent: true,
    website: '',
  });
});

test('pilot application never reports success when every bounded retry fails', async ({ page }) => {
  test.setTimeout(12_000);
  const attempts = [];
  await page.route('**/api/public/pilot-applications', async (route) => {
    attempts.push({
      idempotencyKey: route.request().headers()['idempotency-key'],
      body: route.request().postData(),
    });
    await route.fulfill({ status: 503, json: { detail: 'Still warming' } });
  });

  await page.goto('/');
  await page.getByRole('link', { name: 'Request pilot access' }).click();
  const form = page.getByRole('form', { name: 'Invited pilot application' });
  await fillPilotApplication(form);
  await form.getByRole('button', { name: 'Submit pilot application' }).click();

  await expect(form.getByText(/Application was not submitted/i)).toBeVisible({ timeout: 7_000 });
  await expect(form.getByText(/Application received/i)).toHaveCount(0);
  expect(attempts.length).toBeGreaterThan(1);
  expect(new Set(attempts.map((item) => item.idempotencyKey)).size).toBe(1);
  expect(new Set(attempts.map((item) => item.body)).size).toBe(1);
});

test('landing remains operable without horizontal overflow at 390px', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Stop unsafe agent actions before they happen/i })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Request pilot access' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)).toBe(false);
});

test('landing honors reduced motion and passes the automated accessibility baseline', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: /Stop unsafe agent actions before they happen/i })).toBeVisible();
  const runningAnimations = await page.locator('.landing').evaluate((element) => (
    element.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length
  ));
  expect(runningAnimations).toBe(0);

  await page.getByRole('button', { name: 'Sign in' }).first().click();
  const dialogPanel = page.getByRole('dialog', { name: 'Sign in to NeuralOps' }).locator(':scope > div');
  await expect(dialogPanel).toBeVisible();
  expect(await dialogPanel.evaluate((element) => getComputedStyle(element).transform)).toBe('none');

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('interactive authorization canvas changes decision state', async ({ page }) => {
  await page.goto('/');
  const canvas = page.getByRole('img', { name: /Authorization path for deploy-bot/i });
  await expect(canvas).toHaveAttribute('aria-label', /Decision: pending/);
  await page.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(canvas).toHaveAttribute('aria-label', /Decision: blocked/);
  await page.getByRole('button', { name: 'Approve 60s' }).click();
  await expect(canvas).toHaveAttribute('aria-label', /Decision: approved/);
});

test('landing visual baseline remains stable', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Stop unsafe agent actions before they happen/i })).toBeVisible();
  await expect(page).toHaveScreenshot(`neuralops-landing-${testInfo.project.name}.png`, {
    fullPage: true,
    animations: 'disabled',
    // Chromium text rasterization and mobile font metrics differ between
    // Windows development and the Linux CI runner. Structural drift still
    // fails while allowing the known cross-platform raster variance.
    maxDiffPixelRatio: 0.08,
  });
});
