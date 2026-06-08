import { defineConfig, devices } from '@playwright/test';
import process from 'node:process';

const e2eRunId = process.env.NEURALOPS_E2E_RUN_ID || String(Date.now());

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000',
      url: 'http://127.0.0.1:8000/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NEURALOPS_DB_PATH: `backend/data/neuralops-e2e-${e2eRunId}.sqlite3`,
        NEURALOPS_DATABASE_URL: '',
        SUPABASE_DB_URL: '',
        DATABASE_URL: '',
        NEURALOPS_AUTH_REQUIRED: 'false',
        GROQ_API_KEY: '',
        NVIDIA_API_KEY: '',
        OPENAI_API_KEY: '',
        NEURALOPS_API_KEY: '',
      },
    },
    {
      command: 'cmd /c npm run dev -- --host 127.0.0.1 --port 5173',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        VITE_API_BASE_URL: 'http://127.0.0.1:8000',
        VITE_REQUIRE_AUTH: 'false',
      },
    },
  ],
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
    },
  ],
});
