import { expect, test } from '@playwright/test';

const dashboard = {
  stats: {
    totalRequests: 0,
    avgLatency: '0.00s',
    p95Latency: '0.00s',
    errorRate: '0.0%',
    totalCost: '$0.000',
    evalPassRate: '0.0%',
    policyViolations: 0,
    activeIncidents: 0,
  },
  traces: [],
  incidents: [],
};

const system = {
  environment: 'test',
  storage: 'sqlite',
  authRequired: false,
  features: [],
};

async function mockBootstrap(page, { failures = 0, failureStatus = 503 } = {}) {
  const state = { attempts: 0 };
  await page.route('**/api/dashboard', async (route) => {
    state.attempts += 1;
    if (state.attempts <= failures) {
      return route.fulfill({ status: failureStatus, json: { detail: failureStatus === 401 ? 'Authentication required' : 'Backend waking' } });
    }
    return route.fulfill({ json: dashboard });
  });
  await page.route('**/api/system/status', (route) => route.fulfill({ json: system }));
  await page.route('**/api/onboarding/status', (route) => route.fulfill({ status: 404, json: { detail: 'Not configured' } }));
  return state;
}

test('global bootstrap reports warming then ready after retryable failure', async ({ page }) => {
  const state = await mockBootstrap(page, { failures: 1 });
  await page.goto('/');

  const status = page.locator('.api-status-pill').first();
  await expect(status).toHaveText('API WARMING');
  await expect(status).toHaveText('API LIVE', { timeout: 7_000 });
  expect(state.attempts).toBe(2);
});

test('global bootstrap becomes unavailable after its bounded warming window', async ({ page }) => {
  const state = await mockBootstrap(page, { failures: 99 });
  await page.goto('/');

  const status = page.locator('.api-status-pill').first();
  await expect(status).toHaveText('API WARMING');
  await expect(status).toHaveText('API UNAVAILABLE', { timeout: 8_000 });
  expect(state.attempts).toBeGreaterThan(1);
});

test('global bootstrap stops immediately on 401 without claiming warming', async ({ page }) => {
  const state = await mockBootstrap(page, { failures: 99, failureStatus: 401 });
  await page.goto('/');

  const status = page.locator('.api-status-pill').first();
  await expect(status).toHaveText('API UNAVAILABLE', { timeout: 3_000 });
  expect(state.attempts).toBe(1);
  await expect(status).not.toHaveText('API WARMING');
});
