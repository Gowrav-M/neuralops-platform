import { defineConfig, devices } from '@playwright/test';

const deployedFrontendUrl = globalThis.process?.env?.DEPLOYED_FRONTEND_URL;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /deployed\.spec\.js/,
  workers: 1,
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: deployedFrontendUrl || 'https://neuralops-platform.vercel.app',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'deployed-desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'deployed-mobile-chromium',
      use: { ...devices['Pixel 7'] },
    },
  ],
});
